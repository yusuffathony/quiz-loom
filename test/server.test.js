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

test('Node Express Server: Auth & Quiz Library CRUD endpoints', async () => {
  // Helper to simulate express request/response
  function requestApp(method, url, body = null, headers = {}) {
    return new Promise((resolve) => {
      const req = {
        method,
        url,
        body,
        headers: {
          'content-type': 'application/json',
          ...headers
        },
        params: {}
      };

      // Match /api/quizzes/:id
      const quizMatch = url.match(/^\/api\/quizzes\/([^/?#]+)$/);
      if (quizMatch) {
        req.params.id = quizMatch[1];
      }

      let statusCode = 200;
      const res = {
        statusCode: 200,
        status(code) {
          statusCode = code;
          this.statusCode = code;
          return this;
        },
        setHeader() {},
        getHeader() {},
        json(data) {
          resolve({ status: statusCode, body: data });
        },
        end() {
          resolve({ status: statusCode, body: null });
        }
      };
      app.handle(req, res);
    });
  }

  // 1. Register User
  const regRes = await requestApp('POST', '/api/auth/register', {
    username: 'NodeTeacher',
    password: 'password123'
  });
  assert.strictEqual(regRes.status, 201);
  assert.strictEqual(regRes.body.ok, true);
  assert.strictEqual(regRes.body.user.username, 'NodeTeacher');
  const token = regRes.body.token;
  assert.ok(token);

  // 2. /api/auth/me
  const meRes = await requestApp('GET', '/api/auth/me', null, {
    authorization: `Bearer ${token}`
  });
  assert.strictEqual(meRes.status, 200);
  assert.strictEqual(meRes.body.user.username, 'NodeTeacher');

  // 3. Create Prepared Quiz
  const createRes = await requestApp('POST', '/api/quizzes', {
    title: 'Node JS Mastery',
    description: 'Server side JavaScript questions',
    questions: [
      {
        text: 'What is the default package manager for Node.js?',
        options: ['npm', 'pip', 'gem', 'cargo'],
        correctAnswer: 'npm',
        time: 20
      }
    ]
  }, { authorization: `Bearer ${token}` });
  assert.strictEqual(createRes.status, 201);
  const quizId = createRes.body.quizId;
  assert.ok(quizId);

  // 4. List Prepared Quizzes
  const listRes = await requestApp('GET', '/api/quizzes', null, {
    authorization: `Bearer ${token}`
  });
  assert.strictEqual(listRes.status, 200);
  assert.strictEqual(listRes.body.quizzes.length, 1);
  assert.strictEqual(listRes.body.quizzes[0].id, quizId);

  // 5. Retrieve Quiz with questions
  const getRes = await requestApp('GET', `/api/quizzes/${quizId}`);
  assert.strictEqual(getRes.status, 200);
  assert.strictEqual(getRes.body.quiz.title, 'Node JS Mastery');
  assert.strictEqual(getRes.body.quiz.questions.length, 1);
  assert.strictEqual(getRes.body.quiz.questions[0].correctAnswer, 'npm');

  // 6. Update Quiz
  const putRes = await requestApp('PUT', `/api/quizzes/${quizId}`, {
    title: 'Node JS & Express Mastery',
    questions: [
      ...getRes.body.quiz.questions,
      {
        text: 'Is Node.js single-threaded on the event loop?',
        type: 'truefalse',
        options: ['True', 'False'],
        correctAnswer: 'True',
        time: 15
      }
    ]
  }, { authorization: `Bearer ${token}` });
  assert.strictEqual(putRes.status, 200);
  assert.strictEqual(putRes.body.count, 2);

  // 7. Delete Quiz
  const delRes = await requestApp('DELETE', `/api/quizzes/${quizId}`, null, {
    authorization: `Bearer ${token}`
  });
  assert.strictEqual(delRes.status, 200);

  // 8. Logout
  const logoutRes = await requestApp('POST', '/api/auth/logout', null, {
    authorization: `Bearer ${token}`
  });
  assert.strictEqual(logoutRes.status, 200);
});
