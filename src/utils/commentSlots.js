'use strict';

const LANGUAGES = ['khasi', 'pnar', 'garo', 'english', 'hindi'];
const TONES = ['positive', 'negative', 'neutral'];
const VOICES = ['gen_z', 'millennial', 'gen_x', 'boomer', 'neutral'];

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function sumDistribution(dist = {}) {
  return Object.values(dist).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function buildSlotsFromDistribution(dist = {}, keys = [], total = 0) {
  const slots = [];
  keys.forEach((key) => {
    const count = Math.max(0, parseInt(dist[key], 10) || 0);
    for (let i = 0; i < count; i += 1) {
      slots.push(key);
    }
  });
  if (slots.length === total) {
    return shuffle(slots);
  }
  return slots;
}

function validateLanguageDistribution(dist = {}, totalCount = 0) {
  const entries = Object.entries(dist).filter(([, count]) => (count ?? 0) > 0);
  if (entries.length === 0) {
    return 'Select at least one language with a count greater than 0.';
  }
  const sum = sumDistribution(dist);
  if (sum !== totalCount) {
    return `Language counts must add up to ${totalCount} (currently ${sum}).`;
  }
  for (const [lang] of entries) {
    if (!LANGUAGES.includes(lang)) {
      return `Unknown language: ${lang}`;
    }
  }
  return null;
}

function buildLanguageSlots(languageMix = {}) {
  const slots = [];
  for (const lang of LANGUAGES) {
    const count = Math.max(0, parseInt(languageMix[lang], 10) || 0);
    for (let i = 0; i < count; i += 1) {
      slots.push(lang);
    }
  }
  return shuffle(slots);
}

function buildToneSlots(filters = {}, totalCount = 10) {
  if (filters.toneMode === 'single' && filters.tone) {
    return Array.from({ length: totalCount }, () => filters.tone);
  }
  const dist = filters.toneMix || filters.toneDistribution || {
    positive: 4,
    neutral: 4,
    negative: 2,
  };
  const slots = [];
  for (const tone of TONES) {
    const count = Math.max(0, parseInt(dist[tone], 10) || 0);
    for (let i = 0; i < count; i += 1) {
      slots.push(tone);
    }
  }
  return shuffle(slots);
}

function buildVoiceSlots(filters = {}, totalCount = 10) {
  if (filters.voiceMode === 'single' && filters.voice) {
    return Array.from({ length: totalCount }, () => filters.voice);
  }
  const dist = filters.voiceMix || filters.voiceDistribution || {
    gen_z: 4,
    millennial: 3,
    gen_x: 2,
    neutral: 1,
    boomer: 0,
  };
  const slots = [];
  for (const voice of VOICES) {
    const count = Math.max(0, parseInt(dist[voice], 10) || 0);
    for (let i = 0; i < count; i += 1) {
      slots.push(voice);
    }
  }
  return shuffle(slots);
}

function buildCommentSlots(filters = {}, totalCount = 10) {
  const count = totalCount || sumDistribution(filters.languageMix || filters.languageDistribution || {});
  const languages = buildLanguageSlots(filters.languageMix || filters.languageDistribution || {});
  const tones = buildToneSlots(filters, count);
  const voices = buildVoiceSlots(filters, count);
  const len = Math.min(languages.length, tones.length, voices.length, count);
  return Array.from({ length: len }, (_, index) => ({
    language: languages[index],
    tone: tones[index] || 'positive',
    voice: voices[index] || 'neutral',
  }));
}

function defaultGenerationFilters(totalCount = 100) {
  const scale = (parts) => {
    const sum = Object.values(parts).reduce((a, b) => a + b, 0) || 1;
    const scaled = {};
    let used = 0;
    const keys = Object.keys(parts);
    keys.forEach((key, index) => {
      if (index === keys.length - 1) {
        scaled[key] = Math.max(0, totalCount - used);
      } else {
        scaled[key] = Math.round((parts[key] / sum) * totalCount);
        used += scaled[key];
      }
    });
    return scaled;
  };

  return {
    commentCount: totalCount,
    languageMix: scale({ khasi: 5, pnar: 2, garo: 0, english: 3, hindi: 0 }),
    toneMode: 'mixed',
    toneMix: scale({ positive: 4, neutral: 4, negative: 2 }),
    voiceMode: 'mixed',
    voiceMix: scale({ gen_z: 4, millennial: 3, gen_x: 2, neutral: 1, boomer: 0 }),
    textSpeakPercent: 40,
  };
}

module.exports = {
  LANGUAGES,
  TONES,
  VOICES,
  sumDistribution,
  validateLanguageDistribution,
  buildLanguageSlots,
  buildCommentSlots,
  defaultGenerationFilters,
};
