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
  neutral: 'Neutral',
  negative: 'Negative',
};

const VOICE_LABELS = {
  neutral: 'Natural',
};

const LANGUAGE_INSTRUCTIONS = {
  khasi: `Write a natural Meghalaya YouTube comment in Khasi.
- Meaning must be clear and tied to THIS video (a real detail from title/transcript).
- Real conversational Khasi only — do not invent fake Khasi words.
- Light English is OK for names/titles (how people actually comment), but keep the sentence mostly Khasi.
- Prefer short, everyday phrasing someone would type on their phone.`,
  pnar: 'Write natural conversational Pnar tied to THIS video. Real words only. Light English for names is OK.',
  garo: 'Write natural conversational Garo tied to THIS video. Real words only. Light English for names is OK.',
  english: 'Write plain everyday English like a normal adult viewer. No trendy slang.',
  hindi: 'Write Hindi or simple Hinglish like a normal viewer. No Gen-Z English slang.',
};

const TONE_INSTRUCTIONS = {
  positive: 'Sentiment: supportive or appreciative, but specific — not empty praise.',
  neutral: 'Sentiment: observational / matter-of-fact — neither praise nor criticism.',
  negative: 'Sentiment: critical or skeptical but fair — not abusive.',
};

function resolveTone(...candidates) {
  for (const value of candidates) {
    if (value === 'negative' || value === 'neutral' || value === 'positive') {
      return value;
    }
  }
  return 'positive';
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'about',
  'this', 'that', 'these', 'those', 'from', 'into', 'your', 'our', 'their', 'them',
  'they', 'video', 'watch', 'youtube', 'official', 'full', 'new', 'best', 'part',
  'episode', 'season', 'highlights', 'highlight', 'vs', 'versus',
]);

const GENZ_REPLACEMENTS = [
  [/\bno\s*cap\b/gi, 'honestly'],
  [/\bong\b/gi, 'honestly'],
  [/\bngl\b/gi, 'honestly'],
  [/\bfr\s*fr\b/gi, 'honestly'],
  [/\bfr\s+though\b/gi, 'honestly though'],
  [/\bfr\b/gi, 'honestly'],
  [/\blowkey\b/gi, 'kinda'],
  [/\bhighkey\b/gi, 'really'],
  [/\bit'?s giving\b/gi, 'it feels like'],
  [/\bbussin\b/gi, 'really good'],
  [/\brizz\b/gi, ''],
  [/\bsigma\b/gi, ''],
  [/\bskibidi\b/gi, ''],
  [/\bgyatt\b/gi, ''],
  [/\bdelulu\b/gi, 'unrealistic'],
  [/\bsusp\b/gi, 'suspicious'],
  [/\bikr\b/gi, 'I know'],
  [/\btbh\b/gi, 'to be honest'],
  [/\bimho\b/gi, 'in my opinion'],
  [/\blmao\b/gi, ''],
  [/\blmfao\b/gi, ''],
  [/\blol\b/gi, ''],
  [/\blolz\b/gi, ''],
  [/\broom\b/gi, ''],
  [/\bdeadass\b/gi, 'seriously'],
  [/\byeet\b/gi, ''],
  [/\bvibe check\b/gi, ''],
  [/\bw\s+take\b/gi, 'good take'],
  [/\bl\s+take\b/gi, 'bad take'],
  [/\bthis\s+slaps\b/gi, 'this is good'],
  [/\bgoes\s+hard\b/gi, 'is strong'],
];

function stripGenZSpeak(text = '') {
  let result = String(text);
  for (const [pattern, replacement] of GENZ_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,.\s]+/, '')
    .trim();
}

function extractTopicHints(...parts) {
  const raw = parts.filter(Boolean).join(' ').toLowerCase();
  const words = raw
    .split(/[^a-z0-9]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 10);
}

const COMMENT_STYLES = [
  'react to one concrete moment or claim from the video',
  'ask a real follow-up question about something said/shown',
  'add your own take on one specific point (not generic praise)',
  'call out what surprised you or changed your mind',
  'point out a small detail most people might miss',
  'say what you would try / do next because of this video',
  'politely push back on one claim with a reason',
  'compare this to a common assumption people get wrong',
];

const MID_FILLER_PATTERNS = [
  /really stood out/i,
  /easy to follow/i,
  /clear explanation/i,
  /great content/i,
  /so insightful/i,
  /thanks for (sharing|this|the video)/i,
  /keep (up the good work|it up)/i,
  /well explained/i,
  /quality content/i,
  /learned so much/i,
  /this (video )?helped (me|a lot)/i,
  /made me rethink/i,
  /such a good video/i,
  /nailed it/i,
  /looking forward to more/i,
  /underrated (channel|video|content)/i,
  /hits different/i,
  /without much fluff/i,
  /main point is clear enough/i,
  /lays out the idea/i,
  /ka jingbatai ka clear/i,
  /explanation (was )?clear/i,
  /helpful (video|content)/i,
  /saved for later/i,
];

function looksLikeMidFiller(text = '') {
  const cleaned = String(text || '').trim();
  if (!cleaned) return true;
  return MID_FILLER_PATTERNS.some((pattern) => pattern.test(cleaned));
}

function buildEnglishDraftPrompt({
  title,
  description = '',
  channelTitle = '',
  transcript = '',
  slots = [],
  accountPersona = '',
  avoidComments = [],
  userIntent = '',
  selectedAngles = [],
}) {
  const intent = String(userIntent || '').trim().slice(0, 800);
  const topicHints = extractTopicHints(title, description, String(transcript).slice(0, 1200));

  const slotLines = slots
    .map((slot, index) => {
      const tone = TONE_LABELS[slot.tone] || slot.tone;
      const angle = slot.angle ? ` | angle: ${slot.angle}` : '';
      const style = COMMENT_STYLES[index % COMMENT_STYLES.length];
      return `${index + 1}. Tone: ${tone}${angle}
   Style: ${style}
   Later language: ${LANGUAGE_LABELS[slot.language] || slot.language}`;
    })
    .join('\n');

  return `You write YouTube comments that sound like a real person who actually watched — not a bot, not a brochure.

Video title: "${title}"
Channel: "${channelTitle || 'Unknown'}"
Description excerpt: "${String(description || '').slice(0, 500)}"
Transcript excerpt: "${String(transcript || '').slice(0, 3500) || 'No transcript available. Use title and description.'}"
Concrete topic words to use when natural: ${topicHints.length ? topicHints.join(', ') : 'pull specifics from the title'}
${accountPersona ? `Commenter persona: ${accountPersona}` : ''}
${intent ? `User request (must follow):\n"""${intent}"""\n` : ''}
${Array.isArray(selectedAngles) && selectedAngles.length ? `Preferred angles: ${selectedAngles.join('; ')}\n` : ''}
Avoid repeating these:
${avoidComments.length ? avoidComments.map((c) => `- ${c}`).join('\n') : '- None'}

Write exactly ${slots.length} English comments (drafts), one per slot:
${slotLines}

What "good" looks like:
- Specific: name a moment, claim, tip, scene, or detail from THIS video.
- Human: casual, opinionated, varied openings. Incomplete polish is fine.
- Punchy: 1–2 short sentences. Prefer a sharp take over a polite summary.
- Distinct: each comment should feel like a different person.

Hard bans (these make comments "mid"):
- "really stood out", "easy to follow", "clear explanation", "great content", "so insightful"
- "thanks for sharing", "keep it up", "well explained", "quality content", "learned so much"
- "made me rethink", "such a good video", "nailed it", "looking forward to more"
- Empty praise with no concrete detail
- Gen-Z slang (no cap, ngl, fr, lowkey, lol, rizz, etc.)
- Hashtags, links, subscribe spam, AI brochure tone

Tone guide:
- positive: specific appreciation or agreement (still concrete)
- neutral: observational / curious / matter-of-fact (not praise, not roast)
- negative: fair skepticism with a reason (not abusive)

Return ONLY valid JSON (no markdown fences):
[
  { "text": "specific human english comment", "meaning_en": "same idea in plain english", "tone": "positive|neutral|negative" }
]`;
}

function buildLanguageAdaptPrompt({
  title,
  drafts = [],
  slots = [],
}) {
  const lines = slots
    .map((slot, index) => {
      const draft = drafts[index] || {};
      const english = String(draft.text || draft.meaning_en || '').trim();
      return `${index + 1}. Target: ${LANGUAGE_LABELS[slot.language] || slot.language} | tone: ${slot.tone || 'positive'}
   Keep this meaning: "${english}"`;
    })
    .join('\n');

  return `Adapt these YouTube comments into the target languages.
Keep a clear, simple meaning. Do not invent nonsense.

Video title: "${title}"

${lines}

Language guidance:
- English: light polish only.
- Hindi: natural Hindi/Hinglish a normal viewer would type on their phone.

Rules:
1. Preserve meaning.
2. Match assigned tone.
3. 1–2 short sentences that make sense.
4. No Gen-Z slang.
5. Return ONLY valid JSON with exactly ${slots.length} objects (no markdown fences):
[
  {
    "text": "comment in target language",
    "meaning_en": "plain english meaning",
    "language": "english|hindi",
    "tone": "positive|neutral|negative",
    "voice": "neutral"
  }
]`;
}

function buildNativeCommentPrompt({
  title,
  description = '',
  channelTitle = '',
  transcript = '',
  slots = [],
  accountPersona = '',
  avoidComments = [],
  userIntent = '',
  selectedAngles = [],
}) {
  const intent = String(userIntent || '').trim().slice(0, 800);
  const topicHints = extractTopicHints(title, description, String(transcript).slice(0, 1000));
  const hasKhasi = slots.some((slot) => slot.language === 'khasi');

  const slotLines = slots
    .map((slot, index) => {
      const tone = TONE_LABELS[slot.tone] || slot.tone;
      const angle = slot.angle ? ` | angle idea: ${slot.angle}` : '';
      return `${index + 1}. Language: ${LANGUAGE_LABELS[slot.language] || slot.language} | Tone: ${tone}${angle}`;
    })
    .join('\n');

  const khasiExamples = hasKhasi
    ? `
Good Khasi examples (pattern only — write about THIS video, do not copy blindly):
- "Nga peit ia kane ka video. Ka jingbatai ka sngewbha ia nga."
- "Kane ka video ka pynshai ia nga. Nga tip shibun na ka jingthung."
- "Nga sngewthuh ia ka point. Hynrei nga dang pyrkhat shuh."
- "Ka jingbatai ka don, hynrei lah ban ai shuh ka jingpynshai."

Bad (never do this):
- Mixing English words into Khasi: "Ka claim ia proof ka thin", "especially ka part", "more depth"
- Fake/made-up Khasi words
- Comments that mean nothing when translated
`
    : '';

  return `Write YouTube comments in Meghalaya languages that a real person would type.

Video title: "${title}"
Channel: "${channelTitle || 'Unknown'}"
Description excerpt: "${String(description || '').slice(0, 400)}"
Transcript excerpt: "${String(transcript || '').slice(0, 2500) || 'No transcript. Use title/description.'}"
Topic words (for meaning only — do NOT paste these English words into Khasi text): ${topicHints.join(', ') || 'use title'}
${accountPersona ? `Commenter persona: ${accountPersona}` : ''}
${intent ? `User request:\n"""${intent}"""\n` : ''}
${Array.isArray(selectedAngles) && selectedAngles.length ? `Angles: ${selectedAngles.join('; ')}\n` : ''}
${khasiExamples}
Avoid similar comments:
${avoidComments.length ? avoidComments.map((c) => `- ${c}`).join('\n') : '- None'}

Write exactly ${slots.length} comments:
${slotLines}

Hard rules for Khasi / Pnar / Garo:
1. Write ALMOST ONLY in that language. Allowed English: the video title in quotes, and real proper names (people/places/brands).
2. Do NOT sprinkle English content words (claim, proof, clear, explanation, especially, depth, point, interesting, etc.).
3. Each comment must mean ONE clear idea. If a Khasi speaker reads it, the meaning must be obvious.
4. Also give meaning_en: one simple grammatical English sentence that EXACTLY matches the comment. If meaning_en is unclear, the comment is wrong.
5. Keep sentences short and everyday (WhatsApp style), 1–2 sentences.
6. Match the tone: positive = appreciative, neutral = observational, negative = polite doubt.
7. No Gen-Z slang, hashtags, or spam.
8. Return ONLY valid JSON (no markdown fences):
[
  {
    "text": "comment mostly in target language",
    "meaning_en": "one clear english sentence with the same meaning",
    "language": "khasi|pnar|garo",
    "tone": "positive|neutral|negative",
    "voice": "neutral"
  }
]`;
}

function buildAngleSuggestionPrompt({
  title,
  description = '',
  channelTitle = '',
  transcript = '',
}) {
  return `Analyze this YouTube video and suggest short comment-angle options a user can tap.

Video title: "${title}"
Channel: "${channelTitle || 'Unknown'}"
Description excerpt: "${String(description || '').slice(0, 500)}"
Transcript excerpt: "${String(transcript || '').slice(0, 3000) || 'No transcript available.'}"

Return 5 to 8 concise angle labels.
Each label must be:
- 2 to 5 words
- Specific to THIS video
- Easy to tap as a chip
- No punctuation except spaces/hyphens
- No hashtags, emojis, or slang

Return ONLY valid JSON:
{ "angles": ["...", "..."] }`;
}

function stripModelFences(raw = '') {
  return String(raw || '')
    .replace(/```(?:json|JSON)?/g, '')
    .trim();
}

function extractJsonSlice(raw = '', openChar = '[', closeChar = ']') {
  const cleaned = stripModelFences(raw);
  const start = cleaned.indexOf(openChar);
  const end = cleaned.lastIndexOf(closeChar);
  if (start === -1 || end === -1 || end <= start) {
    return cleaned;
  }
  return cleaned.slice(start, end + 1);
}

function parseGeminiCommentJson(raw = '') {
  const jsonStr = extractJsonSlice(raw, '[', ']');
  const parsed = JSON.parse(jsonStr);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array from Gemini');
  }
  return parsed;
}

function parseGeminiAnglesJson(raw = '') {
  const jsonStr = extractJsonSlice(raw, '{', '}');
  const parsed = JSON.parse(jsonStr);
  const angles = Array.isArray(parsed.angles) ? parsed.angles : [];
  return angles
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

function looksLikeCompleteThought(text = '') {
  const cleaned = String(text || '').trim();
  if (cleaned.length < 12) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  // Reject pure keyword salad / no vowels pattern
  if (!/[aeiou]/i.test(cleaned)) return false;
  // Reject too many commas with tiny tokens
  if ((cleaned.match(/,/g) || []).length >= 3 && words.length <= 8) return false;
  return true;
}

function scoreComment(text = '', tone = 'positive') {
  let score = 72;
  const len = text.length;
  if (len >= 24 && len <= 180) score += 10;
  if (len < 12) score -= 20;
  if (len > 280) score -= 5;
  if (/\?/.test(text)) score += 4;
  if (/\b(subscribe|buy now|click here|check out my)\b/i.test(text)) score -= 25;
  if (looksLikeMidFiller(text)) score -= 18;
  if (/\b(as an ai|delve|testament to|great content|so insightful)\b/i.test(text)) score -= 15;
  if (/\b(ngl|no cap|lowkey|rizz|bussin|skibidi|fr\b|lol)\b/i.test(text)) score -= 25;
  if (tone === 'negative' && !/\b(but|however|though|not sure|disagree|wish|disappoint|issue|problem|weak|missing|proof)\b/i.test(text)) {
    score -= 3;
  }
  score += Math.floor(Math.random() * 8);
  return Math.min(99, Math.max(45, score));
}

function looksLikeGibberish(text = '', language = 'english') {
  const cleaned = String(text).trim();
  if (cleaned.length < 8) return true;
  if (['khasi', 'pnar', 'garo'].includes(language)) {
    if (/\b(lol|lmao|no cap|fr|ngl|lowkey|omg)\b/i.test(cleaned)) return true;
    const tokens = cleaned.split(/\s+/);
    const known = /^(ka|ia|ba|na|u|i|ha|la|le|re|ko|ki|sa|nga|phi|ban|don|tip|leh|kane|kaba|long|bha|sngewbha|jingbatai|pynshai|shisha|shibun|video|part|ending|clear|topic)$/i;
    const weirdShort = tokens.filter((t) => /^[a-z]{2,4}$/i.test(t) && !known.test(t));
    if (weirdShort.length >= 3 && tokens.length <= 8) return true;
  }
  return false;
}

function isVideoRelevant(text = '', meaningEn = '', videoTitle = '', topicHints = []) {
  const hay = `${text} ${meaningEn} ${videoTitle}`.toLowerCase();
  const titleHints = extractTopicHints(videoTitle);
  const pool = [...new Set([...titleHints, ...topicHints])];
  if (pool.length === 0) return true;
  const hits = pool.filter((hint) => hay.includes(hint));
  // Accept if at least one topic hint appears in comment or meaning.
  return hits.length >= 1 || hay.includes(String(videoTitle).toLowerCase().slice(0, 18));
}

function looksMostlyEnglish(text = '', videoTitle = '') {
  const cleaned = String(text || '').trim();
  if (!cleaned) return true;

  // Strip quoted title so title English doesn't trigger false positives.
  const title = String(videoTitle || '').trim();
  let withoutTitle = cleaned;
  if (title) {
    withoutTitle = withoutTitle.split(title).join(' ');
  }
  withoutTitle = withoutTitle.replace(/"[^"]*"/g, ' ');

  const words = withoutTitle
    .toLowerCase()
    .split(/[^a-z0-9']+/i)
    .map((w) => w.trim())
    .filter((w) => w.length > 1);
  if (words.length < 3) return false;

  const allowedLoan = new Set(['video', 'youtube', 'ok', 'okay', 'wow', 'part']);
  const commonEn = new Set([
    'the', 'and', 'is', 'are', 'was', 'were', 'this', 'that', 'really', 'about',
    'with', 'from', 'have', 'been', 'just', 'like', 'good', 'great', 'clear',
    'point', 'made', 'think', 'explanation', 'stood', 'ending', 'needed', 'more',
    'proof', 'interesting', 'take', 'easy', 'follow', 'especially', 'but', 'not',
    'sure', 'still', 'watch', 'watching', 'honestly', 'makes', 'sense', 'claim',
    'depth', 'section', 'argument', 'solid', 'unexpected', 'clicked', 'receipts',
    'conclusion', 'thin', 'skates', 'buying', 'feeling', 'covers', 'noted',
    'before', 'after', 'because', 'would', 'could', 'should', 'their', 'there',
    'what', 'when', 'where', 'which', 'while', 'into', 'over', 'under', 'also',
  ]);

  const nativeMarkers = words.filter((w) =>
    /^(ka|ia|ba|nga|phi|kane|kaba|long|bha|sngewbha|sngewthuh|jingbatai|jingthung|jingpynshai|pynshai|shisha|shibun|hynrei|don|tip|ban|leh|ki|ko|u|ha|la|re|sa|ym|dang|pyrkhat|khmih|peit|iathuh|lynti)$/i.test(w)
  ).length;

  const englishHits = words.filter((w) => commonEn.has(w) && !allowedLoan.has(w)).length;
  const contentEnglish = words.filter((w) =>
    w.length >= 4
    && !allowedLoan.has(w)
    && !/^(ka|ia|ba|nga|phi|kane|kaba|long|bha|don|tip|ban|leh|hynrei|shisha|shibun)$/i.test(w)
    && commonEn.has(w)
  ).length;

  if (englishHits >= 3) return true;
  if (contentEnglish >= 2) return true;
  if (nativeMarkers === 0 && englishHits >= 1) return true;
  if (words.length >= 6 && nativeMarkers < 2 && englishHits >= 1) return true;
  return false;
}

function meaningIsCoherent(meaningEn = '') {
  const meaning = String(meaningEn || '').trim();
  if (!meaning) return false;
  if (!looksLikeCompleteThought(meaning)) return false;
  if (looksLikeMidFiller(meaning)) return false;
  // Reject meaning that is just keyword glue
  if ((meaning.match(/,/g) || []).length >= 2 && meaning.split(/\s+/).length <= 10) return false;
  if (!/^[A-Za-z0-9"']/.test(meaning)) return false;
  return true;
}

function fallbackTextForSlot(slot, videoTitle = 'this video', index = 0) {
  const title = String(videoTitle).replace(/"/g, '').slice(0, 60) || 'kane ka video';

  const positive = {
    english: [
      `That moment in "${title}" actually made the idea click for me`,
      `Didn't expect "${title}" to put it that plainly — good call`,
      `The way "${title}" framed it is stuck in my head now`,
    ],
    hindi: [
      `"${title}" mein jo baat boli, woh seedhi aur strong lagi`,
      `Is video ne point clear kar diya — simple language mein`,
    ],
    khasi: [
      `Nga peit ia "${title}". Ka jingbatai ka sngewbha ia nga.`,
      `Kane ka video "${title}" ka pynshai ia nga. Nga tip shibun.`,
      `Nga sngewthuh ia ka point ha "${title}". Ka long kaba bha.`,
    ],
    pnar: [
      `Nga peit ia "${title}". Ka jingbatai ka sngewbha ia nga.`,
      `Kane ka video "${title}" ka pynshai ia nga.`,
    ],
    garo: [
      `Nga peit ia "${title}". Ka jingbatai ka sngewbha ia nga.`,
      `Kane ka video "${title}" ka pynshai ia nga.`,
    ],
  };
  const neutral = {
    english: [
      `So "${title}" is mainly arguing one idea — need to sit with that`,
      `Watched "${title}". The core point is clear; still thinking on it`,
    ],
    hindi: [
      `"${title}" ka main point samajh aa gaya — ab soch raha hoon`,
      `Video dekh li. Baat seedhi hai, zyada drama nahi`,
    ],
    khasi: [
      `Nga peit ia "${title}". Ka point ka don, nga dang pyrkhat.`,
      `Ha "${title}" ka jingbatai ka long kaba plain. Nga tip.`,
      `Nga khmih ia "${title}". Nga tip ia ka jingthung, hynrei nga dang pyrkhat shuh.`,
    ],
    pnar: [
      `Nga peit ia "${title}". Ka point ka don, nga dang pyrkhat.`,
    ],
    garo: [
      `Nga peit ia "${title}". Ka point ka don, nga dang pyrkhat.`,
    ],
  };
  const negative = {
    english: [
      `Not fully convinced by "${title}" yet — needs a stronger case`,
      `"${title}" raises the point, but leaves the hard part thin`,
    ],
    hindi: [
      `"${title}" mein point hai, lekin proof kam laga`,
      `Baat adhoori si lagi — aur depth chahiye thi`,
    ],
    khasi: [
      `Nga peit ia "${title}". Ka jingbatai ka don, hynrei ka jingpynshai ka duna.`,
      `Ha "${title}" nga tip ia ka point, hynrei nga ym sngewthuh shisha.`,
      `Kane ka video "${title}" ka don ka jingthung, hynrei lah ban ai shuh ka jingpynshai.`,
    ],
    pnar: [
      `Nga peit ia "${title}". Ka jingbatai ka don, hynrei ka jingpynshai ka duna.`,
    ],
    garo: [
      `Nga peit ia "${title}". Ka jingbatai ka don, hynrei ka jingpynshai ka duna.`,
    ],
  };
  const pools = slot.tone === 'negative' ? negative : slot.tone === 'neutral' ? neutral : positive;
  const pool = pools[slot.language] || pools.english;
  return pool[index % pool.length];
}

function fallbackMeaningForSlot(slot, videoTitle = 'this video') {
  const title = String(videoTitle).replace(/"/g, '').slice(0, 60) || 'this video';
  if (slot.tone === 'negative') {
    return `I watched "${title}" and the explanation still feels incomplete.`;
  }
  if (slot.tone === 'neutral') {
    return `I watched "${title}" and I understand the point, but I am still thinking about it.`;
  }
  return `I watched "${title}" and the explanation made sense to me.`;
}

function reflectsUserIntent(text = '', intent = '') {
  const cleanedIntent = String(intent || '').trim();
  if (!cleanedIntent) return true;
  const words = cleanedIntent
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  if (words.length === 0) return true;
  const hay = String(text).toLowerCase();
  const hits = words.filter((w) => hay.includes(w));
  return hits.length >= Math.max(1, Math.ceil(words.length * 0.2));
}

function processGeneratedComments(items, slots, spellingErrorRate = 0, videoTitle = 'this video', userIntent = '') {
  const intent = String(userIntent || '').trim();
  const topicHints = extractTopicHints(videoTitle);
  const nativeLangs = new Set(['khasi', 'pnar', 'garo']);
  return slots.map((slot, index) => {
    const item = items[index] ?? {};
    const language = slot.language || item.language || 'english';
    const tone = resolveTone(slot.tone, item.tone);
    const voice = 'neutral';
    let meaningEn = String(item.meaning_en || item.meaningEn || '').trim();
    let text = String(item.text || '').trim();

    const mixedEnglish = nativeLangs.has(language) && looksMostlyEnglish(text, videoTitle);
    const badMeaning = nativeLangs.has(language) && !meaningIsCoherent(meaningEn);
    const senseSource = language === 'english' || language === 'hindi' ? text : meaningEn;
    const weak =
      !text
      || mixedEnglish
      || badMeaning
      || looksLikeGibberish(text, language)
      || looksLikeMidFiller(text)
      || !looksLikeCompleteThought(senseSource || text)
      || !reflectsUserIntent(`${text} ${meaningEn}`, intent)
      || !isVideoRelevant(text, meaningEn, videoTitle, topicHints);

    if (weak) {
      text = fallbackTextForSlot({ ...slot, tone, language }, videoTitle, index);
      meaningEn = fallbackMeaningForSlot({ ...slot, tone, language }, videoTitle);
    }

    text = stripGenZSpeak(text);

    const allowMisspell = language === 'english' || language === 'hindi';
    const shorthandIndices = pickShorthandIndices(1, allowMisspell ? spellingErrorRate : 0);
    const hasSpellingErrors = allowMisspell && (
      shorthandIndices.has(0)
      || (spellingErrorRate >= 50 && Math.random() < 0.45)
    );
    if (hasSpellingErrors) {
      text = applyCasualShorthand(text, language);
      text = stripGenZSpeak(text);
    }

    if (
      looksLikeGibberish(text, language)
      || (nativeLangs.has(language) && looksMostlyEnglish(text, videoTitle))
      || (nativeLangs.has(language) && !meaningIsCoherent(meaningEn))
      || looksLikeMidFiller(text)
      || text.length < 8
      || !looksLikeCompleteThought(language === 'english' || language === 'hindi' ? text : (meaningEn || text))
      || !reflectsUserIntent(`${text} ${meaningEn}`, intent)
      || !isVideoRelevant(text, meaningEn, videoTitle, topicHints)
    ) {
      text = fallbackTextForSlot({ ...slot, tone, language }, videoTitle, index);
      meaningEn = fallbackMeaningForSlot({ ...slot, tone, language }, videoTitle);
    }

    return {
      text,
      language,
      tone,
      voice,
      angle: slot.angle || null,
      meaningEn: meaningEn || null,
      hasSpellingErrors,
      score: scoreComment(text, tone),
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
  buildEnglishDraftPrompt,
  buildLanguageAdaptPrompt,
  buildNativeCommentPrompt,
  buildAngleSuggestionPrompt,
  parseGeminiCommentJson,
  parseGeminiAnglesJson,
  scoreComment,
  processGeneratedComments,
  stripGenZSpeak,
  looksLikeCompleteThought,
  looksMostlyEnglish,
  meaningIsCoherent,
  languageLabel,
};
