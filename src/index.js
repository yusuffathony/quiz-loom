/**
 * Cloudflare Worker Entry Point for QuizLoom
 * Routes HTTP, Auth, Custom Quizzes, WebSocket upgrades to Durable Objects, and queries D1.
 */

import { QuizRoom } from './room.js';
import { PRESET_QUIZZES } from '../presets.js';
import {
  hashPassword,
  verifyPassword,
  generateSalt,
  generateToken,
  extractBearerToken,
  generateRandomHex
} from './auth.js';

export { QuizRoom };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

async function getAuthenticatedUser(request, db) {
  if (!db) return null;
  const token = extractBearerToken(request);
  if (!token) return null;

  try {
    const session = await db.prepare(
      'SELECT user_id, expires_at FROM user_sessions WHERE token = ?'
    ).bind(token).first();

    if (!session) return null;
    if (new Date(session.expires_at) < new Date()) {
      return null;
    }

    const user = await db.prepare(
      'SELECT id, username, created_at FROM users WHERE id = ?'
    ).bind(session.user_id).first();

    return user ? { id: user.id, username: user.username, token } : null;
  } catch (err) {
    console.error('getAuthenticatedUser error:', err);
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    if (env) {
      env.DB = env.DB || env.quiz_loom_db;
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 1. WebSocket Upgrade Route -> Forward to QuizRoom Durable Object
    if (path === '/ws' || path.startsWith('/ws/')) {
      const code = (url.searchParams.get('code') || 'DEFAULT').toUpperCase().trim();
      if (!env.QUIZ_ROOM) {
        return new Response('Durable Object binding QUIZ_ROOM is not configured', { status: 500 });
      }

      // Single-point-of-coordination: Every participant with the same room code routes to the same Durable Object instance!
      const id = env.QUIZ_ROOM.idFromName(code);
      const roomStub = env.QUIZ_ROOM.get(id);
      return roomStub.fetch(request);
    }

    // 2. REST API: Presets
    if (path === '/api/presets') {
      return jsonResponse({ ok: true, presets: PRESET_QUIZZES });
    }

    // 3. REST API: Auth - Register
    if (path === '/api/auth/register' && request.method === 'POST') {
      if (!env.DB) {
        return jsonResponse({ ok: false, error: 'Database DB is not configured' }, 500);
      }
      try {
        const body = await request.json();
        const username = (body.username || '').trim();
        const password = body.password || '';

        if (!username || username.length < 3) {
          return jsonResponse({ ok: false, error: 'Username must be at least 3 characters' }, 400);
        }
        if (!password || password.length < 4) {
          return jsonResponse({ ok: false, error: 'Password must be at least 4 characters' }, 400);
        }

        const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
        if (existing) {
          return jsonResponse({ ok: false, error: 'Username is already taken' }, 400);
        }

        const userId = 'u_' + generateRandomHex(12);
        const salt = generateSalt();
        const passwordHash = await hashPassword(password, salt);

        await env.DB.prepare(
          'INSERT INTO users (id, username, password_hash, salt) VALUES (?, ?, ?, ?)'
        ).bind(userId, username, passwordHash, salt).run();

        const token = generateToken();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        await env.DB.prepare(
          'INSERT INTO user_sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
        ).bind(token, userId, expiresAt).run();

        return jsonResponse({
          ok: true,
          token,
          user: { id: userId, username }
        }, 201);
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 4. REST API: Auth - Login
    if (path === '/api/auth/login' && request.method === 'POST') {
      if (!env.DB) {
        return jsonResponse({ ok: false, error: 'Database DB is not configured' }, 500);
      }
      try {
        const body = await request.json();
        const username = (body.username || '').trim();
        const password = body.password || '';

        if (!username || !password) {
          return jsonResponse({ ok: false, error: 'Username and password are required' }, 400);
        }

        const user = await env.DB.prepare(
          'SELECT id, username, password_hash, salt FROM users WHERE username = ?'
        ).bind(username).first();

        if (!user) {
          return jsonResponse({ ok: false, error: 'Invalid username or password' }, 401);
        }

        const valid = await verifyPassword(password, user.salt, user.password_hash);
        if (!valid) {
          return jsonResponse({ ok: false, error: 'Invalid username or password' }, 401);
        }

        const token = generateToken();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        await env.DB.prepare(
          'INSERT INTO user_sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
        ).bind(token, user.id, expiresAt).run();

        return jsonResponse({
          ok: true,
          token,
          user: { id: user.id, username: user.username }
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 5. REST API: Auth - Me
    if (path === '/api/auth/me' && request.method === 'GET') {
      const user = await getAuthenticatedUser(request, env.DB);
      if (!user) {
        return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
      }
      return jsonResponse({ ok: true, user: { id: user.id, username: user.username } });
    }

    // 6. REST API: Auth - Logout
    if (path === '/api/auth/logout' && request.method === 'POST') {
      if (env.DB) {
        const token = extractBearerToken(request);
        if (token) {
          await env.DB.prepare('DELETE FROM user_sessions WHERE token = ?').bind(token).run();
        }
      }
      return jsonResponse({ ok: true });
    }

    // 7. REST API: Quizzes - List
    if (path === '/api/quizzes' && request.method === 'GET') {
      if (!env.DB) {
        return jsonResponse({ ok: true, quizzes: [] });
      }
      try {
        const user = await getAuthenticatedUser(request, env.DB);
        let query;
        let params = [];

        if (user) {
          query = `
            SELECT q.id, q.title, q.description, q.user_id, q.created_at,
                   COUNT(ques.id) AS question_count
            FROM quizzes q
            LEFT JOIN questions ques ON q.id = ques.quiz_id
            WHERE q.user_id = ?
            GROUP BY q.id
            ORDER BY q.created_at DESC
          `;
          params = [user.id];
        } else {
          query = `
            SELECT q.id, q.title, q.description, q.user_id, q.created_at,
                   COUNT(ques.id) AS question_count
            FROM quizzes q
            LEFT JOIN questions ques ON q.id = ques.quiz_id
            GROUP BY q.id
            ORDER BY q.created_at DESC
            LIMIT 50
          `;
        }

        const stmt = env.DB.prepare(query);
        const { results } = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();
        return jsonResponse({ ok: true, quizzes: results || [] });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 8. REST API: Single Quiz - Details & Questions (/api/quizzes/:id)
    const quizMatch = path.match(/^\/api\/quizzes\/([^/]+)$/);
    if (quizMatch) {
      const quizId = quizMatch[1];

      if (request.method === 'GET') {
        if (!env.DB) {
          return jsonResponse({ ok: false, error: 'Database DB is not configured' }, 500);
        }
        try {
          const quiz = await env.DB.prepare(
            'SELECT * FROM quizzes WHERE id = ?'
          ).bind(quizId).first();

          if (!quiz) {
            return jsonResponse({ ok: false, error: 'Quiz not found' }, 404);
          }

          const { results: rawQuestions } = await env.DB.prepare(
            'SELECT * FROM questions WHERE quiz_id = ? ORDER BY question_index ASC'
          ).bind(quizId).all();

          const questions = (rawQuestions || []).map((q, idx) => {
            let options = [];
            try {
              options = typeof q.options === 'string' ? JSON.parse(q.options) : (q.options || []);
            } catch (e) {
              options = [];
            }
            return {
              id: q.id || (idx + 1),
              text: q.text,
              type: q.type || 'quiz',
              options,
              correctAnswer: q.correct_answer,
              time: q.time_limit || 20,
              explanation: q.explanation || ''
            };
          });

          return jsonResponse({
            ok: true,
            quiz: {
              id: quiz.id,
              title: quiz.title,
              description: quiz.description,
              user_id: quiz.user_id,
              created_at: quiz.created_at,
              questions
            }
          });
        } catch (err) {
          return jsonResponse({ ok: false, error: err.message }, 500);
        }
      }

      if (request.method === 'PUT') {
        if (!env.DB) {
          return jsonResponse({ ok: false, error: 'Database DB is not configured' }, 500);
        }
        try {
          const user = await getAuthenticatedUser(request, env.DB);
          if (!user) {
            return jsonResponse({ ok: false, error: 'Unauthorized. Please log in.' }, 401);
          }

          const existing = await env.DB.prepare('SELECT user_id FROM quizzes WHERE id = ?').bind(quizId).first();
          if (!existing) {
            return jsonResponse({ ok: false, error: 'Quiz not found' }, 404);
          }
          if (existing.user_id && existing.user_id !== user.id) {
            return jsonResponse({ ok: false, error: 'Forbidden. You do not own this quiz.' }, 403);
          }

          const body = await request.json();
          const title = (body.title || 'Untitled Quiz').trim();
          const description = (body.description || '').trim();
          const questions = Array.isArray(body.questions) ? body.questions : [];

          await env.DB.prepare(
            'UPDATE quizzes SET title = ?, description = ? WHERE id = ?'
          ).bind(title, description, quizId).run();

          await env.DB.prepare('DELETE FROM questions WHERE quiz_id = ?').bind(quizId).run();

          const insertQStmt = env.DB.prepare(
            `INSERT INTO questions (quiz_id, question_index, text, type, options, correct_answer, time_limit, explanation)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          );

          const batchOps = questions.map((q, idx) =>
            insertQStmt.bind(
              quizId,
              idx,
              q.text || `Question ${idx + 1}`,
              q.type || 'quiz',
              JSON.stringify(q.options || []),
              String(q.correctAnswer || ''),
              q.time || 20,
              q.explanation || ''
            )
          );

          if (batchOps.length > 0) {
            await env.DB.batch(batchOps);
          }

          return jsonResponse({ ok: true, quizId, count: questions.length });
        } catch (err) {
          return jsonResponse({ ok: false, error: err.message }, 500);
        }
      }

      if (request.method === 'DELETE') {
        if (!env.DB) {
          return jsonResponse({ ok: false, error: 'Database DB is not configured' }, 500);
        }
        try {
          const user = await getAuthenticatedUser(request, env.DB);
          if (!user) {
            return jsonResponse({ ok: false, error: 'Unauthorized. Please log in.' }, 401);
          }

          const existing = await env.DB.prepare('SELECT user_id FROM quizzes WHERE id = ?').bind(quizId).first();
          if (!existing) {
            return jsonResponse({ ok: false, error: 'Quiz not found' }, 404);
          }
          if (existing.user_id && existing.user_id !== user.id) {
            return jsonResponse({ ok: false, error: 'Forbidden. You do not own this quiz.' }, 403);
          }

          await env.DB.prepare('DELETE FROM questions WHERE quiz_id = ?').bind(quizId).run();
          await env.DB.prepare('DELETE FROM quizzes WHERE id = ?').bind(quizId).run();

          return jsonResponse({ ok: true, message: 'Quiz deleted successfully' });
        } catch (err) {
          return jsonResponse({ ok: false, error: err.message }, 500);
        }
      }
    }

    // 9. REST API: Save New Quiz (POST /api/quizzes)
    if (path === '/api/quizzes' && request.method === 'POST') {
      if (!env.DB) {
        return jsonResponse({ ok: false, error: 'D1 Database binding DB not configured' }, 500);
      }
      try {
        const body = await request.json();
        const user = await getAuthenticatedUser(request, env.DB);
        const userId = user ? user.id : (body.user_id || null);

        const quizId = body.id || `quiz_${Date.now()}_${generateRandomHex(4)}`;
        const title = (body.title || 'Untitled Quiz').trim();
        const description = (body.description || '').trim();
        const questions = Array.isArray(body.questions) ? body.questions : [];

        await env.DB.prepare(
          'INSERT INTO quizzes (id, user_id, title, description) VALUES (?, ?, ?, ?)'
        ).bind(quizId, userId, title, description).run();

        const insertQStmt = env.DB.prepare(
          `INSERT INTO questions (quiz_id, question_index, text, type, options, correct_answer, time_limit, explanation)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );

        const batchOps = questions.map((q, idx) =>
          insertQStmt.bind(
            quizId,
            idx,
            q.text || `Question ${idx + 1}`,
            q.type || 'quiz',
            JSON.stringify(q.options || []),
            String(q.correctAnswer || ''),
            q.time || 20,
            q.explanation || ''
          )
        );

        if (batchOps.length > 0) {
          await env.DB.batch(batchOps);
        }

        return jsonResponse({ ok: true, quizId, title, count: questions.length }, 201);
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 10. REST API: D1 Game History
    if (path === '/api/history') {
      if (!env.DB) {
        return jsonResponse({ ok: true, history: [] });
      }
      try {
        const { results } = await env.DB.prepare(
          'SELECT * FROM game_sessions ORDER BY created_at DESC LIMIT 20'
        ).all();
        return jsonResponse({ ok: true, history: results || [] });
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // 11. REST API: Health Check
    if (path === '/health') {
      return jsonResponse({
        status: 'ok',
        platform: 'cloudflare-workers',
        durableObjects: Boolean(env.QUIZ_ROOM),
        d1Database: Boolean(env.DB),
        timestamp: new Date().toISOString()
      });
    }

    // 12. Static Assets Serving via Cloudflare Assets binding
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
