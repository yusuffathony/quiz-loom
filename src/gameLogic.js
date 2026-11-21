/**
 * QuizLoom Game Logic & Scoring (Cloudflare Workers & Node compatible)
 */

export function sanitizeText(str, maxLen = 100) {
  if (!str || typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

export function isAnswerCorrect(question, submittedAnswer) {
  if (!question || submittedAnswer === undefined || submittedAnswer === null) return false;
  const qType = question.type || 'quiz';

  if (qType === 'quiz' || qType === 'truefalse') {
    const expected = String(question.correctAnswer).trim().toLowerCase();
    const actual = String(submittedAnswer).trim().toLowerCase();
    if (expected === actual) return true;

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
    const actual = String(submittedAnswer).trim().toLowerCase();
    if (Array.isArray(question.acceptableAnswers)) {
      return question.acceptableAnswers.some(ans => String(ans).trim().toLowerCase() === actual);
    }
    const expected = String(question.correctAnswer).trim().toLowerCase();
    return actual === expected;
  }

  return false;
}

export function calculateScore(question, submittedAnswer, timeSpent, timeLimit, currentStreak = 0) {
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
  const ratio = Math.max(0, 1 - (clampedTime / duration));

  // 500 base + up to 500 speed bonus + up to 500 streak bonus
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
