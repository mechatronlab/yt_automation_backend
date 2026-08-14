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

const LANGUAGE_INSTRUCTIONS = {
  khasi: 'Write in everyday spoken Khasi (WhatsApp style). Real words only. Proper names/title may stay English.',
  pnar: 'Write in everyday spoken Pnar. Real words only. Proper names may stay English.',
  garo: 'Write in everyday spoken Garo. Real words only. Proper names may stay English.',
  english: 'Write plain everyday English like a normal viewer on their phone.',
  hindi: 'Write Hindi or simple Hinglish like a normal Indian YouTube comment.',
};

// Only add terms confirmed by a fluent Khasi speaker. These corrections take
// precedence over a model's plausible-looking but incorrect translation.
const KHASI_VERIFIED_GLOSSARY = [
  {
    english: ['flight', 'airplane', 'aeroplane'],
    incorrect: ['lieng surok'],
    khasi: 'lieng suin',
  },
];

const TONE_INSTRUCTIONS = {
  positive: 'lean supportive / appreciative, but still specific — not empty praise',
  negative: 'lean skeptical / critical with a reason — not abusive',
  neutral: 'lean observational / curious / matter-of-fact',
};

const COMMENT_STYLES = [
  'react to one concrete moment like it just hit you',
  'ask a slightly messy follow-up question',
  'disagree lightly with one claim, with your own reason',
  'admit you used to think the opposite',
  'point out a small detail and say why it stuck',
  'connect it to something you tried recently',
  'joke lightly about one part without being mean',
  'sound impatient but interested — want the next tip',
];

const PERSONALITY_HINTS = [
  'a bit sarcastic',
  'warm and earnest',
  'quietly skeptical',
  'excited but clumsy with words',
  'dry and understated',
  'chatty and scattered',
  'blunt and short',
  'thoughtful and slow',
];

const BANNED_FILLER_PHRASES = [
  'really stood out',
  'easy to follow',
  'clear explanation',
  'great content',
  'so insightful',
  'thanks for sharing',
  'keep it up',
  'well explained',
  'quality content',
  'learned so much',
  'made me rethink',
  'such a good video',
  'nailed it',
  'looking forward to more',
  'hits different',
  'underrated',
  'saved for later',
  'changed how i think',
  'one of the better takes',
  'as someone who',
  'in today\'s video',
  'this video does a great job',
  'highly recommend',
  'food for thought',
  'game changer',
  'must watch',
  'eye opening',
  'eye-opening',
  'incredibly helpful',
  'truly appreciate',
  'valuable insights',
  'comprehensive overview',
  'well articulated',
  'thought-provoking',
  'thought provoking',
];

const AI_OPENER_PATTERNS = [
  /^this (video|content|upload)\b/i,
  /^i (really |just )?(loved|enjoyed|appreciated|found) (this|the)\b/i,
  /^what (a |an )?(great|amazing|excellent|fantastic|wonderful)\b/i,
  /^absolutely\b/i,
  /^definitely\b/i,
  /^incredibly\b/i,
  /^as someone who\b/i,
  /^one thing (that |i )\b/i,
  /^i couldn't agree more\b/i,
];

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
  [/\blol+\b/gi, ''],
  [/\blmao\b/gi, ''],
  [/\blmfao\b/gi, ''],
  [/\blolz\b/gi, ''],
  [/\bhaha+\b/gi, ''],
  [/\bhehe+\b/gi, ''],
  [/\broom\b/gi, ''],
  [/\bdeadass\b/gi, 'seriously'],
  [/\byeet\b/gi, ''],
  [/\bvibe check\b/gi, ''],
  [/\bw\s+take\b/gi, 'good take'],
  [/\bl\s+take\b/gi, 'bad take'],
  [/\bthis\s+slaps\b/gi, 'this is good'],
  [/\bgoes\s+hard\b/gi, 'is strong'],
];

const ENGLISH_CONTENT_WORDS = [
  // slang / reactions
  'lol', 'lmao', 'lmfao', 'haha', 'hehe', 'omg', 'wow', 'bro', 'dude', 'guys',
  // common AI / comment English
  'claim', 'proof', 'clear', 'explanation', 'especially', 'depth', 'point',
  'interesting', 'video', 'content', 'really', 'stood', 'helpful', 'insight',
  'insights', 'quality', 'recommend', 'overall', 'basically', 'actually',
  'literally', 'awesome', 'amazing', 'great', 'good', 'best', 'better', 'nice',
  'love', 'loved', 'like', 'liked', 'this', 'that', 'with', 'from', 'about',
  'have', 'has', 'had', 'been', 'been', 'been', 'should', 'could', 'would',
  'make', 'makes', 'made', 'need', 'needs', 'wanted', 'want', 'think', 'thought',
  'thanks', 'thank', 'please', 'more', 'much', 'very', 'just', 'also', 'even',
  'still', 'only', 'because', 'before', 'after', 'when', 'where', 'what', 'which',
  'who', 'how', 'why', 'your', 'you', 'the', 'and', 'for', 'not', 'but', 'are',
  'was', 'were', 'been', 'been', 'can', 'will', 'dont', "don't", 'didnt', "didn't",
  'im', "i'm", 'its', "it's", 'thats', "that's", 'theres', "there's",
  'explanation', 'explained', 'explains', 'understand', 'understood', 'learning',
  'learned', 'useful', 'valuable', 'perfect', 'awesome', 'superb', 'excellent',
  'channel', 'subscribe', 'comment', 'comments', 'upload', 'uploaded', 'watch',
  'watching', 'watched', 'part', 'parts', 'time', 'times', 'today', 'finally',
  'honestly', 'seriously', 'totally', 'completely', 'definitely', 'absolutely',
  'especially', 'exactly', 'maybe', 'probably', 'someone', 'something', 'everything',
  'nothing', 'anyone', 'anything', 'people', 'person', 'team', 'teams', 'budget',
  'follow', 'following', 'steps', 'step', 'try', 'tried', 'works',
  'working', 'worked', 'doesnt', "doesn't", 'isnt', "isn't", 'cant', "can't",
  'wait', 'okay', 'ok', 'cool', 'crazy', 'wild', 'fire', 'solid', 'mid',
  'tips', 'video', 'videos',
];

// Khasi particles / common words written in Latin — never treat these as English leaks.
const KHASI_LATIN_ALLOW = new Set([
  'nga', 'ngi', 'phi', 'u', 'ka', 'ki', 'ia', 'na', 'ha', 'ba', 'ban', 'don',
  'ym', 'shuh', 'kaba', 'kane', 'kata', 'kine', 'kito', 'kum', 'kumne', 'kumta',
  'lah', 'dei', 'sngew', 'sngewbha', 'sngewthuh', 'peit', 'pyr', 'pyrkhat',
  'jing', 'jingbatai', 'jingthmu', 'jingtip', 'jingpynshai', 'pynshai', 'pyndep',
  'tip', 'kwah', 'long', 'aiñ', 'ain', 'bha', 'sngi', 'mynta', 'myn', 'shibun',
  'shisha', 'hynrei', 'tang', 'baroh', 'wei', 'ar', 'lai', 'saw',
  'san', 'hynñiew', 'phra', 'khyndai', 'shiphew', 'pyni', 'pyn', 'leh', 'ieid',
  'kren', 'ong', 'thoh', 'peit', 'sngap', 'snip', 'snipang',
]);

const MEGHALAYA_LANGS = new Set(['khasi', 'pnar', 'garo']);

/** Verified Khasi shells + {detail} = concrete bit from the video (kept in quotes). */
const KHASI_FRAMES = {
  positive: [
    'Nga peit ia "{detail}". Ka jingbatai ka sngewbha ia nga.',
    'Ia "{detail}" ka pynshai ia nga.',
    'Nga tip shibun na "{detail}".',
    '"{detail}" — ka long kaba bha.',
    'Nga pyndep ba "{detail}" ka don ka jingaiñ.',
    'Kaba bha ia "{detail}" — nga kwah ban peit shuh.',
    'Nga sngewbha ba phi pyni ia "{detail}".',
    'Kane ha "{detail}" ka long kaba sngewthuh.',
    '"{detail}" ka ai jingtip ia nga.',
    'Nga ieid ia "{detail}" na kane.',
  ],
  neutral: [
    'Nga peit ia "{detail}".',
    'Nga dang pyrkhat shuh ia "{detail}".',
    'Kane ka don "{detail}".',
    'Nga peit ia "{detail}" mynta.',
    'Ha "{detail}" ka jingthmu ka long kaba sngewthuh.',
    'Nga sngap ia "{detail}".',
    '"{detail}" ka long kaba dei ban tip.',
    'Nga dang tip shuh na "{detail}".',
  ],
  negative: [
    'Hynrei lah ban ai shuh ka jingpynshai ha "{detail}".',
    'Nga dang ym sngewthuh shisha ia "{detail}".',
    '"{detail}" ka don, hynrei ka long kaba khiew.',
    'Nga peit ia "{detail}" — hynrei nga dang pyrkhat.',
    'Lah ban pyni shuh ia "{detail}".',
    'Ym sngewthuh shuh ia "{detail}".',
  ],
};

const SAFE_KHASI_FALLBACKS = KHASI_FRAMES.positive.concat(KHASI_FRAMES.neutral);

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'about',
  'this', 'that', 'these', 'those', 'from', 'into', 'your', 'our', 'their',
  'video', 'watch', 'youtube', 'official', 'full', 'new', 'best', 'part',
]);

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

function looksMostlyEnglish(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const tokens = raw
    .split(/[^A-Za-zÀ-ÿ']+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length < 3) return false;
  const khasiMarkers = (raw.match(/\b(nga|ngi|phi|ka|ki|ia|ba|ban|don|kaba|kane|lah|hynrei|pyrkhat|peit|sngew|jing|shuh|kwah|pynshai)\b/gi) || []).length;
  const hindiMarkers = (raw.match(/[\u0900-\u097F]/g) || []).length;
  if (khasiMarkers >= 2 || hindiMarkers >= 2) return false;
  const englishish = tokens.filter((t) => ENGLISH_CONTENT_WORDS.includes(t.toLowerCase()) || /^[a-z]+$/i.test(t)).length;
  return englishish >= Math.ceil(tokens.length * 0.55);
}

/**
 * Everyday English words that must NOT survive inside a Khasi/Pnar/Garo comment.
 * Proper nouns and genuinely technical terms are allowed and stay out of this list.
 */
const ORDINARY_ENGLISH_IN_LOCAL = new Set([
  'voice', 'song', 'songs', 'singer', 'music', 'melody', 'tune', 'vocal', 'vocals',
  'track', 'lyrics', 'words', 'heart', 'soul', 'talent', 'performance', 'sound',
  'beautiful', 'good', 'great', 'nice', 'sweet', 'lovely', 'amazing', 'awesome',
  'perfect', 'strong', 'sad', 'happy', 'proud', 'pure', 'magical', 'gorgeous',
  'incredible', 'breathtaking', 'stunning', 'love', 'like', 'thanks', 'thank',
  'listen', 'hear', 'watch', 'see', 'sing', 'sang', 'singing', 'today', 'again',
  'friends', 'family', 'people', 'everyone', 'part', 'question', 'time', 'video',
  'really', 'very', 'always', 'never', 'best', 'better',
]);

/** True when a local-language comment leans on ordinary English words. */
function meghalayaEnglishOveruse(text = '') {
  const raw = String(text || '');
  const tokens = raw
    .split(/[^A-Za-z']+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const hits = tokens.filter((t) => ORDINARY_ENGLISH_IN_LOCAL.has(t));
  return hits.length >= 2 ? hits : null;
}

/** One focused retry that pushes ordinary English words back into the local language. */
function buildMeghalayaTightenPrompt({ entries = [] }) {
  const lines = entries
    .map((entry, index) => `${index + 1}. language=${entry.language}
   current: "${entry.text}"
   english_words_to_replace: ${entry.offenders.join(', ')}
   meaning_to_keep: "${entry.meaning}"`)
    .join('\n');

  return `These comments left too many ordinary English words in a local-language sentence.
Rewrite each one so the everyday words are in the target language.

${lines}

Rules:
- Replace every listed English word with the normal local word.
- Keep person names, place names, brand names, titles, and true technical terms in English.
- Keep the same meaning and the same sentiment.
- Real words only. Never invent vocabulary.
- One short sentence. No slang, hashtags, or links.

Return ONLY JSON with exactly ${entries.length} objects:
[
  { "text": "rewritten comment", "meaning_en": "plain english meaning" }
]`;
}

function commentTokenSet(text = '') {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9\u0900-\u097F']+/)
      .filter((t) => t.length > 2),
  );
}

/** Share of tokens two comments have in common (0..1). */
function commentOverlap(a = '', b = '') {
  const first = commentTokenSet(a);
  const second = commentTokenSet(b);
  if (first.size === 0 || second.size === 0) return 0;
  let shared = 0;
  first.forEach((token) => {
    if (second.has(token)) shared += 1;
  });
  return shared / Math.min(first.size, second.size);
}

function openingWords(text = '', words = 4) {
  return String(text || '')
    .toLowerCase()
    .split(/\s+/)
    .slice(0, words)
    .join(' ');
}

/**
 * Indices of comments that repeat an earlier one — same opening or heavy word overlap.
 * A batch of near-identical comments reads like a bot even when each line is fine.
 */
function findRepetitiveIndices(items = [], overlapLimit = 0.6) {
  const repeats = [];
  for (let i = 0; i < items.length; i += 1) {
    const text = String(items[i]?.text || '').trim();
    if (!text) continue;
    for (let j = 0; j < i; j += 1) {
      if (repeats.includes(j)) continue;
      const other = String(items[j]?.text || '').trim();
      if (!other) continue;
      const sameOpening = openingWords(text) === openingWords(other);
      if (sameOpening || commentOverlap(text, other) >= overlapLimit) {
        repeats.push(i);
        break;
      }
    }
  }
  return repeats;
}

/** Rewrite pass for comments that echo their siblings. */
function buildVariationPrompt({ entries = [], keyword = '', title = '' }) {
  const lines = entries
    .map((entry, index) => `${index + 1}. language=${entry.language}
   too_similar: "${entry.text}"
   meaning_to_keep: "${entry.meaning}"
   avoid_sounding_like: ${entry.avoid.map((t) => `"${t}"`).join(' | ') || 'n/a'}`)
    .join('\n');

  return `These YouTube comments repeat each other. Rewrite them so each one sounds like a different person.

Video title: "${title}"
${keyword ? `Directions to keep following: "${String(keyword).slice(0, 200)}"` : ''}

${lines}

Rules:
- Keep the same language, same sentiment, and the same core point.
- Change the opening words and the sentence shape. No two may start alike.
- Vary what each one notices: a specific moment, the delivery, a personal reaction, a short question.
- Same language as the original. Do not switch to English.
- Real words only. One short sentence. No slang, hashtags, or links.

Return ONLY JSON with exactly ${entries.length} objects:
[
  { "text": "rewritten comment", "meaning_en": "plain english meaning" }
]`;
}

const DIRECTION_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'about',
  'this', 'that', 'these', 'those', 'from', 'into', 'your', 'our', 'their', 'all',
  'every', 'each', 'comment', 'comments', 'generate', 'write', 'make', 'say',
  'please', 'should', 'must', 'video', 'them', 'they', 'you', 'only', 'just',
]);

/**
 * Words in the directions that describe HOW to comment rather than WHAT about.
 * Sentiment is verified separately, so requiring these to appear in the text
 * only forces comments to parrot the instruction back.
 */
const DIRECTION_INTENT_WORDS = new Set([
  'praise', 'praising', 'compliment', 'appreciate', 'appreciation', 'admire',
  'thank', 'thanks', 'support', 'encourage', 'celebrate', 'congratulate',
  'criticise', 'criticize', 'criticism', 'complain', 'doubt', 'question',
  'ask', 'mention', 'talk', 'discuss', 'sound', 'tone', 'positive', 'negative',
  'neutral', 'good', 'bad', 'great', 'nice', 'beautiful', 'amazing', 'lovely',
  'someone', 'somebody', 'people', 'viewer', 'viewers', 'audience',
]);

/** Near-equivalents so a natural comment is not punished for word choice. */
const DIRECTION_SYNONYMS = {
  singer: ['sing', 'sang', 'voice', 'vocal', 'vocals', 'artist', 'performer'],
  song: ['track', 'music', 'melody', 'tune', 'number'],
  music: ['song', 'track', 'melody', 'tune', 'sound'],
  voice: ['vocal', 'vocals', 'sing', 'sang', 'sound'],
  dance: ['dancing', 'moves', 'choreography', 'steps'],
  recipe: ['cook', 'cooking', 'dish', 'food', 'ingredient'],
  tutorial: ['steps', 'guide', 'explain', 'explained', 'lesson'],
  product: ['item', 'device', 'gadget', 'unit'],
  channel: ['content', 'uploads', 'videos'],
  team: ['squad', 'players', 'side'],
  editing: ['edit', 'cuts', 'transitions'],
};

/** Content words from the user's directions that a comment ought to reflect. */
function directionKeyTerms(keyword = '') {
  return [...new Set(
    String(keyword || '')
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2
        && !DIRECTION_STOP_WORDS.has(w)
        && !DIRECTION_INTENT_WORDS.has(w)),
  )];
}

function textMentionsTerm(text = '', term = '') {
  if (!text || !term) return false;
  if (text.includes(term)) return true;
  // Allow simple morphology: thank/thanks/thanking, share/sharing/shared
  const stem = term.replace(/(ing|ed|es|s)$/, '');
  if (stem.length > 2 && text.includes(stem)) return true;
  return (DIRECTION_SYNONYMS[term] || []).some((alt) => text.includes(alt));
}

/**
 * True when an English draft plausibly carries out the directions.
 * Deliberately lenient: it only checks the subject matter, because sentiment is
 * enforced by draftFightsDirectionSentiment. Being strict here made comments
 * restate the instruction word for word, which read like a template.
 */
function draftFollowsDirections(draftText = '', keyword = '') {
  const terms = directionKeyTerms(keyword);
  if (terms.length === 0) return true;
  const text = String(draftText || '').toLowerCase();
  if (!text) return false;
  return terms.some((term) => textMentionsTerm(text, term));
}

/** Second attempt for slots whose draft ignored the directions. */
function buildDirectionsRepairPrompt({ keyword = '', title = '', count = 1 }) {
  const direction = String(keyword || '').trim().slice(0, 500);
  const intent = inferDirectionSentiment(direction);
  const intentRule = intent === 'positive'
    ? 'These must be PRAISE / THANKS only. No criticism.'
    : intent === 'negative'
      ? 'These must stay CRITICAL as asked. No flipped praise.'
      : 'Match the directions exactly. Do not invent a random tone.';

  return `Your previous comments ignored the instructions. Try again and obey them exactly.

INSTRUCTIONS (must be carried out in every comment):
"""
${direction}
"""

${intentRule}

Video title (for names only): "${title}"

Write exactly ${count} ENGLISH YouTube comments.
Every comment must clearly do what the instructions say.
Do not replace the instruction with generic praise or random criticism about the video.

Rules:
- 8–20 words, one sentence preferred.
- Sound like a real viewer, not an assistant.
- Vary wording slightly between comments, keep the same intent.
- No hashtags, links, or slang like lol/haha.

Return ONLY JSON:
[
  { "text": "english comment that follows the instructions", "tone": "${intent === 'negative' ? 'negative' : intent === 'positive' ? 'positive' : 'neutral'}" }
]`;
}

function meaningLooksRelated(original = '', meaning = '') {
  const a = String(original || '').toLowerCase();
  const b = String(meaning || '').toLowerCase();
  if (!a || !b) return false;
  const wordsA = a.split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  if (wordsA.length === 0) return true;
  const hits = wordsA.filter((w) => b.includes(w)).length;
  return hits >= Math.min(2, wordsA.length);
}

function looksBrokenMeghalaya(text = '') {
  const raw = String(text || '').trim();
  if (!raw || raw.length < 6) return true;
  if (/\blol+\b|\blmao\b|\bhaha+\b|\bhehe+\b/i.test(raw)) return true;

  // Quoted names/titles are fine. Judge the rest.
  const cleaned = raw.replace(/"[^"]*"/g, ' ').trim();
  const tokens = cleaned
    .split(/[^A-Za-zÀ-ÿñÑ·'\-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  const khasiMarkers = (raw.match(/\b(nga|ngi|phi|ka|ki|ia|ba|ban|don|kaba|kane|kata|lah|hynrei|pyrkhat|peit|sngew|jing|tip|bha|shuh|long|kwah|pynshai|sngewbha|sngewthuh|khublei|paralok|nongrwai|jingrwai|minit)\b/gi) || []).length;
  if (tokens.length >= 3 && khasiMarkers === 0) return true;

  let englishHits = 0;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (KHASI_LATIN_ALLOW.has(lower)) continue;
    if (ENGLISH_CONTENT_WORDS.includes(lower)) {
      englishHits += 1;
    }
  }
  // Allow more English loanwords when the sentence clearly has Khasi structure.
  // Reject only when English dominates and Khasi markers are thin.
  const englishShare = tokens.length ? englishHits / tokens.length : 1;
  if (khasiMarkers >= 2 && englishShare <= 0.65) return false;
  if (tokens.length >= 4 && englishHits >= Math.max(4, Math.ceil(tokens.length * 0.55))) return true;
  return false;
}

function stripEnglishFromMeghalaya(text = '') {
  // Preserve quoted video details; strip English only outside quotes.
  const parts = String(text || '').split(/(".*?")/g);
  return parts
    .map((part) => {
      if (part.startsWith('"') && part.endsWith('"')) return part;
      let result = part;
      for (const word of ENGLISH_CONTENT_WORDS) {
        const re = new RegExp(`\\b${word.replace(/'/g, "\\'")}\\b`, 'gi');
        result = result.replace(re, '');
      }
      return result;
    })
    .join('')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,.\s\-–—]+|[,.\s\-–—]+$/g, '')
    .trim();
}

function applyVerifiedKhasiGlossary(text = '') {
  let result = String(text || '');
  for (const entry of KHASI_VERIFIED_GLOSSARY) {
    for (const incorrect of entry.incorrect) {
      const pattern = new RegExp(`\\b${incorrect.replace(/\s+/g, '\\s+')}\\b`, 'gi');
      result = result.replace(pattern, entry.khasi);
    }
  }
  return result;
}

function safeKhasiFallback(index = 0, title = '', detail = '') {
  return fillKhasiFrame(
    SAFE_KHASI_FALLBACKS[index % SAFE_KHASI_FALLBACKS.length],
    title,
    detail || title,
  );
}

function shortTitleForFrame(title = '') {
  return String(title || 'kane')
    .replace(/["']/g, '')
    .trim()
    .slice(0, 42) || 'kane';
}

function cleanDetailPhrase(value = '') {
  let s = String(value || '')
    .replace(/["“”']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 48) {
    s = s.slice(0, 48).replace(/\s+\S*$/, '').trim();
  }
  return s;
}

/**
 * Pull a concrete video-related phrase to embed in Khasi comments.
 */
function extractCommentDetail(englishText = '', title = '', keyword = '') {
  const draft = String(englishText || '').trim();
  const quoted = draft.match(/["“]([^"”]{4,60})["”]/);
  if (quoted) {
    const q = cleanDetailPhrase(quoted[1]);
    if (q.length >= 4) return q;
  }

  let cleaned = draft
    .replace(/^(wait|ok but|ok|hmm|honestly|tbh|yo|dude)\s+/i, '')
    .replace(/\b(lol|lmao|ngl|fr|tho|though)\b/gi, '')
    .split(/(?<=[.!?])\s+/)[0] || draft;
  cleaned = cleanDetailPhrase(cleaned);
  if (cleaned.length >= 8) return cleaned.slice(0, 48);

  const direction = String(keyword || '').trim();
  if (direction && !extractExactPhraseFromDirections(direction)) {
    const dirBit = cleanDetailPhrase(direction).slice(0, 48);
    if (dirBit.length >= 4) return dirBit;
  }

  return shortTitleForFrame(title);
}

function fillKhasiFrame(frame = '', title = '', detail = '') {
  const detailText = cleanDetailPhrase(detail) || shortTitleForFrame(title);
  return String(frame)
    .replace(/\{detail\}/g, detailText)
    .replace(/\{title\}/g, shortTitleForFrame(title))
    .trim();
}

function khasiFramesForTone(tone = 'positive') {
  return KHASI_FRAMES[tone] || KHASI_FRAMES.positive;
}

/**
 * Build Khasi comments from verified shells + concrete video detail from English drafts.
 */
function buildVerifiedKhasiComments(slots = [], title = '', keyword = '', meanings = []) {
  const hasDirections = Boolean(String(keyword || '').trim());
  const titleKey = [...String(title || '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);

  return slots.map((slot, index) => {
    const language = slot.language || 'khasi';
    const tone = hasDirections ? 'neutral' : (slot.tone || 'positive');
    const meaning = String(meanings[index] || '').trim();
    const detail = extractCommentDetail(meaning, title, keyword);
    const bank = hasDirections
      ? KHASI_FRAMES.positive.concat(KHASI_FRAMES.neutral)
      : khasiFramesForTone(tone);
    const frame = bank[(index + titleKey) % bank.length];
    const text = fillKhasiFrame(frame, title, detail);
    return {
      text,
      meaning_en: meaning || detail,
      language,
      tone,
      voice: 'neutral',
    };
  });
}

/**
 * Ask model to pick frame indices only (kept for compatibility).
 */
function buildKhasiFramePickPrompt({ title, meanings = [], frames = [] }) {
  const frameLines = frames
    .map((frame, index) => `${index}. ${fillKhasiFrame(frame, title, title)}`)
    .join('\n');
  const meaningLines = meanings
    .map((m, index) => `${index + 1}. ${String(m || '').slice(0, 160)}`)
    .join('\n');

  return `Pick ONE Khasi frame index for each English meaning.
Do NOT rewrite the Khasi. Only return indices.

Video title: "${title}"

Khasi frames:
${frameLines}

English meanings:
${meaningLines}

Return ONLY JSON:
[ { "i": 0 }, { "i": 3 } ]`;
}

/**
 * Legacy prompt kept for rare mixed/fallback paths — prefer verified frames.
 */
function buildNativeMeghalayaPrompt({
  title,
  description = '',
  channelTitle = '',
  transcript = '',
  slots = [],
  accountPersona = '',
  avoidComments = [],
  keyword = '',
}) {
  const hasDirections = Boolean(String(keyword || '').trim());
  const topicHints = extractTopicHints(title, description, String(transcript).slice(0, 1000));
  const bank = KHASI_FRAMES.positive.concat(KHASI_FRAMES.neutral, KHASI_FRAMES.negative);

  const slotLines = slots
    .map((slot, index) => {
      const toneLine = hasDirections
        ? 'follow user directions; ignore tone filters'
        : `tone: ${TONE_LABELS[slot.tone] || slot.tone}`;
      return `${index + 1}. ${LANGUAGE_LABELS[slot.language] || 'Khasi'} | ${toneLine}`;
    })
    .join('\n');

  return `Copy or lightly rearrange ONLY from the allowed Khasi frames below. Never invent Khasi words. Never add English content words.

Video title: "${title}"
Channel: "${channelTitle || 'Unknown'}"
Topic hints (English — do not paste into comments): ${topicHints.join(', ') || 'from title'}
${accountPersona ? `Persona: ${accountPersona}` : ''}

${buildDirectionBlock(keyword)}

Allowed frames (you may only use these; swap in the short title where needed):
${bank.map((f) => `- ${fillKhasiFrame(f, title, title)}`).join('\n')}

Avoid:
${avoidComments.length ? avoidComments.map((c) => `- ${c}`).join('\n') : '- none'}

Write exactly ${slots.length} comments:
${slotLines}

Return ONLY JSON:
[
  { "text": "one allowed frame", "meaning_en": "plain english", "language": "khasi", "tone": "positive|neutral|negative" }
]`;
}

function extractTopicHints(...parts) {
  const raw = parts.filter(Boolean).join(' ').toLowerCase();
  const words = raw
    .split(/[^a-z0-9]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 10);
}

function looksAiGenerated(text = '') {
  const cleaned = String(text || '').trim();
  if (!cleaned) return true;
  const lower = cleaned.toLowerCase();
  if (BANNED_FILLER_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  if (AI_OPENER_PATTERNS.some((pattern) => pattern.test(cleaned))) return true;
  if (cleaned.length > 220) return true;
  if ((cleaned.match(/[,:;]/g) || []).length >= 4) return true;
  if (/\b(furthermore|moreover|additionally|overall|in conclusion|utilize|leverage)\b/i.test(cleaned)) {
    return true;
  }
  return false;
}

function deAiPolish(text = '') {
  let result = String(text || '').trim();
  result = result
    .replace(/\b(really|truly|incredibly|absolutely|definitely|highly)\s+/gi, '')
    .replace(/\b(great|amazing|excellent|fantastic|wonderful)\s+(video|content|upload|explanation)\b/gi, 'this')
    .replace(/\bas someone who[^.!?]*[.!?]\s*/gi, '')
    .replace(/\bthis video (does a great job|really helps|is so insightful)[^.!?]*[.!?]?\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Prefer one short beat if the model wrote a mini-essay.
  const sentences = result.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 2) {
    result = sentences.slice(0, 2).join(' ');
  }
  if (result.length > 160) {
    result = `${result.slice(0, 157).replace(/\s+\S*$/, '')}…`;
  }
  return result;
}

/**
 * If the user asked for one fixed phrase on every comment, extract that phrase.
 * Example: "only generate long live k party for all the comments" → "long live k party"
 */
function extractExactPhraseFromDirections(keyword = '') {
  const raw = String(keyword || '').trim();
  if (!raw) return null;

  const patterns = [
    /^only\s+generate\s+(.+?)\s+for\s+all(?:\s+the)?\s+comments?\.?$/i,
    /^generate\s+only\s+(.+?)\s+for\s+all(?:\s+the)?\s+comments?\.?$/i,
    /^only\s+(?:use|write|post|say|comment)\s+(.+?)\s+for\s+all(?:\s+the)?\s+comments?\.?$/i,
    /^(?:for\s+)?all(?:\s+the)?\s+comments?\s+(?:should\s+be|must\s+be|exactly(?:\s+be)?|just)\s*:?\s*(.+)$/i,
    /^use\s+(?:this\s+)?(?:exact\s+)?(?:text|phrase|comment)\s+(?:for\s+all(?:\s+the)?\s+comments?\s*)?[:=]?\s*["']?(.+?)["']?$/i,
    /^exactly\s*[:=]\s*["']?(.+?)["']?$/i,
    /^only\s*[:=]\s*["'](.+)["']\s*$/i,
  ];

  for (const re of patterns) {
    const match = raw.match(re);
    if (!match || !match[1]) continue;
    const phrase = match[1]
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(/\s+for\s+all(?:\s+the)?\s+comments?\.?$/i, '')
      .trim();
    if (phrase) return phrase;
  }
  return null;
}

function buildExactPhraseComments(slots = [], phrase = '') {
  const text = String(phrase || '').trim();
  return slots.map((slot) => ({
    text,
    language: slot.language || 'khasi',
    tone: slot.tone || 'positive',
    voice: 'neutral',
    hasSpellingErrors: false,
    score: 99,
  }));
}

function avoidBlock(avoidComments = []) {
  return avoidComments.length
    ? avoidComments.map((c) => `- ${c}`).join('\n')
    : '- none';
}

function sharedHumanRules() {
  return `- Sound like a real YouTube viewer on their phone — not an assistant, not a marketer.
- 8–20 words. One sentence is best; two short ones max.
- Each comment must feel different (different opening / detail).
- No hashtags, links, @mentions, or subscribe spam.
- Never use: lol, lmao, haha, hehe, ngl, fr, no cap, lowkey, rizz, tbh
- Never use empty praise: "great video", "nice content", "thanks for sharing", "so insightful"`;
}

/** Infer the intent locked by Mode 1 directions (tone mix is never used). */
function inferDirectionSentiment(keyword = '') {
  const text = String(keyword || '').toLowerCase();
  if (!text) return 'neutral';
  const praise = /\b(praise|thank|thanks|appreciate|love|congrats|congratulate|support|proud|amazing|beautiful|bless|shout ?out|compliment|good job|well done|kudos)\b/.test(text);
  const critical = /\b(criticize|criticise|hate|roast|attack|negative|complain|bad|worst|trash|dislike|call out|disagree)\b/.test(text);
  if (praise && !critical) return 'positive';
  if (critical && !praise) return 'negative';
  return 'neutral';
}

function draftFightsDirectionSentiment(draftText = '', keyword = '') {
  const intent = inferDirectionSentiment(keyword);
  const text = String(draftText || '').toLowerCase();
  if (!text) return true;
  if (intent === 'positive') {
    return /\b(not good|not great|disappointed|waste|boring|overrated|mid|trash|hate|worst|bad|awful|terrible|don't like|dont like|not sure|doubt|skeptic)\b/.test(text);
  }
  if (intent === 'negative') {
    return /\b(love this|amazing|beautiful|perfect|best ever|so proud|thank you so much)\b/.test(text)
      && !/\b(but|however|though|not)\b/.test(text);
  }
  return false;
}

/**
 * MODE A — directions filled: follow the user's instruction completely.
 * Always draft in ENGLISH. Language conversion happens in a later step.
 * Tone mix (positive/neutral/negative counts) is NEVER used here.
 */
function buildDirectionsDraftPrompt({
  title,
  description = '',
  channelTitle = '',
  transcript = '',
  slots = [],
  accountPersona = '',
  avoidComments = [],
  keyword = '',
}) {
  const direction = String(keyword || '').trim().slice(0, 500);
  const intent = inferDirectionSentiment(direction);
  const intentRule = intent === 'positive'
    ? 'Directions are PRAISE / THANKS / SUPPORT. Every comment must sound supportive. ZERO critical, doubtful, or negative comments.'
    : intent === 'negative'
      ? 'Directions are CRITICAL. Every comment must stay critical as asked. Do not flip into praise.'
      : 'Match the exact emotional intent of the directions. Do not invent a random positive/negative mix.';

  const slotLines = slots
    .map((slot, index) => `${index + 1}. variation ${index + 1}`)
    .join('\n');

  return `You write ENGLISH YouTube comments only.
A later step will translate. Do NOT write Khasi, Pnar, Garo, or Hindi here.

MODE: FOLLOW DIRECTIONS EXACTLY.
The user told you what the comments must do. Obey that. Do not invent a different topic.
Tone mix filters are OFF — ignore positive / neutral / negative counts completely.
${intentRule}

User directions:
"""
${direction}
"""

Video context (only for names / facts the directions need):
Title: "${title}"
Channel: "${channelTitle || 'Unknown'}"
Description: "${String(description || '').slice(0, 220)}"
Captions snippet: "${String(transcript || '').slice(0, 700) || 'none'}"
${accountPersona ? `Account persona: ${accountPersona}` : ''}

Do not copy these old comments:
${avoidBlock(avoidComments)}

Write exactly ${slots.length} ENGLISH comments:
${slotLines}

Rules:
${sharedHumanRules()}
- Every comment must carry out the directions.
- If they want the same message, keep the meaning fixed and only change tiny wording.
- If they want one exact phrase, use that phrase.
- Do NOT add criticism, sarcasm, or doubt unless the directions ask for it.

Return ONLY JSON:
[
  { "text": "english comment", "tone": "${intent === 'negative' ? 'negative' : intent === 'positive' ? 'positive' : 'neutral'}" }
]`;
}

/**
 * MODE B — directions empty: comments come from the video itself + filters.
 * Always draft in ENGLISH. Language conversion happens later.
 */
function buildVideoContextDraftPrompt({
  title,
  description = '',
  channelTitle = '',
  transcript = '',
  slots = [],
  accountPersona = '',
  avoidComments = [],
}) {
  const topicHints = extractTopicHints(title, description, String(transcript).slice(0, 1600));
  const hasTranscript = Boolean(String(transcript || '').trim());
  const slotLines = slots
    .map((slot, index) => `${index + 1}. tone=${slot.tone || 'positive'} | pick a different concrete detail than the others`)
    .join('\n');

  return `You write ENGLISH YouTube comments only.
A later step will translate. Do NOT write Khasi, Pnar, Garo, or Hindi here.

MODE: VIDEO CONTEXT.
No user directions. Comments must be about THIS video specifically.
Use the title, description, and captions. Someone reading the comment should recognize the video.

Title: "${title}"
Channel: "${channelTitle || 'Unknown'}"
Description: "${String(description || '').slice(0, 500)}"
Captions: "${String(transcript || '').slice(0, 3800) || 'none — use title and description only'}"
Useful topic words: ${topicHints.join(', ') || 'from title'}
Transcript available: ${hasTranscript ? 'yes' : 'no'}
${accountPersona ? `Account persona: ${accountPersona}` : ''}

Do not copy these old comments:
${avoidBlock(avoidComments)}

Write exactly ${slots.length} ENGLISH comments:
${slotLines}

Good examples of specificity (invent new ones for THIS video):
- mention a tip, step, claim, name, tool, number, or moment from the captions/title
- ask a real follow-up about that detail
- agree or doubt one specific claim

Bad:
- anything that could sit under a random cooking video
- "this helped a lot" / "great explanation" with no detail

Rules:
${sharedHumanRules()}
- Positive = supportive but specific
- Neutral = curious / observational
- Negative = skeptical with a reason, not rude
- Every comment must include one concrete detail from THIS video.

Return ONLY JSON:
[
  { "text": "english comment about this video", "tone": "positive|neutral|negative" }
]`;
}

function buildEnglishDraftPrompt(args = {}) {
  const hasDirections = Boolean(String(args.keyword || '').trim());
  return hasDirections
    ? buildDirectionsDraftPrompt(args)
    : buildVideoContextDraftPrompt(args);
}

/**
 * Pass 2: put the English meaning into the target language as a postable YouTube comment.
 */
function buildLanguageAdaptPrompt({
  title,
  drafts = [],
  slots = [],
  keyword = '',
}) {
  const hasDirections = Boolean(String(keyword || '').trim());
  const intent = hasDirections ? inferDirectionSentiment(keyword) : null;
  const lines = slots
    .map((slot, index) => {
      const draft = drafts[index] || {};
      const english = String(draft.text || draft.meaning_en || '').trim();
      return `${index + 1}. target_language=${slot.language || 'english'}
   keep_this_english_meaning: "${english}"`;
    })
    .join('\n');

  const needsKhasiFamily = slots.some((s) => MEGHALAYA_LANGS.has(s.language));

  return `Translate each English YouTube comment into the target language.
Keep the SAME meaning and the SAME sentiment. Keep it short and postable.
${hasDirections ? `Mode 1 directions were: "${String(keyword).slice(0, 200)}"
Do NOT change the intent (${intent || 'neutral'}). Praise stays praise. Criticism stays criticism.` : ''}

Video title: "${title}"

${lines}

${needsKhasiFamily ? `Khasi / Pnar / Garo — critical:
- Output must read as that language, spoken style, like a local viewer typed it.
- Keep the same intent as the English (thanks / praise / question / doubt).
- MOST words must be in the local language. English is the exception, not the default.

TRANSLATE these (they have normal everyday local words) — never leave them in English:
voice, song, singer, music, melody, tune, words, heart, beautiful, good, great, nice,
sweet, strong, sad, happy, love, like, thanks, talent, sound, listen, hear, watch, see,
today, again, friends, family, people, everyone, part, question, time.

KEEP IN ENGLISH only for:
  • person names, place names, channel names, brand names, song/video titles
  • modern technical terms with no everyday local word (CRM, lead scoring, software, startup, reminder, link, upload)
  • numbers and units
- If a term is not in that short list, translate it. Do not keep English just to be safe.
- Never invent fake local words. If a real local word does not exist, rephrase the idea more simply.
- Never paste the whole English sentence.

Few-shot (Khasi):
EN: your voice on this song is so beautiful
KHA: Ka sur jong phi ha kane ka jingrwai ka sngewtynnat eh.

EN: huge thanks to the singer, sharing this with my friends
KHA: Khublei shibun ia u nongrwai, ngan pyni ia kane sha ki paralok jong nga.

EN: the budget tip at 4 minutes was the only part I needed
KHA: Ka jingbatai shaphang ka budget ha ka minit kaba saw ka pynshai ia nga.

BAD (do not do this — too much English):
"Ka voice jong phi ha kane ka track ka long kaba good, ka melody ruh ka nice."

Verified Khasi vocabulary — use these exact local terms when the English meaning occurs:
${KHASI_VERIFIED_GLOSSARY.map((entry) => `- ${entry.english.join(' / ')} → ${entry.khasi}; never use ${entry.incorrect.join(' / ')}`).join('\n')}
` : ''}

Hindi: natural Hindi or light Hinglish, same meaning. Keep English terms when they are clearer.
English: return the English cleaned lightly — still human.

Rules:
- 1 sentence preferred, 2 max.
- No meme slang, hashtags, links.
- Every comment must open with different words and use a different sentence shape.
  Do not reuse one template across the batch — these are different viewers, not one person.
- Also return meaning_en: a plain English restatement of YOUR output (for checking).
- Return ONLY JSON with exactly ${slots.length} objects:
[
  { "text": "comment in target language", "meaning_en": "what the comment means in english", "language": "khasi|pnar|garo|english|hindi", "tone": "positive|neutral|negative" }
]`;
}

/** @deprecated kept for callers that still import buildSlotPrompt */
function buildSlotPrompt(args) {
  return buildEnglishDraftPrompt(args);
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

function scoreComment(text = '', tone = 'positive') {
  let score = 78;
  const len = text.length;
  if (len >= 12 && len <= 140) score += 10;
  if (len > 200) score -= 10;
  if (/\b(subscribe|buy now|click here|check out my)\b/i.test(text)) score -= 25;
  if (looksAiGenerated(text)) score -= 15;
  if (tone === 'negative' && !/\b(but|however|though|not sure|disagree|wish|idk)\b/i.test(text)) score -= 3;
  score += Math.floor(Math.random() * 8);
  return Math.min(99, Math.max(60, score));
}

function fallbackTextForSlot(slot, videoTitle = 'this video', index = 0, keyword = '') {
  const title = String(videoTitle).replace(/["']/g, '').slice(0, 40);
  const focus = String(keyword || '').trim().slice(0, 40);
  const topic = focus || title;
  const variants = {
    english: [
      `wait that bit about ${topic} actually helped`,
      `ok but does ${topic} work for tiny teams`,
      `the ${topic} tip was the only part i needed`,
      `tried something like ${topic} before, mixed results`,
      `hmm still not sure about ${topic}`,
    ],
    khasi: [
      `Nga peit ia "${title}". Ka jingbatai ka sngewbha ia nga.`,
      `Ia "${title}" nga tip shibun.`,
      `Kane ha "${title}" ka long kaba bha.`,
      `Nga dang pyrkhat shuh ia "${title}".`,
      `Hynrei lah ban ai shuh ka jingpynshai ha "${title}".`,
    ],
    hindi: [
      `${topic} wala part actually kaam ka tha`,
      `chhote teams ke liye ${topic} mushkil nahi?`,
      `bas wahi tip chahiye thi`,
      `pehle try kiya tha, mixed raha`,
      `thoda doubt hai abhi bhi`,
    ],
    pnar: [
      `Nga peit ia "${title}". Ka jingbatai ka sngewbha ia nga.`,
      `Ia "${title}" nga tip shibun.`,
      `Kane ha "${title}" ka long kaba bha.`,
      `Nga dang pyrkhat shuh ia "${title}".`,
      `Hynrei lah ban ai shuh ka jingpynshai ha "${title}".`,
    ],
    garo: [
      `Anga nina "${title}" — nama`,
      `Ia "${title}"-o dakchakani`,
      `Anga dongipa chanchina ia "${title}"`,
      `Da'al ong'ja ha "${title}"`,
      `"${title}" — anga nina`,
    ],
  };
  const pool = variants[slot.language] || variants.english;
  return pool[index % pool.length];
}

function processGeneratedComments(items, slots, spellingErrorRate = 0, videoTitle = 'this video', keyword = '', options = {}) {
  const exactPhrase = options.exactPhrase || extractExactPhraseFromDirections(keyword);
  if (exactPhrase) {
    return buildExactPhraseComments(slots, exactPhrase);
  }

  const hasDirections = Boolean(String(keyword || '').trim());
  const directionTone = hasDirections ? inferDirectionSentiment(keyword) : null;

  return slots.map((slot, index) => {
    const item = items[index] ?? {};
    // Prefer the language chosen after quality gates (may fall back to english).
    const language = item.language || slot.language || 'khasi';
    const tone = hasDirections
      ? (directionTone || 'neutral')
      : (item.tone || slot.tone || 'positive');
    let text = String(item.text || '').trim();
    if (!text) {
      text = fallbackTextForSlot({ ...slot, language }, videoTitle, index, keyword);
    }

    text = stripGenZSpeak(text);

    if (MEGHALAYA_LANGS.has(language)) {
      if (language === 'khasi') {
        text = applyVerifiedKhasiGlossary(text);
      }
      if (looksBrokenMeghalaya(text)) {
        // Last resort: postable English beats broken local-language text.
        text = String(item.meaning_en || '').trim() || fallbackTextForSlot(
          { ...slot, language: 'english' },
          videoTitle,
          index,
          keyword,
        );
        return {
          text,
          language: 'english',
          tone,
          voice: 'neutral',
          hasSpellingErrors: false,
          score: scoreComment(text, tone),
        };
      }
    } else {
      const polished = deAiPolish(text);
      if (hasDirections) {
        // Never trade a direction-following comment for a generic fallback.
        text = polished || text;
      } else {
        text = polished;
        if (!text || looksAiGenerated(text)) {
          text = fallbackTextForSlot({ ...slot, language: 'english' }, videoTitle, index, keyword);
        }
      }
    }

    let hasSpellingErrors = false;
    if (!MEGHALAYA_LANGS.has(language)) {
      const shorthandIndices = pickShorthandIndices(1, spellingErrorRate, 'neutral');
      hasSpellingErrors = shorthandIndices.has(0)
        || (spellingErrorRate >= 50 && Math.random() < 0.5);
      if (hasSpellingErrors) {
        text = applyCasualShorthand(text, language, 'neutral');
      }
    }

    return {
      text,
      language,
      tone,
      voice: 'neutral',
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
  LANGUAGE_INSTRUCTIONS,
  KHASI_VERIFIED_GLOSSARY,
  MEGHALAYA_LANGS,
  KHASI_FRAMES,
  buildSlotPrompt,
  buildEnglishDraftPrompt,
  buildLanguageAdaptPrompt,
  buildNativeMeghalayaPrompt,
  buildVerifiedKhasiComments,
  buildKhasiFramePickPrompt,
  fillKhasiFrame,
  extractCommentDetail,
  parseGeminiCommentJson,
  scoreComment,
  processGeneratedComments,
  languageLabel,
  stripGenZSpeak,
  deAiPolish,
  looksAiGenerated,
  stripEnglishFromMeghalaya,
  applyVerifiedKhasiGlossary,
  looksBrokenMeghalaya,
  meghalayaEnglishOveruse,
  buildMeghalayaTightenPrompt,
  findRepetitiveIndices,
  buildVariationPrompt,
  looksMostlyEnglish,
  meaningLooksRelated,
  draftFollowsDirections,
  draftFightsDirectionSentiment,
  inferDirectionSentiment,
  directionKeyTerms,
  buildDirectionsRepairPrompt,
  extractExactPhraseFromDirections,
  buildExactPhraseComments,
};
