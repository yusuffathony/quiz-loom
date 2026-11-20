const http = require('http');
const { Server } = require('socket.io');
const express = require('express');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1024 * 1024 * 50, // 50MB
});

app.use(express.static('public'));

// In-memory rooms storage
const rooms = new Map();

let roomIdCounter = 0;

// Generate unique 6-char room code
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Create room
function createRoom(hostName) {
  const code = generateCode();
  const room = {
    code: code,
    hostId: null,
    hostName: hostName,
    participants: new Map(), // socket.id -> { name, score, answers }
    questions: [],
    currentQuestion: null,
    status: 'waiting', // waiting, playing, ended
    scores: [], // leaderboard
    questionTimer: null,
    socketIo: io,
  };
  rooms.set(room.code, room);
  return room;
}

// Join room
function joinRoom(room, socketId, name) {
  if (!room) return null;
  if (room.status === 'ended') return null;
  if (room.participants.has(socketId)) return room;
  const participant = { name: name || 'Anonymous', score: 0, answers: [] };
  room.participants.set(socketId, participant);
  // If it's the first participant, they become host
  if (!room.hostId && room.participants.size === 1) {
    room.hostId = socketId;
    room.hostName = name || 'Host';
  }
  return room;
}

// Leave room
function leaveRoom(room, socketId) {
  if (room.participants.has(socketId)) {
    room.participants.delete(socketId);
  }
  if (room.hostId === socketId && room.participants.size > 0) {
    room.hostId = room.participants.keys().next().value;
    room.hostName = room.participants.get(room.hostId).name;
  } else if (room.participants.size === 0) {
    room.code = generateCode();
  }
}

// Calculate leaderboard
function getLeaderboard(room) {
  return Array.from(room.participants.values())
    .filter(p => p.score > 0)
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

// === Socket.IO Handlers ===
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Create room (host)
  socket.on('createRoom', (hostName, callback) => {
    const room = createRoom(hostName || 'Host');
    socket.join(room.code);
    room.hostId = socket.id;
    room.hostName = hostName || 'Host';
    callback({ code: room.code });
    // Notify all clients in room
    io.to(room.code).emit('roomCreated', { code: room.code, host: room.hostName });
    // Send room state to host
    socket.emit('roomState', room);
  });

  // Join room
  socket.on('joinRoom', (data, callback) => {
    const { code, name } = data;
    const room = rooms.get(code);
    if (!room) {
      callback({ error: 'Room not found' });
      return;
    }
    const result = joinRoom(room, socket.id, name);
    if (!result) {
      callback({ error: 'Failed to join' });
      return;
    }
    socket.join(code);
    socket.to(code).emit('userJoined', { name, total: room.participants.size });
    // Send room state to the joining client
    socket.emit('roomState', room);
    // Send updated participant list to host
    io.to(code).emit('participantsChanged', getParticipants(room));
    if (callback) callback({ ok: true });
  });

  // Reset room (host)
  socket.on('resetRoom', (roomCode, callback) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) {
      callback({ error: 'Unauthorized' });
      return;
    }
    room.questions = [];
    room.participants.clear();
    room.currentQuestion = 0;
    room.scores = [];
    room.status = 'waiting';
    socket.to(roomCode).emit('roomState', room);
    callback({ ok: true });
  });

  // Join room
  socket.on('joinRoom', (data, callback) => {
    const { code, name } = data;
    const room = rooms.get(code);
    if (!room) {
      callback({ error: 'Room not found' });
      return;
    }
    const result = joinRoom(room, socket.id, name);
    if (!result) {
      callback({ error: 'Failed to join' });
      return;
    }
    socket.join(code);
    socket.to(code).emit('userJoined', { name, total: room.participants.size });
    // Send updated participant list to host
    io.to(code).emit('participantsChanged', getParticipants(room));
    // Send room state to the joining client
    socket.emit('roomState', room);
    if (callback) callback({ ok: true, room, participantId: socket.id });
  });

  // Set questions (host)
  socket.on('setQuestions', (roomCode, questions, callback) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) {
      callback({ error: 'Unauthorized' });
      return;
    }
    room.questions = questions;
    socket.to(roomCode).emit('questionsLoaded', questions);
    socket.emit('roomState', room);
    callback({ ok: true });
  });

  // Start game
  socket.on('startGame', (roomCode, callback) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) {
      callback({ error: 'Unauthorized' });
      return;
    }
    if (room.questions.length === 0) {
      callback({ error: 'No questions set' });
      return;
    }
    room.status = 'playing';
    room.currentQuestion = 0;
    room.scores = [];
    // Initialize scores for all participants
    room.participants.forEach(p => {
      p.score = 0;
      p.answers = [];
    });
    // Send first question
    socket.to(roomCode).emit('startGame', room.currentQuestion);
    if (callback) callback({ ok: true });
  });

  // Answer question
  socket.on('answerQuestion', (roomCode, answerData) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const participant = room.participants.get(socket.id);
    if (!participant) return;
    const q = room.questions[room.currentQuestion];
    if (!q) return;
    participant.answers.push({
      questionId: q.id,
      timeSpent: answerData.timeSpent || 0,
      selected: answerData.selected || ''
    });
    // Check answer
    if (q.type === 'truefalse') {
      if (answerData.selected === q.correctAnswer) {
        const score = Math.round(10000 * (q.timeBonus / Math.max(answerData.timeSpent, 1)));
        participant.score += score;
      }
    } else if (q.type === 'multi') {
      if (JSON.stringify(answerData.selected) === JSON.stringify(q.correctAnswer)) {
        const score = Math.round(10000 * (q.timeBonus / Math.max(answerData.timeSpent, 1)));
        participant.score += score;
      }
    } else if (q.type === 'open') {
      // Open questions: check length of answer
      const score = Math.min(500, Math.max(0, 500 - answerData.timeSpent * 5));
      participant.score += score;
    }
    // Broadcast answer to everyone
    io.to(roomCode).emit('answerReceived', {
      answer: answerData.selected,
      correct: q.correctAnswer,
      timeSpent: answerData.timeSpent,
      score: participant.score
    });
  });

  // Show results
  socket.on('showResults', (roomCode, callback) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) {
      callback({ error: 'Unauthorized' });
      return;
    }
    room.status = 'ended';
    // Get leaderboard
    room.scores = getLeaderboard(room);
    io.to(roomCode).emit('results', room);
    if (callback) callback({ ok: true });
  });

  // Next question (for preview mode)
  socket.on('nextQuestion', (roomCode, callback) => {
    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id) {
      callback({ error: 'Unauthorized' });
      return;
    }
    if (room.currentQuestion < room.questions.length - 1) {
      room.currentQuestion++;
      socket.to(roomCode).emit('nextQuestion', room.currentQuestion);
    }
    if (callback) callback({ ok: true });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Helpers
function getParticipants(room) {
  return Array.from(room.participants.values()).map(p => ({
    id: p.id,
    name: p.name,
    score: p.score
  }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Quiz server running on port ${PORT}`);
  console.log(`Public: http://localhost:${PORT}`);
});
