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
  // Tone filters apply ONLY when the user did not provide directions.
  const hasDirections = Boolean(String(filters.keyword || '').trim());
  if (hasDirections) {
    // Mode 1: ignore Positive/Neutral/Negative mix entirely.
    return Array.from({ length: totalCount }, () => 'neutral');
  }
  if (filters.toneMode === 'single' && filters.tone) {
    return Array.from({ length: totalCount }, () => filters.tone);
  }
  const dist = filters.toneMix || filters.toneDistribution || {
    positive: totalCount,
    neutral: 0,
    negative: 0,
  };
  const slots = [];
  for (const tone of TONES) {
    const count = Math.max(0, parseInt(dist[tone], 10) || 0);
    for (let i = 0; i < count; i += 1) {
      slots.push(tone);
    }
  }
  // If user left all tones at 0, don't invent a mix — default all positive.
  if (slots.length === 0) {
    return Array.from({ length: totalCount }, () => 'positive');
  }
  return shuffle(slots);
}

function buildVoiceSlots(filters = {}, totalCount = 10) {
  // Generational voice styles removed from the product — always neutral.
  if (filters.voiceMode === 'single' || filters.voice) {
    return Array.from({ length: totalCount }, () => filters.voice || 'neutral');
  }
  return Array.from({ length: totalCount }, () => 'neutral');
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
    languageMix: { khasi: totalCount, pnar: 0, garo: 0, english: 0, hindi: 0 },
    toneMode: 'mixed',
    toneMix: { positive: totalCount, neutral: 0, negative: 0 },
    voiceMode: 'single',
    voice: 'neutral',
    voiceMix: { gen_z: 0, millennial: 0, gen_x: 0, boomer: 0, neutral: totalCount },
    textSpeakPercent: 25,
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
