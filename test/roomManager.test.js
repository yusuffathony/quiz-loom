const test = require('node:test');
const assert = require('node:assert');
const {
  RoomManager,
  generateRoomCode,
  isAnswerCorrect,
  calculateScore
} = require('../roomManager');

test('generateRoomCode generates valid 6-char unique code', () => {
  const existing = new Set(['ABCDEF']);
  const code = generateRoomCode(existing);
  assert.strictEqual(code.length, 6);
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.notStrictEqual(code, 'ABCDEF');
});

test('isAnswerCorrect handles quiz, truefalse, multi, and open questions', () => {
  // Quiz (single choice)
  const q1 = {
    type: 'quiz',
    options: ['Cascading Style Sheets', 'Creative Style Sheets'],
    correctAnswer: 'Cascading Style Sheets'
  };
  assert.strictEqual(isAnswerCorrect(q1, 'Cascading Style Sheets'), true);
  assert.strictEqual(isAnswerCorrect(q1, 'cascading style sheets'), true);
  assert.strictEqual(isAnswerCorrect(q1, 0), true); // Option index 0
  assert.strictEqual(isAnswerCorrect(q1, 'Wrong'), false);

  // True/False
  const q2 = {
    type: 'truefalse',
    options: ['True', 'False'],
    correctAnswer: 'True'
  };
  assert.strictEqual(isAnswerCorrect(q2, 'True'), true);
  assert.strictEqual(isAnswerCorrect(q2, 'true'), true);
  assert.strictEqual(isAnswerCorrect(q2, 'False'), false);

  // Multi choice
  const q3 = {
    type: 'multi',
    options: ['A', 'B', 'C', 'D'],
    correctAnswer: ['A', 'C']
  };
  assert.strictEqual(isAnswerCorrect(q3, ['A', 'C']), true);
  assert.strictEqual(isAnswerCorrect(q3, ['C', 'A']), true);
  assert.strictEqual(isAnswerCorrect(q3, ['A']), false);
  assert.strictEqual(isAnswerCorrect(q3, ['A', 'B', 'C']), false);

  // Open question
  const q4 = {
    type: 'open',
    correctAnswer: 'Tokyo',
    acceptableAnswers: ['Tokyo', 'Tokio']
  };
  assert.strictEqual(isAnswerCorrect(q4, 'Tokyo'), true);
  assert.strictEqual(isAnswerCorrect(q4, ' tokio '), true);
  assert.strictEqual(isAnswerCorrect(q4, 'Kyoto'), false);
});

test('calculateScore awards points based on speed and streak', () => {
  const q = { type: 'quiz', correctAnswer: 'A', time: 20 };

  // Incorrect answer
  const wrongRes = calculateScore(q, 'B', 2, 20, 2);
  assert.strictEqual(wrongRes.isCorrect, false);
  assert.strictEqual(wrongRes.scoreGained, 0);
  assert.strictEqual(wrongRes.newStreak, 0);

  // Fast correct answer (0 seconds elapsed)
  const fastRes = calculateScore(q, 'A', 0, 20, 0);
  assert.strictEqual(fastRes.isCorrect, true);
  assert.strictEqual(fastRes.scoreGained, 1000); // 500 base + 500 speed
  assert.strictEqual(fastRes.newStreak, 1);

  // Slower correct answer (10s elapsed out of 20s)
  const slowRes = calculateScore(q, 'A', 10, 20, 0);
  assert.strictEqual(slowRes.isCorrect, true);
  assert.strictEqual(slowRes.scoreGained, 750); // 500 base + 250 speed

  // Streak bonus
  const streakRes = calculateScore(q, 'A', 0, 20, 2); // 3rd consecutive correct
  assert.strictEqual(streakRes.isCorrect, true);
  assert.strictEqual(streakRes.newStreak, 3);
  assert.strictEqual(streakRes.streakBonus, 200); // (3-1) * 100 = 200
  assert.strictEqual(streakRes.scoreGained, 1200); // 1000 + 200
});

test('RoomManager handles full room lifecycle', () => {
  const rm = new RoomManager();

  // 1. Create Room
  const hostSocketId = 'host_socket_1';
  const room = rm.createRoom(hostSocketId, 'Quizmaster');
  assert.ok(room.code);
  assert.strictEqual(room.hostName, 'Quizmaster');
  assert.strictEqual(room.status, 'waiting');

  // 2. Join Room
  const player1SocketId = 'player_1';
  const join1 = rm.joinRoom(room.code, player1SocketId, 'Alice');
  assert.strictEqual(join1.ok, true);
  assert.strictEqual(join1.participant.name, 'Alice');

  const player2SocketId = 'player_2';
  const join2 = rm.joinRoom(room.code, player2SocketId, 'Bob');
  assert.strictEqual(join2.ok, true);
  assert.strictEqual(join2.participant.name, 'Bob');

  assert.strictEqual(room.participants.size, 2);

  // 3. Set Questions
  const questions = [
    {
      id: 1,
      text: 'What is 2 + 2?',
      type: 'quiz',
      options: ['3', '4', '5'],
      correctAnswer: '4',
      time: 20
    },
    {
      id: 2,
      text: 'Is water wet?',
      type: 'truefalse',
      options: ['True', 'False'],
      correctAnswer: 'True',
      time: 15
    }
  ];

  const setRes = rm.setQuestions(room.code, hostSocketId, questions);
  assert.strictEqual(setRes.ok, true);
  assert.strictEqual(room.questions.length, 2);

  // 4. Start Question 0
  const startRes = rm.startQuestion(room.code, hostSocketId, 0);
  assert.strictEqual(startRes.ok, true);
  assert.strictEqual(room.status, 'question');
  // Verify cheat-prevention: correctAnswer is stripped in participantPayload
  assert.strictEqual(startRes.participantPayload.question.correctAnswer, undefined);
  assert.strictEqual(startRes.hostPayload.question.correctAnswer, '4');

  // 5. Submit Answers
  const ans1 = rm.recordAnswer(room.code, player1SocketId, { answer: '4' });
  assert.strictEqual(ans1.ok, true);
  assert.strictEqual(ans1.allAnswered, false);

  // Prevent double answering
  const dup = rm.recordAnswer(room.code, player1SocketId, { answer: '4' });
  assert.strictEqual(dup.error, 'Already answered this question');

  const ans2 = rm.recordAnswer(room.code, player2SocketId, { answer: '3' });
  assert.strictEqual(ans2.ok, true);
  assert.strictEqual(ans2.allAnswered, true); // Both answered

  // 6. Evaluate Question
  const evalRes = rm.evaluateQuestion(room.code);
  assert.strictEqual(room.status, 'reveal');
  assert.strictEqual(evalRes.isLastQuestion, false);

  const aliceRes = evalRes.participantResults.get(player1SocketId);
  const bobRes = evalRes.participantResults.get(player2SocketId);

  assert.strictEqual(aliceRes.isCorrect, true);
  assert.ok(aliceRes.scoreGained > 500);
  assert.strictEqual(bobRes.isCorrect, false);
  assert.strictEqual(bobRes.scoreGained, 0);

  // Check leaderboard
  assert.strictEqual(evalRes.leaderboard[0].name, 'Alice');
  assert.strictEqual(evalRes.leaderboard[0].rank, 1);
  assert.strictEqual(evalRes.leaderboard[1].name, 'Bob');
  assert.strictEqual(evalRes.leaderboard[1].rank, 2);

  // 7. End Game
  const endRes = rm.endGame(room.code, hostSocketId);
  assert.strictEqual(endRes.ok, true);
  assert.strictEqual(room.status, 'ended');
  assert.strictEqual(endRes.podium.length, 2);
  assert.strictEqual(endRes.podium[0].name, 'Alice');

  // 8. Reset Room
  const resetRes = rm.resetRoom(room.code, hostSocketId);
  assert.strictEqual(resetRes.ok, true);
  assert.strictEqual(room.status, 'waiting');
  assert.strictEqual(room.participants.get(player1SocketId).score, 0);

  // 9. Leave Room
  const leaveRes = rm.leaveRoom(player1SocketId);
  assert.strictEqual(leaveRes.room.participants.size, 1);
});
