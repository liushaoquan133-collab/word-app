/* 单词本 · 间隔重复算法（SM-2 简化版，接近墨墨的三档回忆） */
(function (root, factory) {
  var SRS = factory();
  root.SRS = SRS;
  if (typeof module !== 'undefined' && module.exports) module.exports = SRS;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MIN = 60 * 1000;
  var DAY = 24 * 60 * MIN;
  var MAX_INTERVAL = 365;
  var MASTER_DAYS = 60;

  var RATING = { again: 'again', hard: 'hard', good: 'good' };

  function newWord(text, meaning, phonetic, tag) {
    return {
      id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      w: String(text || '').trim(),
      meaning: String(meaning || '').trim(),
      phonetic: String(phonetic || '').trim(),
      tag: String(tag || '').trim(),
      created: Date.now(),
      state: 'new',
      due: Date.now(),
      interval: 0,
      ease: 2.5,
      reps: 0,
      lapses: 0,
      suspended: false,
      history: []
    };
  }

  function review(word, rating, now) {
    now = now || Date.now();
    word.reps = (word.reps || 0) + 1;
    word.lastReview = now;
    word.ease = word.ease || 2.5;

    if (rating === RATING.again) {
      word.lapses = (word.lapses || 0) + 1;
      word.ease = Math.max(1.3, word.ease - 0.2);
      word.interval = 0;
      word.state = 'learning';
      word.due = now + (word.reps === 1 ? 1 : 10) * MIN;
    } else if (rating === RATING.hard) {
      word.ease = Math.max(1.3, word.ease - 0.05);
      if (word.state === 'new' || word.interval < 1) {
        word.interval = 0;
        word.state = 'learning';
        word.due = now + 10 * MIN;
      } else {
        word.interval = Math.max(1, Math.round(word.interval * 1.2));
        word.state = 'review';
        word.due = now + word.interval * DAY;
      }
    } else {
      word.ease = Math.min(3.0, word.ease + 0.05);
      if (word.state === 'new' || word.state === 'learning' || word.interval < 1) {
        word.interval = 1;
      } else {
        word.interval = Math.min(MAX_INTERVAL, Math.max(1, Math.round(word.interval * word.ease)));
      }
      word.state = word.interval >= MASTER_DAYS ? 'mastered' : 'review';
      word.due = now + word.interval * DAY;
    }

    word.history = word.history || [];
    word.history.push({ t: now, r: rating });
    if (word.history.length > 60) word.history.shift();
    return word;
  }

  function isDue(word, now) {
    now = now || Date.now();
    return !word.suspended && word.state !== 'new' && word.due <= now;
  }

  function isLearningStep(word, now) {
    now = now || Date.now();
    return !word.suspended && word.state === 'learning' && word.due <= now;
  }

  function nextText(word, now) {
    now = now || Date.now();
    var ms = Math.max(0, word.due - now);
    if (ms < 60 * MIN) return Math.max(1, Math.round(ms / MIN)) + ' 分钟后';
    if (ms < 2 * DAY) return Math.round(ms / DAY) + ' 天后';
    if (ms < 30 * DAY) return Math.round(ms / DAY) + ' 天后';
    if (ms < 365 * DAY) return Math.round(ms / (30 * DAY)) + ' 个月后';
    return '一年后';
  }

  function levelOf(word) {
    if (word.suspended) return 'paused';
    if (word.state === 'new') return 'new';
    if (word.state === 'learning') return 'learning';
    if (word.state === 'mastered') return 'mastered';
    return 'review';
  }

  function levelName(l) {
    return { new: '新词', learning: '学习中', review: '复习中', mastered: '已掌握', paused: '已暂停' }[l] || l;
  }

  return {
    MIN: MIN,
    DAY: DAY,
    RATING: RATING,
    newWord: newWord,
    review: review,
    isDue: isDue,
    isLearningStep: isLearningStep,
    nextText: nextText,
    levelOf: levelOf,
    levelName: levelName
  };
});
