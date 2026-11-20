const test = require('node:test');
const assert = require('node:assert');
const { Encoder } = require('socket.io-parser');
const { EventEmitter } = require('node:events');
const { app, roomManager, io } = require('../server');
const { PRESET_QUIZZES } = require('../presets');

test('Socket.IO parser encodes all server packets without circular recursion', async () => {
  const encoder = new Encoder();

  function assertEncodable(data) {
    assert.doesNotThrow(() => {
      // type 2 is EVENT, type 3 is ACK
      encoder.encode({ type: 2, nsp: '/', data: ['event', data], id: 1 });
    }, `Data should be encodable by socket.io-parser without Maximum call stack size exceeded`);
  }

  // 1. Test preset questions
  PRESET_QUIZZES.forEach(p => {
    assertEncodable(p);
  });

  // 2. Test room public data
  const room = roomManager.createRoom('h_enc', 'HostEnc');
  roomManager.setQuestions(room.code, 'h_enc', PRESET_QUIZZES[0].questions);
  roomManager.joinRoom(room.code, 'p_enc', 'PlayerEnc');

  const pubData = roomManager.getPublicRoomData(room, true);
  assertEncodable(pubData);

  // 3. Test question start payloads
  const qStart = roomManager.startQuestion(room.code, 'h_enc', 0);
  assertEncodable(qStart.hostPayload);
  assertEncodable(qStart.participantPayload);

  // 4. Test evaluate question payloads
  roomManager.recordAnswer(room.code, 'p_enc', { answer: 'Cascading Style Sheets' });
  const evalRes = roomManager.evaluateQuestion(room.code);
  assertEncodable(evalRes.leaderboard);
  assertEncodable(evalRes.distribution);
  assertEncodable(evalRes.participantResults.get('p_enc'));

  // 5. Test game over payload
  const endRes = roomManager.endGame(room.code, 'h_enc');
  assertEncodable(endRes);

  // 6. Test real socket callback serialization
  const host = new EventEmitter();
  host.id = 'h_enc';
  host.join = () => {};
  io.listeners('connection')[0](host);

  // Verify startGame callback payload is safe
  await new Promise((resolve) => {
    host.emit('startGame', { code: room.code }, (ack) => {
      assertEncodable(ack);
      assert.strictEqual(ack.ok, true);
      resolve();
    });
  });

  // Verify nextQuestion callback payload is safe
  await new Promise((resolve) => {
    host.emit('nextQuestion', { code: room.code }, (ack) => {
      assertEncodable(ack);
      assert.strictEqual(ack.ok, true);
      resolve();
    });
  });

  host.emit('disconnect');
});
