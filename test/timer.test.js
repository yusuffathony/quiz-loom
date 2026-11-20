const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { app, roomManager, io } = require('../server');

test('Timer countdown ticks accurately and auto-ends question on time expiry (0s)', async () => {
  const room = roomManager.createRoom('h_timer', 'HostTimer');
  roomManager.setQuestions(room.code, 'h_timer', [
    {
      id: 1,
      text: 'What is 1 + 1?',
      type: 'quiz',
      options: ['2', '3'],
      correctAnswer: '2',
      time: 2 // 2-second timer
    }
  ]);
  roomManager.joinRoom(room.code, 'p_timer', 'PlayerTimer');

  // Intercept io.to to track broadcasts
  const emittedEvents = [];
  const origTo = io.to.bind(io);
  io.to = function(target) {
    return {
      emit: function(event, payload) {
        emittedEvents.push({ target, event, payload, timestamp: Date.now() });
      }
    };
  };

  const host = new EventEmitter();
  host.id = 'h_timer';
  host.join = () => {};
  io.listeners('connection')[0](host);

  // 1. Host starts game
  await new Promise((resolve) => {
    host.emit('startGame', { code: room.code }, (res) => {
      assert.strictEqual(res.ok, true);
      resolve();
    });
  });

  assert.strictEqual(room.status, 'question');
  assert.ok(room.timerHandle !== null, 'Timer handle should be active during question');

  // 2. Wait 2.3 seconds for 2s timer to naturally expire
  await new Promise((resolve) => setTimeout(resolve, 2300));

  // 3. Verify timer completed and question auto-ended
  assert.strictEqual(room.status, 'reveal', 'Room status should automatically transition to reveal');
  assert.strictEqual(room.timerHandle, null, 'Timer handle should be cleaned up on expiry');

  // 4. Verify timer ticks were emitted decrementing to 0
  const ticks = emittedEvents.filter(e => e.event === 'timerTick').map(e => e.payload.remaining);
  assert.ok(ticks.length >= 2, 'Should have received countdown ticks');
  assert.strictEqual(ticks[ticks.length - 1], 0, 'Final tick should reach 0s');

  // 5. Verify questionEnded was broadcast to host and participant
  const endedEvents = emittedEvents.filter(e => e.event === 'questionEnded');
  assert.ok(endedEvents.length >= 2, 'Should emit questionEnded to host and participant');

  const participantResult = endedEvents.find(e => e.target === 'p_timer');
  assert.ok(participantResult, 'Participant should receive result');
  assert.strictEqual(participantResult.payload.isCorrect, false, 'Unanswered question should be marked incorrect');
  assert.strictEqual(participantResult.payload.scoreGained, 0, 'No points awarded on timeout');

  // Clean up
  host.emit('disconnect');
  io.to = origTo;
});

test('Fast forward: timer stops immediately if all active players submit answers', async () => {
  const room = roomManager.createRoom('h_fast', 'HostFast');
  roomManager.setQuestions(room.code, 'h_fast', [
    {
      id: 1,
      text: 'Fast question?',
      type: 'quiz',
      options: ['A', 'B'],
      correctAnswer: 'A',
      time: 20 // 20-second timer
    }
  ]);
  roomManager.joinRoom(room.code, 'p_fast1', 'Player 1');

  const emittedEvents = [];
  const origTo = io.to.bind(io);
  io.to = function(target) {
    return {
      emit: function(event, payload) {
        emittedEvents.push({ target, event, payload, timestamp: Date.now() });
      }
    };
  };

  const host = new EventEmitter();
  host.id = 'h_fast';
  host.join = () => {};
  io.listeners('connection')[0](host);

  const player = new EventEmitter();
  player.id = 'p_fast1';
  player.join = () => {};
  io.listeners('connection')[0](player);

  // Host starts game (20s timer)
  await new Promise(resolve => host.emit('startGame', { code: room.code }, resolve));
  assert.strictEqual(room.status, 'question');

  // Player answers immediately (at ~100ms)
  await new Promise(resolve => player.emit('answerQuestion', { code: room.code, answer: 'A' }, resolve));

  // Wait 750ms for auto-reveal (grace period is 600ms)
  await new Promise(resolve => setTimeout(resolve, 750));

  // Should have transitioned to reveal way before the 20s timer!
  assert.strictEqual(room.status, 'reveal');
  assert.strictEqual(room.timerHandle, null);

  // Clean up
  host.emit('disconnect');
  player.emit('disconnect');
  io.to = origTo;
});
