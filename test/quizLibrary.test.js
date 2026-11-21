const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
require('./setup.js');
const { MockD1 } = require('./mockD1.js');
const worker = require('../src/index.js').default;
const { QuizRoom } = require('../src/room.js');

test('Quiz Preparation & Library Lifecycle: Create, List, Retrieve, Update, Host Live, and Delete', async () => {
  const mockD1 = new MockD1();
  const env = { DB: mockD1 };

  // 1. Register a teacher user
  const regRes = await worker.fetch(new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'TeacherBob', password: 'password123' })
  }), env, {});
  const { token: bobToken, user: bobUser } = await regRes.json();
  assert.ok(bobToken);

  // 2. Teacher Bob prepares a quiz with 2 questions for later use
  const preparedQuizPayload = {
    title: 'Physics 101: Gravity & Motion',
    description: 'Midterm review quiz with velocity and acceleration questions',
    questions: [
      {
        text: 'What is the standard acceleration due to Earth gravity?',
        type: 'quiz',
        options: ['9.8 m/s²', '3.14 m/s²', '12.5 m/s²', '6.67 m/s²'],
        correctAnswer: '9.8 m/s²',
        time: 25,
        explanation: 'Standard gravity is approximately 9.80665 m/s².'
      },
      {
        text: 'Mass is the same regardless of gravitational pull.',
        type: 'truefalse',
        options: ['True', 'False'],
        correctAnswer: 'True',
        time: 15,
        explanation: 'Mass is intrinsic; weight depends on gravitational field.'
      }
    ]
  };

  const createRes = await worker.fetch(new Request('http://localhost/api/quizzes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bobToken}`
    },
    body: JSON.stringify(preparedQuizPayload)
  }), env, {});

  assert.strictEqual(createRes.status, 201);
  const createJson = await createRes.json();
  assert.strictEqual(createJson.ok, true);
  assert.strictEqual(createJson.title, 'Physics 101: Gravity & Motion');
  assert.strictEqual(createJson.count, 2);
  const quizId = createJson.quizId;
  assert.ok(quizId);

  // 3. Teacher Bob views their prepared quizzes library
  const listRes = await worker.fetch(new Request('http://localhost/api/quizzes', {
    headers: { 'Authorization': `Bearer ${bobToken}` }
  }), env, {});
  assert.strictEqual(listRes.status, 200);
  const listJson = await listRes.json();
  assert.strictEqual(listJson.ok, true);
  assert.strictEqual(listJson.quizzes.length, 1);
  assert.strictEqual(listJson.quizzes[0].id, quizId);
  assert.strictEqual(listJson.quizzes[0].title, 'Physics 101: Gravity & Motion');
  assert.strictEqual(listJson.quizzes[0].question_count, 2);

  // 4. Retrieve complete quiz details with full questions list
  const getQuizRes = await worker.fetch(new Request(`http://localhost/api/quizzes/${quizId}`), env, {});
  assert.strictEqual(getQuizRes.status, 200);
  const getQuizJson = await getQuizRes.json();
  assert.strictEqual(getQuizJson.ok, true);
  assert.strictEqual(getQuizJson.quiz.title, 'Physics 101: Gravity & Motion');
  assert.strictEqual(getQuizJson.quiz.questions.length, 2);
  assert.strictEqual(getQuizJson.quiz.questions[0].correctAnswer, '9.8 m/s²');
  assert.strictEqual(getQuizJson.quiz.questions[1].type, 'truefalse');

  // 5. Teacher Bob updates the quiz (e.g. adding a 3rd question)
  const updatedQuestions = [
    ...getQuizJson.quiz.questions,
    {
      text: 'What is Newton’s First Law commonly called?',
      type: 'quiz',
      options: ['Law of Inertia', 'Law of Action-Reaction', 'Law of Gravity', 'Law of Entropy'],
      correctAnswer: 'Law of Inertia',
      time: 20,
      explanation: 'An object at rest remains at rest unless acted on by an external force.'
    }
  ];

  const updateRes = await worker.fetch(new Request(`http://localhost/api/quizzes/${quizId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bobToken}`
    },
    body: JSON.stringify({
      title: 'Physics 101: Extended Edition',
      description: 'Updated with 3 questions',
      questions: updatedQuestions
    })
  }), env, {});

  assert.strictEqual(updateRes.status, 200);
  const updateJson = await updateRes.json();
  assert.strictEqual(updateJson.ok, true);
  assert.strictEqual(updateJson.count, 3);

  // 6. Security check: another user cannot modify Bob's quiz
  const regAliceRes = await worker.fetch(new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'AliceHacker', password: 'password123' })
  }), env, {});
  const { token: aliceToken } = await regAliceRes.json();

  const hackerUpdateRes = await worker.fetch(new Request(`http://localhost/api/quizzes/${quizId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${aliceToken}`
    },
    body: JSON.stringify({ title: 'Hacked Title' })
  }), env, {});
  assert.strictEqual(hackerUpdateRes.status, 403, 'Unauthorized user must receive 403 Forbidden');

  // 7. Teacher Bob hosts a live game room and loads the prepared quiz!
  const ctx = {
    acceptWebSocket(ws) {},
    storage: { setAlarm() {} }
  };
  const liveRoom = new QuizRoom(ctx, env);

  // Host connects
  const hostReq = new Request('http://localhost/ws?code=PHY101&name=TeacherBob&role=host', {
    headers: { Upgrade: 'websocket' }
  });
  const hostWsRes = await liveRoom.fetch(hostReq);
  const hostServerWs = Array.from(liveRoom.sockets.values())[0];

  // Player connects
  const playerReq = new Request('http://localhost/ws?code=PHY101&name=StudentSam&role=player', {
    headers: { Upgrade: 'websocket' }
  });
  const playerWsRes = await liveRoom.fetch(playerReq);
  const playerServerWs = Array.from(liveRoom.sockets.values())[1];

  const playerMessages = [];
  playerWsRes.webSocket.on('message', (e) => playerMessages.push(JSON.parse(e.data)));

  // Host loads the prepared questions into the live room!
  await liveRoom.webSocketMessage(hostServerWs, JSON.stringify({
    type: 'setQuestions',
    data: {
      title: 'Physics 101: Extended Edition',
      questions: updatedQuestions
    }
  }));

  assert.strictEqual(liveRoom.questions.length, 3, 'Live room now has all 3 prepared questions loaded');

  // Start game with prepared questions
  await liveRoom.webSocketMessage(hostServerWs, JSON.stringify({
    type: 'startGame',
    data: {}
  }));

  assert.strictEqual(liveRoom.status, 'question');
  const q1Start = playerMessages.find(m => m.type === 'questionStart');
  assert.ok(q1Start);
  assert.strictEqual(q1Start.data.question.text, 'What is the standard acceleration due to Earth gravity?');

  // Player answers correctly
  await liveRoom.webSocketMessage(playerServerWs, JSON.stringify({
    type: 'answerQuestion',
    data: { answer: '9.8 m/s²' }
  }));

  // Host reveals result
  await liveRoom.webSocketMessage(hostServerWs, JSON.stringify({
    type: 'skipQuestion',
    data: {}
  }));

  const q1End = playerMessages.find(m => m.type === 'questionEnded');
  assert.ok(q1End);
  assert.strictEqual(q1End.data.isCorrect, true);

  // 8. Teacher Bob deletes the prepared quiz
  const deleteRes = await worker.fetch(new Request(`http://localhost/api/quizzes/${quizId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${bobToken}` }
  }), env, {});
  assert.strictEqual(deleteRes.status, 200);

  // Subsequent fetch returns 404
  const checkDeleted = await worker.fetch(new Request(`http://localhost/api/quizzes/${quizId}`), env, {});
  assert.strictEqual(checkDeleted.status, 404);
});
