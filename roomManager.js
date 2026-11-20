/**
 * QuizLoom Room & Game State Manager
 * Handles multi-room coordination, authoritative timer scoring, and cheat-proof state serialization.
 */

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode(existingRooms) {
  let code = '';
  let attempts = 0;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += CHARS[Math.floor(Math.random() * CHARS.length)];
    }
    attempts++;
  } while (existingRooms && existingRooms.has(code) && attempts < 1000);
  return code;
}

function sanitizeText(str, maxLen = 100) {
  if (!str || typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

function isAnswerCorrect(question, submittedAnswer) {
  if (!question || submittedAnswer === undefined || submittedAnswer === null) return false;
  const qType = question.type || 'quiz';

  if (qType === 'quiz' || qType === 'truefalse') {
    // Single choice or True/False
    const expected = String(question.correctAnswer).trim().toLowerCase();
    const actual = String(submittedAnswer).trim().toLowerCase();
    if (expected === actual) return true;

    // Check if expected was an index (e.g. 0, 1, 2) matching options
    if (Array.isArray(question.options)) {
      const expectedIndex = question.options.findIndex(
        opt => String(opt).trim().toLowerCase() === expected
      );
      if (expectedIndex !== -1 && String(submittedAnswer) === String(expectedIndex)) {
        return true;
      }
      const actualIndex = question.options.findIndex(
        opt => String(opt).trim().toLowerCase() === actual
      );
      if (actualIndex !== -1 && String(question.correctAnswer) === String(actualIndex)) {
        return true;
      }
    }
    return false;
  }

  if (qType === 'multi') {
    // Multiple choice: both expected and submitted should match as sets
    const expectedArr = Array.isArray(question.correctAnswer)
      ? question.correctAnswer.map(v => String(v).trim().toLowerCase())
      : [String(question.correctAnswer).trim().toLowerCase()];
    
    const submittedArr = Array.isArray(submittedAnswer)
      ? submittedAnswer.map(v => String(v).trim().toLowerCase())
      : [String(submittedAnswer).trim().toLowerCase()];

    if (expectedArr.length !== submittedArr.length) return false;
    const expectedSet = new Set(expectedArr);
    return submittedArr.every(ans => expectedSet.has(ans));
  }

  if (qType === 'open') {
    // Open-ended short text
    const actual = String(submittedAnswer).trim().toLowerCase();
    if (Array.isArray(question.acceptableAnswers)) {
      return question.acceptableAnswers.some(ans => String(ans).trim().toLowerCase() === actual);
    }
    const expected = String(question.correctAnswer).trim().toLowerCase();
    return actual === expected;
  }

  return false;
}

function calculateScore(question, submittedAnswer, timeSpent, timeLimit, currentStreak = 0) {
  const isCorrect = isAnswerCorrect(question, submittedAnswer);
  if (!isCorrect) {
    return {
      isCorrect: false,
      scoreGained: 0,
      newStreak: 0,
      streakBonus: 0,
      timeBonus: 0
    };
  }

  const duration = Math.max(1, timeLimit || question.time || 20);
  const clampedTime = Math.max(0, Math.min(duration, timeSpent));
  // Ratio remaining: 1.0 if instant, 0.0 if right at the buzzer
  const ratio = Math.max(0, 1 - (clampedTime / duration));

  // Base 500 points + up to 500 for speed
  const basePoints = 500;
  const timeBonus = Math.round(500 * ratio);
  const newStreak = currentStreak + 1;
  const streakBonus = newStreak > 1 ? Math.min((newStreak - 1) * 100, 500) : 0;
  const scoreGained = basePoints + timeBonus + streakBonus;

  return {
    isCorrect: true,
    scoreGained,
    newStreak,
    streakBonus,
    timeBonus
  };
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> room object
    this.socketRoomMap = new Map(); // socketId -> code
  }

  createRoom(hostSocketId, hostName = 'Host') {
    const code = generateRoomCode(this.rooms);
    const sanitizedHost = sanitizeText(hostName, 24) || 'Host';
    const room = {
      code,
      hostId: hostSocketId,
      hostName: sanitizedHost,
      status: 'waiting', // waiting, question, reveal, ended
      questions: [],
      currentQuestionIndex: -1,
      questionStartTime: 0,
      questionDuration: 20,
      timerHandle: null,
      participants: new Map(), // socketId -> Participant
      currentAnswers: new Map(), // socketId -> { answer, timeSpent }
      createdAt: Date.now(),
      lastActivity: Date.now()
    };

    this.rooms.set(code, room);
    this.socketRoomMap.set(hostSocketId, code);
    return room;
  }

  getRoom(code) {
    if (!code) return null;
    return this.rooms.get(code.toUpperCase().trim()) || null;
  }

  getRoomBySocketId(socketId) {
    const code = this.socketRoomMap.get(socketId);
    return code ? this.getRoom(code) : null;
  }

  joinRoom(code, socketId, name) {
    const room = this.getRoom(code);
    if (!room) {
      return { error: 'Room not found. Please check your room code.' };
    }
    if (room.status === 'ended') {
      return { error: 'This quiz room has already ended.' };
    }

    const sanitizedName = sanitizeText(name, 20) || `Player ${room.participants.size + 1}`;

    const participant = {
      id: socketId,
      name: sanitizedName,
      score: 0,
      streak: 0,
      highestStreak: 0,
      answers: [],
      connected: true,
      joinedAt: Date.now()
    };

    room.participants.set(socketId, participant);
    this.socketRoomMap.set(socketId, room.code);
    room.lastActivity = Date.now();

    return { ok: true, room, participant };
  }

  leaveRoom(socketId) {
    const room = this.getRoomBySocketId(socketId);
    if (!room) return null;

    this.socketRoomMap.delete(socketId);
    const wasHost = room.hostId === socketId;
    let participant = null;

    if (room.participants.has(socketId)) {
      participant = room.participants.get(socketId);
      participant.connected = false;
      // In waiting lobby, remove participant completely
      if (room.status === 'waiting') {
        room.participants.delete(socketId);
      }
    }

    room.lastActivity = Date.now();

    // If room is empty, clean up
    if (room.participants.size === 0 && (!room.hostId || wasHost)) {
      if (room.timerHandle) clearInterval(room.timerHandle);
      this.rooms.delete(room.code);
      return { roomCode: room.code, empty: true, wasHost };
    }

    return { room, wasHost, participant };
  }

  setQuestions(code, socketId, questions) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found' };
    if (room.hostId !== socketId) return { error: 'Unauthorized: Only host can set questions' };
    if (!Array.isArray(questions) || questions.length === 0) {
      return { error: 'Questions list cannot be empty' };
    }

    const sanitizedQuestions = questions.map((q, idx) => ({
      id: q.id !== undefined ? q.id : idx + 1,
      text: sanitizeText(q.text, 250) || `Question ${idx + 1}`,
      type: ['quiz', 'multi', 'truefalse', 'open'].includes(q.type) ? q.type : 'quiz',
      options: Array.isArray(q.options) ? q.options.map(opt => sanitizeText(String(opt), 100)) : [],
      correctAnswer: q.correctAnswer !== undefined ? q.correctAnswer : '',
      acceptableAnswers: Array.isArray(q.acceptableAnswers) ? q.acceptableAnswers : undefined,
      time: Math.min(120, Math.max(1, parseInt(q.time) || 20)),
      explanation: sanitizeText(q.explanation || '', 300)
    }));

    room.questions = sanitizedQuestions;
    room.lastActivity = Date.now();
    return { ok: true, count: room.questions.length };
  }

  startQuestion(code, socketId, questionIndex = 0) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found' };
    if (room.hostId !== socketId) return { error: 'Unauthorized: Only host can start question' };
    if (room.questions.length === 0) return { error: 'No questions have been configured' };
    if (questionIndex < 0 || questionIndex >= room.questions.length) {
      return { error: 'Invalid question index' };
    }

    if (room.timerHandle) {
      clearInterval(room.timerHandle);
      room.timerHandle = null;
    }

    const q = room.questions[questionIndex];
    room.status = 'question';
    room.currentQuestionIndex = questionIndex;
    room.currentAnswers = new Map();
    room.questionStartTime = Date.now();
    room.questionDuration = q.time || 20;
    room.lastActivity = Date.now();

    // Payload for Host (includes correct answer for display/review)
    const hostPayload = {
      index: questionIndex,
      total: room.questions.length,
      question: {
        id: q.id,
        text: q.text,
        type: q.type,
        options: q.options,
        correctAnswer: q.correctAnswer,
        time: room.questionDuration,
        explanation: q.explanation
      },
      participantCount: room.participants.size
    };

    // Payload for Participants (CHEAT-PROOF: correctAnswer is stripped!)
    const participantPayload = {
      index: questionIndex,
      total: room.questions.length,
      question: {
        id: q.id,
        text: q.text,
        type: q.type,
        options: q.options,
        time: room.questionDuration
      }
    };

    return { ok: true, q, hostPayload, participantPayload };
  }

  recordAnswer(code, socketId, answerData) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found' };
    if (room.status !== 'question') return { error: 'Question is not active for answers' };
    if (!room.participants.has(socketId)) return { error: 'Participant not in room' };
    if (room.currentAnswers.has(socketId)) {
      return { error: 'Already answered this question' };
    }

    const timeSpent = Math.max(0, (Date.now() - room.questionStartTime) / 1000);
    room.currentAnswers.set(socketId, {
      answer: answerData ? answerData.answer : null,
      timeSpent
    });

    room.lastActivity = Date.now();

    const activeParticipantsCount = Array.from(room.participants.values()).filter(p => p.connected).length;
    const allAnswered = room.currentAnswers.size >= Math.max(1, activeParticipantsCount);

    return {
      ok: true,
      allAnswered,
      totalAnswered: room.currentAnswers.size,
      totalParticipants: activeParticipantsCount
    };
  }

  evaluateQuestion(code) {
    const room = this.getRoom(code);
    if (!room || room.status !== 'question') return null;

    if (room.timerHandle) {
      clearInterval(room.timerHandle);
      room.timerHandle = null;
    }

    room.status = 'reveal';
    const q = room.questions[room.currentQuestionIndex];
    const distribution = {};
    if (Array.isArray(q.options)) {
      q.options.forEach(opt => { distribution[opt] = 0; });
    }

    const participantResults = new Map(); // socketId -> result

    room.participants.forEach((participant, socketId) => {
      const record = room.currentAnswers.get(socketId);
      const submittedAnswer = record ? record.answer : null;
      const timeSpent = record ? record.timeSpent : room.questionDuration;

      // Track distribution
      if (submittedAnswer !== null && submittedAnswer !== undefined) {
        if (Array.isArray(submittedAnswer)) {
          submittedAnswer.forEach(ans => {
            distribution[ans] = (distribution[ans] || 0) + 1;
          });
        } else {
          distribution[submittedAnswer] = (distribution[submittedAnswer] || 0) + 1;
        }
      }

      const scoreResult = calculateScore(q, submittedAnswer, timeSpent, room.questionDuration, participant.streak);
      participant.score += scoreResult.scoreGained;
      participant.streak = scoreResult.newStreak;
      participant.highestStreak = Math.max(participant.highestStreak || 0, participant.streak);

      participant.answers.push({
        questionIndex: room.currentQuestionIndex,
        questionId: q.id,
        answer: submittedAnswer,
        timeSpent,
        isCorrect: scoreResult.isCorrect,
        scoreGained: scoreResult.scoreGained
      });

      participantResults.set(socketId, {
        isCorrect: scoreResult.isCorrect,
        scoreGained: scoreResult.scoreGained,
        totalScore: participant.score,
        streak: participant.streak,
        streakBonus: scoreResult.streakBonus,
        timeBonus: scoreResult.timeBonus,
        submittedAnswer
      });
    });

    const leaderboard = this.getLeaderboard(room);
    const isLastQuestion = room.currentQuestionIndex >= room.questions.length - 1;

    // Attach current ranks to participant results
    participantResults.forEach((res, socketId) => {
      const rankItem = leaderboard.find(l => l.id === socketId);
      res.rank = rankItem ? rankItem.rank : 0;
      res.correctAnswer = q.correctAnswer;
      res.explanation = q.explanation;
      res.isLastQuestion = isLastQuestion;
    });

    return {
      question: q,
      distribution,
      leaderboard,
      isLastQuestion,
      participantResults
    };
  }

  getLeaderboard(room) {
    if (!room) return [];
    const list = Array.from(room.participants.values()).map(p => ({
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

  endGame(code, socketId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found' };
    if (socketId && room.hostId !== socketId) {
      return { error: 'Unauthorized: Only host can end game' };
    }

    if (room.timerHandle) {
      clearInterval(room.timerHandle);
      room.timerHandle = null;
    }

    room.status = 'ended';
    const leaderboard = this.getLeaderboard(room);
    const podium = leaderboard.slice(0, 3);

    return { ok: true, leaderboard, podium };
  }

  resetRoom(code, socketId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found' };
    if (room.hostId !== socketId) return { error: 'Unauthorized: Only host can reset room' };

    if (room.timerHandle) {
      clearInterval(room.timerHandle);
      room.timerHandle = null;
    }

    room.status = 'waiting';
    room.currentQuestionIndex = -1;
    room.questionStartTime = 0;
    room.currentAnswers.clear();

    // Reset scores & streaks for all participants
    room.participants.forEach(p => {
      p.score = 0;
      p.streak = 0;
      p.highestStreak = 0;
      p.answers = [];
    });

    return { ok: true, room: this.getPublicRoomData(room, true) };
  }

  getPublicRoomData(room, forHost = false) {
    if (!room) return null;
    const participantsList = Array.from(room.participants.values()).map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      streak: p.streak,
      connected: p.connected
    }));

    return {
      code: room.code,
      hostName: room.hostName,
      status: room.status,
      questionCount: room.questions.length,
      currentQuestionIndex: room.currentQuestionIndex,
      participants: participantsList,
      participantCount: participantsList.length,
      isHost: forHost
    };
  }

  cleanupStaleRooms(maxAgeMs = 1000 * 60 * 60 * 4) { // 4 hours
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      if (now - room.lastActivity > maxAgeMs) {
        if (room.timerHandle) clearInterval(room.timerHandle);
        this.rooms.delete(code);
      }
    }
  }
}

module.exports = {
  RoomManager,
  generateRoomCode,
  isAnswerCorrect,
  calculateScore,
  sanitizeText
};
