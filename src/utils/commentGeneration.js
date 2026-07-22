'use strict';

const { applyCasualShorthand, pickShorthandIndices } = require('./spellingErrors');

const LANGUAGE_LABELS = {
  khasi: 'Khasi',
  pnar: 'Pnar',
  garo: 'Garo',
  english: 'English',
  hindi: 'Hindi',
};

const TONE_LABELS = {
  positive: 'Positive',
  negative: 'Negative',
  neutral: 'Neutral',
};

const VOICE_LABELS = {
  gen_z: 'Gen Z',
  millennial: 'Millennial',
  gen_x: 'Gen X',
  boomer: 'Boomer',
  neutral: 'Neutral',
};

const VOICE_DESCRIPTIONS = {
  gen_z: 'Short, lowercase, text-speak — "ngl", "fr", "lowkey", heavy abbreviations',
  millennial: 'Casual but readable — "lol", "tbh", "honestly", light shorthand',
  gen_x: 'Dry, minimal slang, sarcasm ok, mostly proper spelling',
  boomer: 'Full sentences, proper grammar, polite and straightforward',
  neutral: 'Average commenter — natural mix, no strong generational markers',
};

const LANGUAGE_INSTRUCTIONS = {
  khasi: 'Write in Khasi (Ka Ktien Khasi). Natural conversational Khasi as spoken in Meghalaya — like WhatsApp comments.',
  pnar: 'Write in Pnar (Jaintia). Natural conversational Pnar as spoken in Jaintia Hills.',
  garo: 'Write in Garo (A·chik). Natural conversational Garo as spoken in Garo Hills.',
  english: 'Write in English.',
  hindi: 'Write in Hindi (Devanagari) or natural Hinglish as young Indians comment on YouTube.',
};

const TONE_INSTRUCTIONS = {
  positive: 'Sentiment: enthusiastic, supportive, appreciative.',
  negative: 'Sentiment: critical or skeptical but believable — not abusive or spammy.',
  neutral: 'Sentiment: balanced, curious, or matter-of-fact.',
};

const VOICE_INSTRUCTIONS = {
  gen_z: `Voice: Gen Z (born ~1997–2012). ${VOICE_DESCRIPTIONS.gen_z}. Short comments, internet-native, may use "ngl", "fr", "lowkey", "no cap", "tbh". Lowercase ok. Very casual.`,
  millennial: `Voice: Millennial (born ~1981–1996). ${VOICE_DESCRIPTIONS.millennial}. Relaxed, conversational, relatable.`,
  gen_x: `Voice: Gen X (born ~1965–1980). ${VOICE_DESCRIPTIONS.gen_x}. Understated, dry wit ok.`,
  boomer: `Voice: Boomer (born ~1946–1964). ${VOICE_DESCRIPTIONS.boomer}. Warm, complete thoughts, no internet slang.`,
  neutral: `Voice: Neutral. ${VOICE_DESCRIPTIONS.neutral}.`,
};

function buildSlotPrompt({
  title,
  description = '',
  channelTitle = '',
  transcript = '',
  slots = [],
  accountPersona = '',
  avoidComments = [],
}) {
  const slotLines = slots
    .map((slot, index) => {
      const lang = LANGUAGE_LABELS[slot.language] || slot.language;
      const tone = TONE_LABELS[slot.tone] || slot.tone;
      const voice = VOICE_LABELS[slot.voice] || slot.voice;
      return `${index + 1}. ${lang} | ${tone} | ${voice}
   - ${LANGUAGE_INSTRUCTIONS[slot.language] || LANGUAGE_INSTRUCTIONS.english}
   - ${TONE_INSTRUCTIONS[slot.tone] || TONE_INSTRUCTIONS.positive}
   - ${VOICE_INSTRUCTIONS[slot.voice] || VOICE_INSTRUCTIONS.neutral}`;
    })
    .join('\n');

  return `You generate authentic YouTube video comments. Each comment must match its assigned language, sentiment tone, AND generational voice style.

Video title: "${title}"
Channel: "${channelTitle || 'Unknown'}"
Description excerpt: "${String(description || '').slice(0, 400)}"
Transcript excerpt: "${String(transcript || '').slice(0, 4000) || 'No transcript available. Use title and description.'}"
${accountPersona ? `Commenter persona: ${accountPersona}` : ''}

Avoid making comments similar to these existing comments:
${avoidComments.length ? avoidComments.map((comment) => `- ${comment}`).join('\n') : '- None'}

Generate exactly ${slots.length} comments — one per slot:
${slotLines}

Rules:
- Each comment is 1-3 sentences, relevant to the video topic and transcript when available.
- Write ONLY in the assigned language (no translation notes).
- Match the generational voice — Gen Z sounds different from Boomer.
- Sound human — reference something specific from the video, not generic praise.
- Every comment must be UNIQUE — different opening, angle, and wording. Never repeat the same phrase or structure.
- Vary length and energy across comments (some short reactions, some longer thoughts).
- Do NOT include hashtags, links, or "subscribe" spam.
- Use correct spelling in the JSON output (shorthand/typos are added separately).
- Return exactly ${slots.length} objects in the JSON array — one per slot, in order.
- Return ONLY valid JSON — no markdown fences.

JSON format:
[
  { "text": "comment text", "language": "khasi|pnar|garo|english|hindi", "tone": "positive|negative|neutral", "voice": "gen_z|millennial|gen_x|boomer|neutral" }
]`;
}

function parseGeminiCommentJson(raw = '') {
  const trimmed = String(raw).trim();
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  const jsonStr = jsonMatch ? jsonMatch[0] : trimmed;
  const parsed = JSON.parse(jsonStr);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array from Gemini');
  }
  return parsed;
}

function scoreComment(text = '', tone = 'positive', voice = 'neutral') {
  let score = 78;
  const len = text.length;
  if (len >= 30 && len <= 220) score += 8;
  if (len > 280) score -= 5;
  if (/\b(subscribe|buy now|click here|check out my)\b/i.test(text)) score -= 25;
  if (voice === 'gen_z' && len > 30 && len < 180) score += 3;
  if (tone === 'negative' && !/\b(but|however|though|not sure|disagree|wish)\b/i.test(text)) score -= 3;
  score += Math.floor(Math.random() * 8);
  return Math.min(99, Math.max(60, score));
}

function fallbackTextForSlot(slot, videoTitle = 'this video', index = 0) {
  const title = String(videoTitle).slice(0, 60);
  const variants = {
    english: [
      `The part about ${title} really stood out to me`,
      `ngl this changed how I think about ${title}`,
      `Been looking for something like this — solid breakdown`,
      `Lowkey one of the better takes I've seen on this topic`,
      `Wait the ending actually made me rethink this whole thing`,
    ],
    khasi: [
      `Ka jingbatai ha kane ka video ka long kaba shisha`,
      `Nga kwah ban pyndam ia ka jinglong kaba aiñ ${title}`,
      `Kane ka long kaba sngewbha — kam ju ju sngew ia kane ha YouTube`,
      `Ka jingthmu kaba aiñ ${title} ka long kaba pynshai shisha`,
      `Nga pyndep ba phi la ai ka jingtip kaba bha ha kane ka video`,
    ],
    hindi: [
      `${title} pe jo point uthaya wo actually helpful tha`,
      `Yaar honestly is video ne perspective change kar diya`,
      `Mast explain kiya — saved for later`,
      `Thoda aur depth chahiye tha but overall solid tha`,
      `First time dekh raha hu is channel pe, not bad at all`,
    ],
    pnar: [
      `Ka jingbatai ha kane ka video ka long kaba shisha`,
      `Nga kwah ban pyndam ia ka jinglong kaba aiñ ${title}`,
      `Kane ka long kaba sngewbha ha ka jingpyni`,
    ],
    garo: [
      `Ka jingbatai ha kane ka video ka long kaba shisha`,
      `Nga kwah ban peit shuh ia kane ka video`,
      `Kane ka long kaba sngewbha ha ka jingpyni`,
    ],
  };
  const pool = variants[slot.language] || variants.english;
  return pool[index % pool.length];
}

function processGeneratedComments(items, slots, spellingErrorRate = 0, videoTitle = 'this video') {
  return slots.map((slot, index) => {
    const item = items[index] ?? {};
    const language = item.language || slot.language || 'english';
    const tone = item.tone || slot.tone || 'positive';
    const voice = item.voice || slot.voice || 'neutral';
    let text = String(item.text || '').trim();
    if (!text) {
      text = fallbackTextForSlot(slot, videoTitle, index);
    }

    const shorthandIndices = pickShorthandIndices(1, spellingErrorRate, voice);
    const hasSpellingErrors = shorthandIndices.has(0)
      || (spellingErrorRate >= 50 && Math.random() < 0.5);
    if (hasSpellingErrors) {
      text = applyCasualShorthand(text, language, voice);
    }

    return {
      text,
      language,
      tone,
      voice,
      hasSpellingErrors,
      score: scoreComment(text, tone, voice),
    };
  });
}

function languageLabel(language = 'english') {
  return LANGUAGE_LABELS[language] || 'English';
}

module.exports = {
  LANGUAGE_LABELS,
  TONE_LABELS,
  VOICE_LABELS,
  buildSlotPrompt,
  parseGeminiCommentJson,
  scoreComment,
  processGeneratedComments,
  languageLabel,
};
