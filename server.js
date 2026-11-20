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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const roomManager = new RoomManager();

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
