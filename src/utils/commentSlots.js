'use strict';

const LANGUAGES = ['khasi', 'pnar', 'garo', 'english', 'hindi'];
const TONES = ['positive', 'neutral', 'negative'];
const VOICES = ['neutral', 'millennial', 'gen_x', 'boomer'];

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

function validateToneDistribution(dist = {}, totalCount = 0) {
  const sum = sumDistribution(dist);
  if (sum !== totalCount) {
    return `Positive + neutral + negative counts must add up to ${totalCount} (currently ${sum}).`;
  }
  for (const [tone, count] of Object.entries(dist)) {
    if ((count ?? 0) <= 0) continue;
    if (!TONES.includes(tone)) {
      return `Unknown tone: ${tone}`;
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
    const tone = TONES.includes(filters.tone) ? filters.tone : 'positive';
    return Array.from({ length: totalCount }, () => tone);
  }
  const dist = filters.toneMix || filters.toneDistribution || {
    positive: totalCount,
    negative: 0,
  };
  const slots = [];
  for (const tone of TONES) {
    const count = Math.max(0, parseInt(dist[tone], 10) || 0);
    for (let i = 0; i < count; i += 1) {
      slots.push(tone);
    }
  }
  while (slots.length < totalCount) {
    slots.push('positive');
  }
  return shuffle(slots.slice(0, totalCount));
}

function buildVoiceSlots(filters = {}, totalCount = 10) {
  // Generational voices removed from product controls — keep output natural/neutral.
  if (filters.voiceMode === 'single' && filters.voice && VOICES.includes(filters.voice)) {
    return Array.from({ length: totalCount }, () => filters.voice);
  }
  return Array.from({ length: totalCount }, () => 'neutral');
}

function buildCommentSlots(filters = {}, totalCount = 10) {
  const count = totalCount || sumDistribution(filters.languageMix || filters.languageDistribution || {});
  const languages = buildLanguageSlots(filters.languageMix || filters.languageDistribution || {});
  const tones = buildToneSlots(filters, count);
  const voices = buildVoiceSlots(filters, count);
  const angles = Array.isArray(filters.selectedAngles)
    ? filters.selectedAngles.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const len = Math.min(languages.length, tones.length, voices.length, count);
  return Array.from({ length: len }, (_, index) => ({
    language: languages[index],
    tone: tones[index] || 'positive',
    voice: voices[index] || 'neutral',
    angle: angles.length ? angles[index % angles.length] : null,
  }));
}

function defaultGenerationFilters(totalCount = 10) {
  const positive = Math.ceil(totalCount / 2);
  const neutral = Math.max(0, totalCount - positive);
  return {
    commentCount: totalCount,
    languageMix: { khasi: totalCount, pnar: 0, garo: 0, english: 0, hindi: 0 },
    toneMode: 'mixed',
    toneMix: { positive, neutral, negative: 0 },
    voiceMode: 'single',
    voice: 'neutral',
    voiceMix: { neutral: totalCount },
    textSpeakPercent: 25,
    userIntent: '',
    selectedAngles: [],
  };
}

module.exports = {
  LANGUAGES,
  TONES,
  VOICES,
  sumDistribution,
  validateLanguageDistribution,
  validateToneDistribution,
  buildLanguageSlots,
  buildCommentSlots,
  defaultGenerationFilters,
};
