const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./roomManager');
const { PRESET_QUIZZES } = require('./presets');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1024 * 1024 * 10 // 10MB
});

const {
  hashPassword,
  verifyPassword,
  generateSalt,
  generateToken,
  extractBearerToken,
  generateRandomHex
} = require('./src/auth.js');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const roomManager = new RoomManager();

// In-memory storage for Node runtime
const users = new Map(); // id -> { id, username, passwordHash, salt, createdAt }
const userSessions = new Map(); // token -> { token, userId, expiresAt }
const quizzes = new Map(); // id -> { id, userId, title, description, createdAt, questions }

function getAuthenticatedUser(req) {
  const token = extractBearerToken(req);
  if (!token) return null;
  const session = userSessions.get(token);
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    userSessions.delete(token);
    return null;
  }
  const user = users.get(session.userId);
  return user ? { id: user.id, username: user.username, token } : null;
}

// API routes
app.get('/api/presets', (req, res) => {
  res.json({ ok: true, presets: PRESET_QUIZZES });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    rooms: roomManager.rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Auth Routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';

    if (!username || username.length < 3) {
      return res.status(400).json({ ok: false, error: 'Username must be at least 3 characters' });
    }
    if (!password || password.length < 4) {
      return res.status(400).json({ ok: false, error: 'Password must be at least 4 characters' });
    }

    // Check duplicate
    for (const u of users.values()) {
      if (u.username.toLowerCase() === username.toLowerCase()) {
        return res.status(400).json({ ok: false, error: 'Username is already taken' });
      }
    }

    const userId = 'u_' + generateRandomHex(12);
    const salt = generateSalt();
    const passwordHash = await hashPassword(password, salt);

    const user = {
      id: userId,
      username,
      passwordHash,
      salt,
      createdAt: new Date().toISOString()
    };
    users.set(userId, user);

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    userSessions.set(token, { token, userId, expiresAt });

    res.status(201).json({
      ok: true,
      token,
      user: { id: userId, username }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Username and password are required' });
    }

    let foundUser = null;
    for (const u of users.values()) {
      if (u.username.toLowerCase() === username.toLowerCase()) {
        foundUser = u;
        break;
      }
    }

    if (!foundUser) {
      return res.status(401).json({ ok: false, error: 'Invalid username or password' });
    }

    const valid = await verifyPassword(password, foundUser.salt, foundUser.passwordHash);
    if (!valid) {
      return res.status(401).json({ ok: false, error: 'Invalid username or password' });
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    userSessions.set(token, { token, userId: foundUser.id, expiresAt });

    res.json({
      ok: true,
      token,
      user: { id: foundUser.id, username: foundUser.username }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  res.json({ ok: true, user: { id: user.id, username: user.username } });
});

app.post('/api/auth/logout', (req, res) => {
  const token = extractBearerToken(req);
  if (token) {
    userSessions.delete(token);
  }
  res.json({ ok: true });
});

// Quizzes CRUD
app.get('/api/quizzes', (req, res) => {
  const user = getAuthenticatedUser(req);
  const list = [];

  for (const q of quizzes.values()) {
    if (user) {
      if (q.userId === user.id) {
        list.push({
          id: q.id,
          title: q.title,
          description: q.description,
          userId: q.userId,
          created_at: q.createdAt,
          question_count: (q.questions || []).length
        });
      }
    } else {
      list.push({
        id: q.id,
        title: q.title,
        description: q.description,
        userId: q.userId,
        created_at: q.createdAt,
        question_count: (q.questions || []).length
      });
    }
  }

  res.json({ ok: true, quizzes: list.reverse() });
});

app.get('/api/quizzes/:id', (req, res) => {
  const quiz = quizzes.get(req.params.id);
  if (!quiz) {
    return res.status(404).json({ ok: false, error: 'Quiz not found' });
  }
  res.json({
    ok: true,
    quiz: {
      id: quiz.id,
      title: quiz.title,
      description: quiz.description,
      userId: quiz.userId,
      created_at: quiz.createdAt,
      questions: quiz.questions || []
    }
  });
});

app.post('/api/quizzes', (req, res) => {
  try {
    const user = getAuthenticatedUser(req);
    const userId = user ? user.id : (req.body.userId || null);
    const quizId = req.body.id || `quiz_${Date.now()}_${generateRandomHex(4)}`;
    const title = (req.body.title || 'Untitled Quiz').trim();
    const description = (req.body.description || '').trim();
    const questions = Array.isArray(req.body.questions) ? req.body.questions : [];

    const newQuiz = {
      id: quizId,
      userId,
      title,
      description,
      createdAt: new Date().toISOString(),
      questions: questions.map((q, idx) => ({
        id: q.id !== undefined ? q.id : idx + 1,
        text: q.text || `Question ${idx + 1}`,
        type: q.type || 'quiz',
        options: q.options || [],
        correctAnswer: q.correctAnswer !== undefined ? q.correctAnswer : '',
        time: q.time || 20,
        explanation: q.explanation || ''
      }))
    };

    quizzes.set(quizId, newQuiz);
    res.status(201).json({ ok: true, quizId, title, count: newQuiz.questions.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/quizzes/:id', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Unauthorized. Please log in.' });
  }
  const quiz = quizzes.get(req.params.id);
  if (!quiz) {
    return res.status(404).json({ ok: false, error: 'Quiz not found' });
  }
  if (quiz.userId && quiz.userId !== user.id) {
    return res.status(403).json({ ok: false, error: 'Forbidden. You do not own this quiz.' });
  }

  const title = (req.body.title || quiz.title).trim();
  const description = req.body.description !== undefined ? req.body.description.trim() : quiz.description;
  const questions = Array.isArray(req.body.questions) ? req.body.questions : quiz.questions;

  quiz.title = title;
  quiz.description = description;
  quiz.questions = questions.map((q, idx) => ({
    id: q.id !== undefined ? q.id : idx + 1,
    text: q.text || `Question ${idx + 1}`,
    type: q.type || 'quiz',
    options: q.options || [],
    correctAnswer: q.correctAnswer !== undefined ? q.correctAnswer : '',
    time: q.time || 20,
    explanation: q.explanation || ''
  }));

  quizzes.set(req.params.id, quiz);
  res.json({ ok: true, quizId: req.params.id, count: quiz.questions.length });
});

app.delete('/api/quizzes/:id', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Unauthorized. Please log in.' });
  }
  const quiz = quizzes.get(req.params.id);
  if (!quiz) {
    return res.status(404).json({ ok: false, error: 'Quiz not found' });
  }
  if (quiz.userId && quiz.userId !== user.id) {
    return res.status(403).json({ ok: false, error: 'Forbidden. You do not own this quiz.' });
  }

  quizzes.delete(req.params.id);
  res.json({ ok: true, message: 'Quiz deleted successfully' });
});

// Broadcast question end & results
function handleEndQuestion(room) {
  if (!room || room.status !== 'question') return;

  if (room.timerHandle) {
    clearInterval(room.timerHandle);
    room.timerHandle = null;
  }

  const evalRes = roomManager.evaluateQuestion(room.code);
  if (!evalRes) return;

  // Send results to host
  io.to(room.hostId).emit('questionEnded', {
    correctAnswer: evalRes.question.correctAnswer,
    explanation: evalRes.question.explanation,
    distribution: evalRes.distribution,
    leaderboard: evalRes.leaderboard,
    isLastQuestion: evalRes.isLastQuestion,
    questionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length
  });

  // Send personalized results to each participant
  evalRes.participantResults.forEach((res, socketId) => {
    io.to(socketId).emit('questionEnded', {
      ...res,
      distribution: evalRes.distribution,
      leaderboard: evalRes.leaderboard,
      questionIndex: room.currentQuestionIndex,
      totalQuestions: room.questions.length
    });
  });
}

// Start question with server-authoritative timer
function handleStartQuestion(room, questionIndex) {
  const startRes = roomManager.startQuestion(room.code, room.hostId, questionIndex);
  if (!startRes.ok) return startRes;

  // Emit to host
  io.to(room.hostId).emit('questionStart', startRes.hostPayload);

  // Emit to all participants in the room
  room.participants.forEach((p, socketId) => {
    io.to(socketId).emit('questionStart', startRes.participantPayload);
  });

  let remaining = startRes.q.time || 20;

  // Authoritative server timer tick
  room.timerHandle = setInterval(() => {
    remaining--;
    io.to(room.code).emit('timerTick', { remaining, total: startRes.q.time || 20 });

    if (remaining <= 0) {
      clearInterval(room.timerHandle);
      room.timerHandle = null;
      handleEndQuestion(room);
    }
  }, 1000);
  if (room.timerHandle && typeof room.timerHandle.unref === 'function') {
    room.timerHandle.unref();
  }

  return { ok: true, questionIndex, totalQuestions: room.questions.length };
}

// Socket.IO event handlers
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Create room
  socket.on('createRoom', (data, callback) => {
    const hostName = typeof data === 'string' ? data : (data && data.hostName);
    const room = roomManager.createRoom(socket.id, hostName || 'Host');
    socket.join(room.code);

    const publicData = roomManager.getPublicRoomData(room, true);
    if (typeof callback === 'function') {
      callback({ ok: true, code: room.code, hostName: room.hostName, room: publicData });
    }
    socket.emit('roomCreated', publicData);
  });

  // Join room
  socket.on('joinRoom', (data, callback) => {
    if (!data || !data.code) {
      if (typeof callback === 'function') callback({ error: 'Room code is required' });
      return;
    }

    const joinRes = roomManager.joinRoom(data.code, socket.id, data.name);
    if (joinRes.error) {
      if (typeof callback === 'function') callback({ error: joinRes.error });
      return;
    }

    const room = joinRes.room;
    socket.join(room.code);

    const publicData = roomManager.getPublicRoomData(room, false);
    if (typeof callback === 'function') {
      callback({
        ok: true,
        participantId: socket.id,
        name: joinRes.participant.name,
        room: publicData
      });
    }

    // Notify joining client
    socket.emit('roomJoined', {
      participantId: socket.id,
      name: joinRes.participant.name,
      room: publicData
    });

    // Notify room of participant change
    io.to(room.code).emit('participantsChanged', {
      name: joinRes.participant.name,
      total: room.participants.size,
      participants: publicData.participants
    });
  });

  // Set questions (host)
  socket.on('setQuestions', (data, maybeQuestions, maybeCallback) => {
    let roomCode = typeof data === 'string' ? data : (data && data.code);
    let questions = Array.isArray(data) ? data : (Array.isArray(maybeQuestions) ? maybeQuestions : (data && data.questions));
    let callback = typeof maybeQuestions === 'function' ? maybeQuestions : maybeCallback;

    const setRes = roomManager.setQuestions(roomCode, socket.id, questions);
    if (setRes.error) {
      if (typeof callback === 'function') callback({ error: setRes.error });
      return;
    }

    const room = roomManager.getRoom(roomCode);
    io.to(room.code).emit('questionsLoaded', { count: setRes.count });
    if (typeof callback === 'function') callback({ ok: true, count: setRes.count });
  });

  // Start game (host)
  socket.on('startGame', (data, callback) => {
    const roomCode = typeof data === 'string' ? data : (data && data.code);
    const cb = typeof data === 'function' ? data : callback;
    const room = roomManager.getRoom(roomCode);

    if (!room) {
      if (typeof cb === 'function') cb({ error: 'Room not found' });
      return;
    }
    if (room.hostId !== socket.id) {
      if (typeof cb === 'function') cb({ error: 'Unauthorized: Only host can start game' });
      return;
    }
    if (room.questions.length === 0) {
      if (typeof cb === 'function') cb({ error: 'No questions have been loaded yet' });
      return;
    }

    // Reset scores & streaks before fresh start
    room.participants.forEach(p => {
      p.score = 0;
      p.streak = 0;
      p.highestStreak = 0;
      p.answers = [];
    });

    const startRes = handleStartQuestion(room, 0);
    if (typeof cb === 'function') {
      cb({ ok: Boolean(startRes.ok), error: startRes.error, questionIndex: 0, totalQuestions: room.questions.length });
    }
  });

  // Next question (host)
  socket.on('nextQuestion', (data, callback) => {
    const roomCode = typeof data === 'string' ? data : (data && data.code);
    const cb = typeof data === 'function' ? data : callback;
    const room = roomManager.getRoom(roomCode);

    if (!room || room.hostId !== socket.id) {
      if (typeof cb === 'function') cb({ error: 'Unauthorized' });
      return;
    }

    if (room.currentQuestionIndex < room.questions.length - 1) {
      const nextIdx = room.currentQuestionIndex + 1;
      const startRes = handleStartQuestion(room, nextIdx);
      if (typeof cb === 'function') {
        cb({ ok: Boolean(startRes.ok), error: startRes.error, questionIndex: nextIdx, totalQuestions: room.questions.length });
      }
    } else {
      // Last question completed -> show final game results
      const endRes = roomManager.endGame(roomCode, socket.id);
      io.to(room.code).emit('gameEnded', endRes);
      if (typeof cb === 'function') cb({ ok: true, finished: true });
    }
  });

  // Skip current question timer (host)
  socket.on('skipQuestion', (data, callback) => {
    const roomCode = typeof data === 'string' ? data : (data && data.code);
    const cb = typeof data === 'function' ? data : callback;
    const room = roomManager.getRoom(roomCode);

    if (!room || room.hostId !== socket.id) {
      if (typeof cb === 'function') cb({ error: 'Unauthorized' });
      return;
    }

    handleEndQuestion(room);
    if (typeof cb === 'function') cb({ ok: true });
  });

  // Participant submits answer
  socket.on('answerQuestion', (arg1, arg2, arg3) => {
    // Supports (code, answerData, callback) or ({ code, answer }, callback)
    let roomCode = typeof arg1 === 'string' ? arg1 : (arg1 && arg1.code);
    let answerData = typeof arg1 === 'object' && arg1.answer !== undefined ? arg1 : arg2;
    let callback = typeof arg2 === 'function' ? arg2 : (typeof arg3 === 'function' ? arg3 : null);

    const room = roomManager.getRoom(roomCode);
    if (!room) {
      if (callback) callback({ error: 'Room not found' });
      return;
    }

    const ansRes = roomManager.recordAnswer(roomCode, socket.id, answerData);
    if (ansRes.error) {
      if (callback) callback({ error: ansRes.error });
      return;
    }

    if (callback) callback({ ok: true });

    // Broadcast live answer progress to room/host
    io.to(room.code).emit('answerReceived', {
      totalAnswered: ansRes.totalAnswered,
      totalParticipants: ansRes.totalParticipants
    });

    // If all participants have answered, automatically reveal without waiting for timer
    if (ansRes.allAnswered) {
      const autoEndTimer = setTimeout(() => {
        if (room.status === 'question') {
          handleEndQuestion(room);
        }
      }, 600);
      if (autoEndTimer && typeof autoEndTimer.unref === 'function') {
        autoEndTimer.unref();
      }
    }
  });

  // Show final results (host)
  socket.on('showResults', (data, callback) => {
    const roomCode = typeof data === 'string' ? data : (data && data.code);
    const cb = typeof data === 'function' ? data : callback;
    const room = roomManager.getRoom(roomCode);

    if (!room || room.hostId !== socket.id) {
      if (typeof cb === 'function') cb({ error: 'Unauthorized' });
      return;
    }

    const endRes = roomManager.endGame(roomCode, socket.id);
    io.to(room.code).emit('gameEnded', endRes);
    if (typeof cb === 'function') cb(endRes);
  });

  // Reset room (host)
  socket.on('resetRoom', (data, callback) => {
    const roomCode = typeof data === 'string' ? data : (data && data.code);
    const cb = typeof data === 'function' ? data : callback;

    const resetRes = roomManager.resetRoom(roomCode, socket.id);
    if (resetRes.error) {
      if (typeof cb === 'function') cb({ error: resetRes.error });
      return;
    }

    io.to(roomCode).emit('roomReset', resetRes.room);
    if (typeof cb === 'function') cb({ ok: true, room: resetRes.room });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    const leaveRes = roomManager.leaveRoom(socket.id);
    if (leaveRes && leaveRes.room) {
      const room = leaveRes.room;
      if (leaveRes.wasHost) {
        io.to(room.code).emit('hostDisconnected', { message: 'Host has disconnected.' });
      } else {
        const publicData = roomManager.getPublicRoomData(room, false);
        io.to(room.code).emit('participantsChanged', {
          name: leaveRes.participant ? leaveRes.participant.name : 'A participant',
          total: room.participants.size,
          participants: publicData.participants
        });
      }
    }
  });
});

// Periodic cleanup of stale rooms (every 30 mins)
const cleanupInterval = setInterval(() => {
  roomManager.cleanupStaleRooms();
}, 1000 * 60 * 30);
cleanupInterval.unref();

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`-----------------------------------------------`);
    console.log(`🎯 QuizLoom Server running on port ${PORT}`);
    console.log(`🔗 Local URL: http://localhost:${PORT}`);
    console.log(`-----------------------------------------------`);
  });
}

module.exports = { app, server, io, roomManager };
