const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { app, roomManager, io } = require('../server');
const { PRESET_QUIZZES } = require('../presets');

// Mock Socket implementation
class MockSocket extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.rooms = new Set();
    this.emitted = [];
  }

  join(room) {
    this.rooms.add(room);
  }

  leave(room) {
    this.rooms.delete(room);
  }

  emit(event, ...args) {
    this.emitted.push({ event, args });
    return super.emit(event, ...args);
  }
}

function connectMockSocket(id) {
  const socket = new MockSocket(id);
  const listener = io.listeners('connection')[0];
  if (listener) listener(socket);
  return socket;
}

test('API endpoints: /api/presets and /health', async () => {
  // Test /api/presets
  await new Promise((resolve) => {
    const req = { method: 'GET', url: '/api/presets', headers: {} };
    const res = {
      setHeader: () => {},
      getHeader: () => {},
      json: (data) => {
        assert.strictEqual(data.ok, true);
        assert.strictEqual(Array.isArray(data.presets), true);
        assert.strictEqual(data.presets.length, PRESET_QUIZZES.length);
        resolve();
      },
      end: () => resolve()
    };
    app.handle(req, res);
  });

  // Test /health
  await new Promise((resolve) => {
    const req = { method: 'GET', url: '/health', headers: {} };
    const res = {
      setHeader: () => {},
      getHeader: () => {},
      json: (data) => {
        assert.strictEqual(data.status, 'ok');
        assert.ok(typeof data.uptime === 'number');
        resolve();
      },
      end: () => resolve()
    };
    app.handle(req, res);
  });
});

test('Socket Flow: createRoom, joinRoom, setQuestions, startGame, answerQuestion, results', async () => {
  const hostSocket = connectMockSocket('mock_host_1');
  const playerSocket = connectMockSocket('mock_player_1');

  // 1. Host creates room
  let createdRoomCode = null;
  await new Promise((resolve) => {
    hostSocket.emit('createRoom', { hostName: 'SuperHost' }, (resp) => {
      assert.strictEqual(resp.ok, true);
      assert.ok(resp.code);
      createdRoomCode = resp.code;
      resolve();
    });
  });

  assert.ok(hostSocket.rooms.has(createdRoomCode));

  // 2. Player joins room
  await new Promise((resolve) => {
    playerSocket.emit('joinRoom', { code: createdRoomCode, name: 'Alice' }, (resp) => {
      assert.strictEqual(resp.ok, true);
      assert.strictEqual(resp.name, 'Alice');
      resolve();
    });
  });

  assert.ok(playerSocket.rooms.has(createdRoomCode));

  // 3. Host sets questions
  const questions = [
    {
      id: 1,
      text: 'What is the capital of France?',
      type: 'quiz',
      options: ['London', 'Berlin', 'Paris', 'Madrid'],
      correctAnswer: 'Paris',
      time: 15,
      explanation: 'Paris is the capital of France.'
    }
  ];

  await new Promise((resolve) => {
    hostSocket.emit('setQuestions', { code: createdRoomCode, questions }, (resp) => {
      assert.strictEqual(resp.ok, true);
      assert.strictEqual(resp.count, 1);
      resolve();
    });
  });

  // 4. Host starts game
  await new Promise((resolve) => {
    hostSocket.emit('startGame', { code: createdRoomCode }, (resp) => {
      assert.strictEqual(resp.ok, true);
      resolve();
    });
  });

  const room = roomManager.getRoom(createdRoomCode);
  assert.strictEqual(room.status, 'question');
  assert.strictEqual(room.currentQuestionIndex, 0);

  // 5. Participant answers question
  await new Promise((resolve) => {
    playerSocket.emit('answerQuestion', { code: createdRoomCode, answer: 'Paris' }, (resp) => {
      assert.strictEqual(resp.ok, true);
      resolve();
    });
  });

  // Verify answer is recorded
  assert.strictEqual(room.currentAnswers.size, 1);

  // 6. Host skips timer to reveal answer
  await new Promise((resolve) => {
    hostSocket.emit('skipQuestion', { code: createdRoomCode }, (resp) => {
      assert.strictEqual(resp.ok, true);
      resolve();
    });
  });

  assert.strictEqual(room.status, 'reveal');
  const participant = room.participants.get('mock_player_1');
  assert.strictEqual(participant.score > 500, true);
  assert.strictEqual(participant.streak, 1);

  // 7. Host requests nextQuestion (ends game because 1 question)
  await new Promise((resolve) => {
    hostSocket.emit('nextQuestion', { code: createdRoomCode }, (resp) => {
      assert.strictEqual(resp.ok, true);
      resolve();
    });
  });

  assert.strictEqual(room.status, 'ended');

  // 8. Host resets room
  await new Promise((resolve) => {
    hostSocket.emit('resetRoom', { code: createdRoomCode }, (resp) => {
      assert.strictEqual(resp.ok, true);
      resolve();
    });
  });

  assert.strictEqual(room.status, 'waiting');
  assert.strictEqual(participant.score, 0);

  // 9. Disconnect
  playerSocket.emit('disconnect');
  assert.strictEqual(room.participants.size, 0);

  hostSocket.emit('disconnect');
  // Room is cleaned up
  assert.strictEqual(roomManager.getRoom(createdRoomCode), null);
});
