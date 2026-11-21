/**
 * Mock Cloudflare D1 Database for Unit & Integration Tests
 */

class MockStatement {
  constructor(db, query, params = []) {
    this._db = db;
    this._query = query;
    this._params = params;
  }

  bind(...params) {
    return new MockStatement(this._db, this._query, params);
  }

  async first() {
    return this._db._executeFirst(this._query, this._params);
  }

  async all() {
    return this._db._executeAll(this._query, this._params);
  }

  async run() {
    return this._db._executeRun(this._query, this._params);
  }
}

class MockD1 {
  constructor() {
    this.users = new Map(); // id -> { id, username, password_hash, salt, created_at }
    this.userSessions = new Map(); // token -> { token, user_id, expires_at, created_at }
    this.quizzes = new Map(); // id -> { id, user_id, title, description, created_at }
    this.questions = []; // [{ id, quiz_id, question_index, text, type, options, correct_answer, time_limit, explanation }]
    this.sessions = [];
    this.results = [];
    this.nextQuestionId = 1;
  }

  prepare(query) {
    return new MockStatement(this, query);
  }

  _executeFirst(query, params) {
    const q = query.trim();

    // 1. SELECT id FROM users WHERE username = ?
    if (q.includes('FROM users WHERE username = ?')) {
      const username = params[0];
      for (const u of this.users.values()) {
        if (u.username.toLowerCase() === String(username).toLowerCase()) {
          return { id: u.id, username: u.username, password_hash: u.password_hash, salt: u.salt };
        }
      }
      return null;
    }

    // 2. SELECT user_id, expires_at FROM user_sessions WHERE token = ?
    if (q.includes('FROM user_sessions WHERE token = ?')) {
      const token = params[0];
      const session = this.userSessions.get(token);
      return session ? { user_id: session.user_id, expires_at: session.expires_at } : null;
    }

    // 3. SELECT id, username, created_at FROM users WHERE id = ?
    if (q.includes('FROM users WHERE id = ?')) {
      const id = params[0];
      const u = this.users.get(id);
      return u ? { id: u.id, username: u.username, created_at: u.created_at } : null;
    }

    // 4. SELECT * FROM quizzes WHERE id = ? or SELECT user_id FROM quizzes WHERE id = ?
    if (q.includes('FROM quizzes WHERE id = ?')) {
      const id = params[0];
      return this.quizzes.get(id) || null;
    }

    return null;
  }

  _executeAll(query, params) {
    const q = query.trim();

    // 1. SELECT ... FROM quizzes ... WHERE q.user_id = ?
    if (q.includes('FROM quizzes') && q.includes('user_id = ?')) {
      const userId = params[0];
      const userQuizzes = Array.from(this.quizzes.values())
        .filter(qz => qz.user_id === userId)
        .map(qz => {
          const qCount = this.questions.filter(ques => ques.quiz_id === qz.id).length;
          return { ...qz, question_count: qCount };
        });
      return { results: userQuizzes };
    }

    // 2. SELECT ... FROM quizzes (all)
    if (q.includes('FROM quizzes')) {
      const allQuizzes = Array.from(this.quizzes.values()).map(qz => {
        const qCount = this.questions.filter(ques => ques.quiz_id === qz.id).length;
        return { ...qz, question_count: qCount };
      });
      return { results: allQuizzes };
    }

    // 3. SELECT * FROM questions WHERE quiz_id = ?
    if (q.includes('FROM questions WHERE quiz_id = ?')) {
      const quizId = params[0];
      const list = this.questions
        .filter(ques => ques.quiz_id === quizId)
        .sort((a, b) => a.question_index - b.question_index);
      return { results: list };
    }

    // 4. SELECT * FROM game_sessions
    if (q.includes('FROM game_sessions')) {
      return { results: this.sessions };
    }

    return { results: [] };
  }

  _executeRun(query, params) {
    const q = query.trim();

    // INSERT INTO users
    if (q.includes('INSERT INTO users')) {
      const [id, username, password_hash, salt] = params;
      this.users.set(id, { id, username, password_hash, salt, created_at: new Date().toISOString() });
      return { success: true };
    }

    // INSERT INTO user_sessions
    if (q.includes('INSERT INTO user_sessions')) {
      const [token, user_id, expires_at] = params;
      this.userSessions.set(token, { token, user_id, expires_at, created_at: new Date().toISOString() });
      return { success: true };
    }

    // DELETE FROM user_sessions
    if (q.includes('DELETE FROM user_sessions WHERE token = ?')) {
      const token = params[0];
      this.userSessions.delete(token);
      return { success: true };
    }

    // INSERT INTO quizzes
    if (q.includes('INSERT INTO quizzes')) {
      const id = params[0];
      // Check if 4 params (id, user_id, title, description) or 3 params (id, title, description)
      let userId = null;
      let title = '';
      let description = '';
      if (params.length >= 4) {
        userId = params[1];
        title = params[2];
        description = params[3];
      } else {
        title = params[1];
        description = params[2];
      }
      this.quizzes.set(id, { id, user_id: userId, title, description, created_at: new Date().toISOString() });
      return { success: true };
    }

    // UPDATE quizzes
    if (q.includes('UPDATE quizzes SET')) {
      const [title, description, id] = params;
      const qz = this.quizzes.get(id);
      if (qz) {
        qz.title = title;
        qz.description = description;
        this.quizzes.set(id, qz);
      }
      return { success: true };
    }

    // DELETE FROM questions WHERE quiz_id = ?
    if (q.includes('DELETE FROM questions WHERE quiz_id = ?')) {
      const quizId = params[0];
      this.questions = this.questions.filter(ques => ques.quiz_id !== quizId);
      return { success: true };
    }

    // DELETE FROM quizzes WHERE id = ?
    if (q.includes('DELETE FROM quizzes WHERE id = ?')) {
      const quizId = params[0];
      this.quizzes.delete(quizId);
      return { success: true };
    }

    // INSERT INTO game_sessions
    if (q.includes('INSERT INTO game_sessions')) {
      this.sessions.push(params);
      return { success: true };
    }

    return { success: true };
  }

  async batch(statements) {
    for (const stmt of statements) {
      const q = (stmt._query || '').trim();
      const params = stmt._params || [];

      if (q.includes('INSERT INTO questions')) {
        const [quiz_id, question_index, text, type, options, correct_answer, time_limit, explanation] = params;
        this.questions.push({
          id: this.nextQuestionId++,
          quiz_id,
          question_index,
          text,
          type,
          options,
          correct_answer,
          time_limit,
          explanation
        });
      } else if (q.includes('INSERT INTO game_results')) {
        this.results.push(params);
      } else if (typeof stmt.run === 'function') {
        await stmt.run();
      }
    }
    return { success: true };
  }
}

module.exports = { MockD1, MockStatement };
