const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
require('./setup.js');

// Import Cloudflare modules
const { isAnswerCorrect, calculateScore } = require('../src/gameLogic.js');
const { QuizRoom } = require('../src/room.js');
const worker = require('../src/index.js').default;

// Mock D1 Database implementation
const { MockD1 } = require('./mockD1.js');

test('Cloudflare gameLogic: isAnswerCorrect & calculateScore', () => {
  const q = { type: 'quiz', options: ['A', 'B'], correctAnswer: 'A', time: 20 };
  assert.strictEqual(isAnswerCorrect(q, 'A'), true);
  assert.strictEqual(isAnswerCorrect(q, 'B'), false);

  const res = calculateScore(q, 'A', 2, 20, 1);
  assert.strictEqual(res.isCorrect, true);
  assert.strictEqual(res.newStreak, 2);
  assert.strictEqual(res.streakBonus, 100);
});

test('Cloudflare QuizRoom Durable Object: WebSocket lifecycle, Game Flow & D1 persistence', async () => {
  const mockD1 = new MockD1();
  const env = {
    DB: mockD1
  };
  const ctx = {
    acceptWebSocket(ws) {},
    storage: {
      setAlarm() {}
    }
  };

  const room = new QuizRoom(ctx, env);

  // 1. Host upgrades WebSocket connection
  const hostReq = new Request('http://localhost/ws?code=CFTEST&name=HostAlice&role=host', {
    headers: { Upgrade: 'websocket' }
  });
  const hostUpgradeRes = await room.fetch(hostReq);
  assert.strictEqual(hostUpgradeRes.status, 101);
  assert.ok(hostUpgradeRes.webSocket);

  // 2. Player upgrades WebSocket connection
  const playerReq = new Request('http://localhost/ws?code=CFTEST&name=Bob&role=player', {
    headers: { Upgrade: 'websocket' }
  });
  const playerUpgradeRes = await room.fetch(playerReq);
  assert.strictEqual(playerUpgradeRes.status, 101);
  assert.ok(playerUpgradeRes.webSocket);

  assert.strictEqual(room.participants.size, 1);
  assert.strictEqual(room.hostName, 'HostAlice');

  // Track messages received on player client socket
  const playerReceived = [];
  playerUpgradeRes.webSocket.on('message', (event) => {
    playerReceived.push(JSON.parse(event.data));
  });

  // Track messages received on host client socket
  const hostReceived = [];
  hostUpgradeRes.webSocket.on('message', (event) => {
    hostReceived.push(JSON.parse(event.data));
  });

  // 3. Host sets questions via native WebSocket message
  const hostServerWs = Array.from(room.sockets.values())[0];
  await room.webSocketMessage(hostServerWs, JSON.stringify({
    type: 'setQuestions',
    data: {
      questions: [
        {
          id: 1,
          text: 'Is Cloudflare Workers fast?',
          type: 'truefalse',
          options: ['True', 'False'],
          correctAnswer: 'True',
          time: 15,
          explanation: 'Workers execute at the edge across 300+ cities.'
        }
      ]
    }
  }));

  assert.strictEqual(room.questions.length, 1);

  // 4. Host starts game
  await room.webSocketMessage(hostServerWs, JSON.stringify({
    type: 'startGame',
    data: {}
  }));

  assert.strictEqual(room.status, 'question');
  assert.strictEqual(room.currentQuestionIndex, 0);

  // Check cheat-prevention: player's questionStart message should NOT have correctAnswer
  const playerQStart = playerReceived.find(m => m.type === 'questionStart');
  assert.ok(playerQStart, 'Player should receive questionStart');
  assert.strictEqual(playerQStart.data.question.correctAnswer, undefined, 'Player payload must hide correct answer');

  // 5. Player submits answer via native WebSocket
  const playerServerWs = Array.from(room.sockets.values())[1];
  await room.webSocketMessage(playerServerWs, JSON.stringify({
    type: 'answerQuestion',
    data: { answer: 'True' }
  }));

  assert.strictEqual(room.currentAnswers.size, 1);

  // 6. Host skips timer to reveal
  await room.webSocketMessage(hostServerWs, JSON.stringify({
    type: 'skipQuestion',
    data: {}
  }));

  assert.strictEqual(room.status, 'reveal');
  const playerQEnd = playerReceived.find(m => m.type === 'questionEnded');
  assert.ok(playerQEnd, 'Player should receive questionEnded');
  assert.strictEqual(playerQEnd.data.isCorrect, true);
  assert.ok(playerQEnd.data.scoreGained > 500);

  // 7. Advance to game over & verify D1 persistence
  await room.webSocketMessage(hostServerWs, JSON.stringify({
    type: 'nextQuestion',
    data: {}
  }));

  assert.strictEqual(room.status, 'ended');
  const playerGameEnd = playerReceived.find(m => m.type === 'gameEnded');
  assert.ok(playerGameEnd);
  assert.strictEqual(playerGameEnd.data.podium[0].name, 'Bob');

  // Verify that D1 database was written to!
  assert.strictEqual(mockD1.sessions.length, 1, 'Game session should be saved in D1');
  assert.strictEqual(mockD1.results.length, 1, 'Leaderboard result should be saved in D1');
  assert.strictEqual(mockD1.results[0][1], 'Bob', 'Player Bob score should be recorded in D1');
});

test('Cloudflare Worker: HTTP routes /api/presets, /health, /api/quizzes', async () => {
  const mockD1 = new MockD1();
  const env = { DB: mockD1 };

  // 1. Presets endpoint
  const presetsReq = new Request('http://localhost/api/presets');
  const presetsRes = await worker.fetch(presetsReq, env, {});
  const presetsJson = await presetsRes.json();
  assert.strictEqual(presetsJson.ok, true);
  assert.ok(Array.isArray(presetsJson.presets));

  // 2. Health endpoint
  const healthReq = new Request('http://localhost/health');
  const healthRes = await worker.fetch(healthReq, env, {});
  const healthJson = await healthRes.json();
  assert.strictEqual(healthJson.status, 'ok');
  assert.strictEqual(healthJson.platform, 'cloudflare-workers');

  // 3. Save Custom Quiz to D1 endpoint
  const saveReq = new Request('http://localhost/api/quizzes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'D1 Trivia',
      description: 'Saved on Cloudflare D1',
      questions: [
        { text: 'What is D1?', correctAnswer: 'Serverless SQLite' }
      ]
    })
  });
  const saveRes = await worker.fetch(saveReq, env, {});
  const saveJson = await saveRes.json();
  assert.strictEqual(saveJson.ok, true);
  assert.strictEqual(saveJson.count, 1);
  assert.strictEqual(mockD1.quizzes.size, 1);
});
