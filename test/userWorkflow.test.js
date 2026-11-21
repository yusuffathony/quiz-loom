const test = require('node:test');
const assert = require('node:assert');
require('./setup.js');
const { MockD1 } = require('./mockD1.js');
const worker = require('../src/index.js').default;
const { QuizRoom } = require('../src/room.js');

test('E2E User Journey: Register, Prepare Questions, Save to Cloud, Relogin, Host Live with Saved Quiz', async () => {
  const mockD1 = new MockD1();
  const env = { DB: mockD1 };

  // 1. User registers
  const regRes = await worker.fetch(new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'QuizArchitect', password: 'myStrongPassword99' })
  }), env, {});
  assert.strictEqual(regRes.status, 201);
  const { token: userToken, user } = await regRes.json();
  assert.strictEqual(user.username, 'QuizArchitect');

  // 2. User prepares questions ahead of time (e.g. for Friday's class)
  const preparedQuiz = {
    title: 'History: Ancient Civilizations',
    description: '10th grade trivia on Mesopotamia, Rome, and Egypt',
    questions: [
      {
        id: 1,
        text: 'Which ancient wonder was located in Alexandria, Egypt?',
        type: 'quiz',
        options: ['Lighthouse of Alexandria', 'Colossus of Rhodes', 'Hanging Gardens', 'Temple of Artemis'],
        correctAnswer: 'Lighthouse of Alexandria',
        time: 20,
        explanation: 'The Pharos of Alexandria was built by the Ptolemaic Kingdom.'
      },
      {
        id: 2,
        text: 'The Code of Hammurabi is one of the earliest legal codes.',
        type: 'truefalse',
        options: ['True', 'False'],
        correctAnswer: 'True',
        time: 15,
        explanation: 'Enacted by Babylonian King Hammurabi around 1750 BC.'
      }
    ]
  };

  const saveRes = await worker.fetch(new Request('http://localhost/api/quizzes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userToken}`
    },
    body: JSON.stringify(preparedQuiz)
  }), env, {});
  assert.strictEqual(saveRes.status, 201);
  const saveJson = await saveRes.json();
  const savedQuizId = saveJson.quizId;
  assert.ok(savedQuizId);

  // 3. User logs out
  await worker.fetch(new Request('http://localhost/api/auth/logout', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${userToken}` }
  }), env, {});

  // 4. Days later, user returns and logs in
  const loginRes = await worker.fetch(new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'QuizArchitect', password: 'myStrongPassword99' })
  }), env, {});
  assert.strictEqual(loginRes.status, 200);
  const loginJson = await loginRes.json();
  const freshToken = loginJson.token;
  assert.ok(freshToken);

  // 5. User checks their library: the prepared quiz is waiting for them!
  const myQuizzesRes = await worker.fetch(new Request('http://localhost/api/quizzes', {
    headers: { 'Authorization': `Bearer ${freshToken}` }
  }), env, {});
  assert.strictEqual(myQuizzesRes.status, 200);
  const myQuizzesJson = await myQuizzesRes.json();
  assert.strictEqual(myQuizzesJson.quizzes.length, 1);
  assert.strictEqual(myQuizzesJson.quizzes[0].title, 'History: Ancient Civilizations');
  assert.strictEqual(myQuizzesJson.quizzes[0].question_count, 2);

  // 6. User retrieves questions to load into game
  const fetchQuizRes = await worker.fetch(new Request(`http://localhost/api/quizzes/${savedQuizId}`), env, {});
  const fetchQuizJson = await fetchQuizRes.json();
  const questionsToPlay = fetchQuizJson.quiz.questions;
  assert.strictEqual(questionsToPlay.length, 2);

  // 7. User creates a live room and hosts the game with these prepared questions!
  const ctx = { acceptWebSocket() {}, storage: { setAlarm() {} } };
  const room = new QuizRoom(ctx, env);

  // Host joins
  const hostReq = new Request('http://localhost/ws?code=HIST01&name=QuizArchitect&role=host', {
    headers: { Upgrade: 'websocket' }
  });
  const hostUpgrade = await room.fetch(hostReq);
  const hostWs = Array.from(room.sockets.values())[0];

  // Player joins
  const playerReq = new Request('http://localhost/ws?code=HIST01&name=Cleopatra&role=player', {
    headers: { Upgrade: 'websocket' }
  });
  const playerUpgrade = await room.fetch(playerReq);
  const playerWs = Array.from(room.sockets.values())[1];

  const playerMessages = [];
  playerUpgrade.webSocket.on('message', (e) => playerMessages.push(JSON.parse(e.data)));

  // Load the prepared questions into the live room
  await room.webSocketMessage(hostWs, JSON.stringify({
    type: 'setQuestions',
    data: {
      title: fetchQuizJson.quiz.title,
      questions: questionsToPlay
    }
  }));

  // Host starts the game
  await room.webSocketMessage(hostWs, JSON.stringify({ type: 'startGame', data: {} }));
  assert.strictEqual(room.status, 'question');

  // Player receives Q1
  const q1 = playerMessages.find(m => m.type === 'questionStart');
  assert.strictEqual(q1.data.question.text, 'Which ancient wonder was located in Alexandria, Egypt?');

  // Player submits correct answer
  await room.webSocketMessage(playerWs, JSON.stringify({
    type: 'answerQuestion',
    data: { answer: 'Lighthouse of Alexandria' }
  }));

  // Host ends question
  await room.webSocketMessage(hostWs, JSON.stringify({ type: 'skipQuestion', data: {} }));
  const q1Ended = playerMessages.find(m => m.type === 'questionEnded');
  assert.strictEqual(q1Ended.data.isCorrect, true);
  assert.strictEqual(q1Ended.data.streak, 1);
  assert.ok(q1Ended.data.scoreGained > 500);

  // Next question
  await room.webSocketMessage(hostWs, JSON.stringify({ type: 'nextQuestion', data: {} }));
  assert.strictEqual(room.currentQuestionIndex, 1);

  // Player answers Q2 (True)
  await room.webSocketMessage(playerWs, JSON.stringify({
    type: 'answerQuestion',
    data: { answer: 'True' }
  }));

  // Host reveals Q2
  await room.webSocketMessage(hostWs, JSON.stringify({ type: 'skipQuestion', data: {} }));

  // Final next question triggers game end
  await room.webSocketMessage(hostWs, JSON.stringify({ type: 'nextQuestion', data: {} }));
  assert.strictEqual(room.status, 'ended');

  const gameEndedMsg = playerMessages.find(m => m.type === 'gameEnded');
  assert.ok(gameEndedMsg);
  assert.strictEqual(gameEndedMsg.data.podium[0].name, 'Cleopatra');
  assert.ok(gameEndedMsg.data.podium[0].score > 1000);
});
