/**
 * Cloudflare Durable Object: QuizRoom
 * Handles real-time room coordination, native WebSockets, authoritative timer, and D1 persistence.
 */

import { isAnswerCorrect, calculateScore, sanitizeText } from './gameLogic.js';

export class QuizRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    // Room in-memory state
    this.roomCode = '';
    this.hostSessionId = null;
    this.hostName = 'Host';
    this.quizTitle = 'General Trivia';
    this.status = 'waiting'; // waiting, question, reveal, ended
    this.questions = [];
    this.currentQuestionIndex = -1;
    this.questionStartTime = 0;
    this.questionDuration = 20;
    this.participants = new Map(); // sessionId -> { id, name, score, streak, highestStreak, answers }
    this.currentAnswers = new Map(); // sessionId -> { answer, timeSpent }
    this.timerInterval = null;
    this.remainingSeconds = 0;

    // Active WebSocket connection handles
    this.sockets = new Map(); // sessionId -> WebSocket
  }

  // Handle incoming HTTP requests to this Durable Object
  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket Upgrade Request
    if (request.headers.get('Upgrade') === 'websocket') {
      const roomCode = url.searchParams.get('code') || 'DEFAULT';
      const name = url.searchParams.get('name') || 'Anonymous';
      const role = url.searchParams.get('role') || 'player';
      const sessionId = url.searchParams.get('sessionId') || `sess_${Math.random().toString(36).substring(2, 9)}`;

      this.roomCode = roomCode.toUpperCase().trim();

      const pair = new WebSocketPair();
      const clientWs = pair[0];
      const serverWs = pair[1];

      // Enable WebSocket Hibernation if supported by runtime
      if (this.ctx && typeof this.ctx.acceptWebSocket === 'function') {
        this.ctx.acceptWebSocket(serverWs, [role]);
      } else if (typeof serverWs.accept === 'function') {
        serverWs.accept();
      }

      const meta = {
        sessionId,
        name: sanitizeText(name, 20),
        role,
        isHost: role === 'host',
        roomCode: this.roomCode
      };

      if (typeof serverWs.serializeAttachment === 'function') {
        serverWs.serializeAttachment(meta);
      } else {
        serverWs._meta = meta;
      }

      this.sockets.set(sessionId, serverWs);

      // Setup standard event listener for non-hibernating runtimes (like local dev)
      if (typeof serverWs.addEventListener === 'function') {
        serverWs.addEventListener('message', async (event) => {
          await this.webSocketMessage(serverWs, event.data);
        });
        serverWs.addEventListener('close', async (event) => {
          await this.webSocketClose(serverWs, event.code, event.reason, event.wasClean);
        });
      }

      // Handle role-specific join
      if (role === 'host') {
        this.hostSessionId = sessionId;
        this.hostName = meta.name || 'Host';
        this.send(serverWs, {
          type: 'roomCreated',
          data: this.getPublicRoomData(true)
        });
      } else {
        const participant = {
          id: sessionId,
          name: meta.name || `Player ${this.participants.size + 1}`,
          score: 0,
          streak: 0,
          highestStreak: 0,
          answers: [],
          connected: true,
          joinedAt: Date.now()
        };
        this.participants.set(sessionId, participant);

        this.send(serverWs, {
          type: 'roomJoined',
          data: {
            participantId: sessionId,
            name: participant.name,
            room: this.getPublicRoomData(false)
          }
        });

        this.broadcast({
          type: 'participantsChanged',
          data: {
            name: participant.name,
            total: this.participants.size,
            participants: this.getParticipantsList()
          }
        });
      }

      return new Response(null, {
        status: 101,
        webSocket: clientWs
      });
    }

    // Standard REST probe
    if (url.pathname.endsWith('/state')) {
      return Response.json(this.getPublicRoomData(true));
    }

    return new Response('Not Found', { status: 404 });
  }

  // Native WebSocket Message Handler
  async webSocketMessage(ws, message) {
    let packet;
    try {
      packet = typeof message === 'string' ? JSON.parse(message) : JSON.parse(new TextDecoder().decode(message));
    } catch (e) {
      return;
    }

    const meta = this.getSocketMeta(ws);
    const { type, data } = packet;

    switch (type) {
      case 'setQuestions': {
        if (!meta.isHost) {
          return this.sendError(ws, 'Unauthorized: Only host can set questions');
        }
        const questions = Array.isArray(data) ? data : (data && data.questions);
        if (!Array.isArray(questions) || questions.length === 0) {
          return this.sendError(ws, 'Questions list cannot be empty');
        }

        this.questions = questions.map((q, idx) => ({
          id: q.id !== undefined ? q.id : idx + 1,
          text: sanitizeText(q.text, 250) || `Question ${idx + 1}`,
          type: ['quiz', 'multi', 'truefalse', 'open'].includes(q.type) ? q.type : 'quiz',
          options: Array.isArray(q.options) ? q.options.map(opt => sanitizeText(String(opt), 100)) : [],
          correctAnswer: q.correctAnswer !== undefined ? q.correctAnswer : '',
          acceptableAnswers: Array.isArray(q.acceptableAnswers) ? q.acceptableAnswers : undefined,
          time: Math.min(120, Math.max(1, parseInt(q.time) || 20)),
          explanation: sanitizeText(q.explanation || '', 300)
        }));

        if (data && data.title) this.quizTitle = data.title;

        this.broadcast({
          type: 'questionsLoaded',
          data: { count: this.questions.length }
        });
        break;
      }

      case 'startGame': {
        if (!meta.isHost) {
          return this.sendError(ws, 'Unauthorized: Only host can start game');
        }
        if (this.questions.length === 0) {
          return this.sendError(ws, 'No questions have been loaded yet');
        }

        // Reset all participants
        this.participants.forEach(p => {
          p.score = 0;
          p.streak = 0;
          p.highestStreak = 0;
          p.answers = [];
        });

        this.startQuestion(0);
        break;
      }

      case 'answerQuestion': {
        if (this.status !== 'question') {
          return this.sendError(ws, 'Question is not active for answers');
        }
        if (this.currentAnswers.has(meta.sessionId)) {
          return this.sendError(ws, 'Already answered this question');
        }

        const answer = data ? data.answer : null;
        const timeSpent = Math.max(0, (Date.now() - this.questionStartTime) / 1000);
        this.currentAnswers.set(meta.sessionId, { answer, timeSpent });

        const activeCount = Array.from(this.participants.values()).filter(p => p.connected).length;
        this.broadcast({
          type: 'answerReceived',
          data: {
            totalAnswered: this.currentAnswers.size,
            totalParticipants: activeCount
          }
        });

        // If all participants answered, auto-end early
        if (this.currentAnswers.size >= Math.max(1, activeCount)) {
          setTimeout(() => {
            if (this.status === 'question') {
              this.endQuestion();
            }
          }, 600);
        }
        break;
      }

      case 'skipQuestion': {
        if (!meta.isHost) {
          return this.sendError(ws, 'Unauthorized');
        }
        this.endQuestion();
        break;
      }

      case 'nextQuestion': {
        if (!meta.isHost) {
          return this.sendError(ws, 'Unauthorized');
        }
        if (this.currentQuestionIndex < this.questions.length - 1) {
          this.startQuestion(this.currentQuestionIndex + 1);
        } else {
          await this.endGame();
        }
        break;
      }

      case 'resetRoom': {
        if (!meta.isHost) {
          return this.sendError(ws, 'Unauthorized');
        }
        this.clearTimer();
        this.status = 'waiting';
        this.currentQuestionIndex = -1;
        this.currentAnswers.clear();
        this.participants.forEach(p => {
          p.score = 0;
          p.streak = 0;
          p.highestStreak = 0;
          p.answers = [];
        });

        this.broadcast({
          type: 'roomReset',
          data: this.getPublicRoomData(false)
        });
        break;
      }
    }
  }

  // Native WebSocket Close Handler
  async webSocketClose(ws, code, reason, wasClean) {
    const meta = this.getSocketMeta(ws);
    if (!meta) return;

    this.sockets.delete(meta.sessionId);

    if (meta.isHost) {
      this.broadcast({
        type: 'hostDisconnected',
        data: { message: 'Host has disconnected.' }
      });
    } else {
      const participant = this.participants.get(meta.sessionId);
      if (participant) {
        participant.connected = false;
        if (this.status === 'waiting') {
          this.participants.delete(meta.sessionId);
        }
      }

      this.broadcast({
        type: 'participantsChanged',
        data: {
          name: meta.name || 'A player',
          total: this.participants.size,
          participants: this.getParticipantsList()
        }
      });
    }
  }

  // Start active question with authoritative countdown
  startQuestion(index) {
    this.clearTimer();

    this.status = 'question';
    this.currentQuestionIndex = index;
    this.currentAnswers.clear();
    this.questionStartTime = Date.now();

    const q = this.questions[index];
    this.questionDuration = q.time || 20;
    this.remainingSeconds = this.questionDuration;

    // Send full payload to host
    const hostPayload = {
      index,
      total: this.questions.length,
      question: {
        id: q.id,
        text: q.text,
        type: q.type,
        options: q.options,
        correctAnswer: q.correctAnswer,
        time: this.questionDuration,
        explanation: q.explanation
      },
      participantCount: this.participants.size
    };

    // Send cheat-proof payload to participants (correctAnswer stripped!)
    const participantPayload = {
      index,
      total: this.questions.length,
      question: {
        id: q.id,
        text: q.text,
        type: q.type,
        options: q.options,
        time: this.questionDuration
      }
    };

    // Dispatch payloads
    this.sockets.forEach((ws, sessionId) => {
      const meta = this.getSocketMeta(ws);
      if (meta && meta.isHost) {
        this.send(ws, { type: 'questionStart', data: hostPayload });
      } else {
        this.send(ws, { type: 'questionStart', data: participantPayload });
      }
    });

    // Authoritative 1-second timer tick
    this.timerInterval = setInterval(() => {
      this.remainingSeconds--;
      this.broadcast({
        type: 'timerTick',
        data: { remaining: this.remainingSeconds, total: this.questionDuration }
      });

      if (this.remainingSeconds <= 0) {
        this.clearTimer();
        this.endQuestion();
      }
    }, 1000);
  }

  // End question and evaluate answers
  endQuestion() {
    this.clearTimer();
    if (this.status !== 'question') return;

    this.status = 'reveal';
    const q = this.questions[this.currentQuestionIndex];
    const distribution = {};
    if (Array.isArray(q.options)) {
      q.options.forEach(opt => { distribution[opt] = 0; });
    }

    const participantResults = new Map();

    this.participants.forEach((p, sessionId) => {
      const record = this.currentAnswers.get(sessionId);
      const submittedAnswer = record ? record.answer : null;
      const timeSpent = record ? record.timeSpent : this.questionDuration;

      // Track distribution
      if (submittedAnswer !== null && submittedAnswer !== undefined) {
        if (Array.isArray(submittedAnswer)) {
          submittedAnswer.forEach(ans => { distribution[ans] = (distribution[ans] || 0) + 1; });
        } else {
          distribution[submittedAnswer] = (distribution[submittedAnswer] || 0) + 1;
        }
      }

      const scoreResult = calculateScore(q, submittedAnswer, timeSpent, this.questionDuration, p.streak);
      p.score += scoreResult.scoreGained;
      p.streak = scoreResult.newStreak;
      p.highestStreak = Math.max(p.highestStreak || 0, p.streak);

      p.answers.push({
        questionIndex: this.currentQuestionIndex,
        questionId: q.id,
        answer: submittedAnswer,
        timeSpent,
        isCorrect: scoreResult.isCorrect,
        scoreGained: scoreResult.scoreGained
      });

      participantResults.set(sessionId, {
        isCorrect: scoreResult.isCorrect,
        scoreGained: scoreResult.scoreGained,
        totalScore: p.score,
        streak: p.streak,
        streakBonus: scoreResult.streakBonus,
        timeBonus: scoreResult.timeBonus,
        submittedAnswer
      });
    });

    const leaderboard = this.getLeaderboard();
    const isLastQuestion = this.currentQuestionIndex >= this.questions.length - 1;

    // Send to Host
    if (this.hostSessionId && this.sockets.has(this.hostSessionId)) {
      this.send(this.sockets.get(this.hostSessionId), {
        type: 'questionEnded',
        data: {
          correctAnswer: q.correctAnswer,
          explanation: q.explanation,
          distribution,
          leaderboard,
          isLastQuestion,
          questionIndex: this.currentQuestionIndex,
          totalQuestions: this.questions.length
        }
      });
    }

    // Send personalized result to each participant
    participantResults.forEach((res, sessionId) => {
      const ws = this.sockets.get(sessionId);
      if (ws) {
        const rankItem = leaderboard.find(l => l.id === sessionId);
        this.send(ws, {
          type: 'questionEnded',
          data: {
            ...res,
            rank: rankItem ? rankItem.rank : 0,
            correctAnswer: q.correctAnswer,
            explanation: q.explanation,
            distribution,
            leaderboard,
            isLastQuestion,
            questionIndex: this.currentQuestionIndex,
            totalQuestions: this.questions.length
          }
        });
      }
    });
  }

  // End game & persist session to Cloudflare D1
  async endGame() {
    this.clearTimer();
    this.status = 'ended';

    const leaderboard = this.getLeaderboard();
    const podium = leaderboard.slice(0, 3);
    const endData = { leaderboard, podium };

    // Broadcast final podium
    this.broadcast({
      type: 'gameEnded',
      data: endData
    });

    // Save game summary & results to Cloudflare D1 if available
    const db = this.env ? (this.env.DB || this.env.quiz_loom_db) : null;
    if (db) {
      try {
        const sessionId = `${this.roomCode}-${Date.now()}`;
        await db.prepare(
          `INSERT INTO game_sessions (id, room_code, host_name, quiz_title, participant_count) VALUES (?, ?, ?, ?, ?)`
        ).bind(sessionId, this.roomCode, this.hostName, this.quizTitle, this.participants.size).run();

        const insertResultStmt = db.prepare(
          `INSERT INTO game_results (session_id, player_name, rank, score, streak) VALUES (?, ?, ?, ?, ?)`
        );
        const batchOps = leaderboard.map(p =>
          insertResultStmt.bind(sessionId, p.name, p.rank, p.score, p.streak)
        );
        if (batchOps.length > 0) {
          await db.batch(batchOps);
        }
      } catch (err) {
        console.error('Failed to save game session to D1:', err);
      }
    }
  }

  clearTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  getSocketMeta(ws) {
    if (typeof ws.deserializeAttachment === 'function') {
      return ws.deserializeAttachment() || {};
    }
    return ws._meta || {};
  }

  send(ws, payload) {
    try {
      if (ws.readyState === 1) { // OPEN
        ws.send(JSON.stringify(payload));
      }
    } catch (e) {
      console.error('WebSocket send error:', e);
    }
  }

  sendError(ws, message) {
    this.send(ws, { type: 'error', data: { message } });
  }

  broadcast(payload) {
    const raw = JSON.stringify(payload);
    this.sockets.forEach(ws => {
      try {
        if (ws.readyState === 1) ws.send(raw);
      } catch (e) {}
    });
  }

  getLeaderboard() {
    const list = Array.from(this.participants.values()).map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      streak: p.streak,
      highestStreak: p.highestStreak,
      connected: p.connected
    }));
    list.sort((a, b) => b.score - a.score);
    return list.map((item, index) => ({
      ...item,
      rank: index + 1
    }));
  }

  getParticipantsList() {
    return Array.from(this.participants.values()).map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      streak: p.streak,
      connected: p.connected
    }));
  }

  getPublicRoomData(forHost = false) {
    const list = this.getParticipantsList();
    return {
      code: this.roomCode,
      hostName: this.hostName,
      status: this.status,
      questionCount: this.questions.length,
      currentQuestionIndex: this.currentQuestionIndex,
      participants: list,
      participantCount: list.length,
      isHost: forHost
    };
  }
}
