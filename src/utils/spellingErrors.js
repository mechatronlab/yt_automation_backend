'use strict';

// Mild typos + phone-style short forms. Avoid Gen-Z slang (lol, ngl, no cap, etc.).
const BASE_VARIANTS = {
  english: {
    // Common typos
    beautiful: 'beautifull',
    definitely: 'definately',
    separate: 'seperate',
    weird: 'wierd',
    until: 'untill',
    received: 'recieved',
    occurred: 'occured',
    successful: 'succesful',
    beginning: 'begining',
    environment: 'enviroment',
    necessary: 'neccessary',
    interesting: 'intersting',
    explanation: 'explaination',
    comparison: 'comparision',
    thought: 'thoguht',
    watching: 'watchng',
    // Short forms / texting
    what: 'wht',
    which: 'wch',
    when: 'whn',
    where: 'whr',
    that: 'tht',
    this: 'ths',
    with: 'w',
    without: 'w/o',
    you: 'u',
    your: 'ur',
    youre: 'ure',
    "you're": 'ure',
    are: 'r',
    because: 'bc',
    before: 'b4',
    about: 'abt',
    though: 'tho',
    through: 'thru',
    people: 'ppl',
    please: 'pls',
    thanks: 'thx',
    thank: 'thx',
    something: 'smth',
    someone: 'sm1',
    anyone: 'any1',
    everyone: 'every1',
    nothing: 'nothin',
    everything: 'everythin',
    tomorrow: 'tmrw',
    today: '2day',
    tonight: '2nite',
    really: 'rly',
    probably: 'prolly',
    going: 'goin',
    between: 'btwn',
    should: 'shld',
    would: 'wld',
    could: 'cld',
    have: 'hv',
    just: 'jst',
    from: 'frm',
    them: 'thm',
    okay: 'ok',
    right: 'rite',
    know: 'kno',
  },
  hindi: {
    bahut: 'bhot',
    accha: 'acha',
    achha: 'acha',
    nahi: 'nhi',
    phir: 'fir',
    kuch: 'kch',
    theek: 'thik',
    samajh: 'smjh',
    video: 'vidio',
    kyunki: 'kyuki',
    mujhe: 'mujhe',
    aap: 'ap',
    please: 'pls',
    thanks: 'thx',
  },
  // Native languages: keep empty — aggressive shortening often creates gibberish.
  khasi: {},
  pnar: {},
  garo: {},
};

const SWAP_RANGE = [1, 3];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function preserveCase(original, replacement) {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function applyCasualShorthand(text, language) {
  const variants = { ...(BASE_VARIANTS[language] || {}) };
  const entries = Object.entries(variants).filter(
    ([word, typo]) => word.toLowerCase() !== typo.toLowerCase(),
  );
  if (entries.length === 0) return text;

  const [minSwaps, maxSwaps] = SWAP_RANGE;
  const swapCount = minSwaps + Math.floor(Math.random() * (maxSwaps - minSwaps + 1));
  if (swapCount <= 0) return text;

  const applicable = entries.filter(([word]) => {
    const re = new RegExp(`\\b${escapeRegex(word)}\\b`, 'i');
    return re.test(text);
  });
  if (applicable.length === 0) return text;

  const shuffled = [...applicable].sort(() => Math.random() - 0.5);
  const toApply = shuffled.slice(0, Math.min(swapCount, shuffled.length));

  let result = text;
  for (const [word, typo] of toApply) {
    const re = new RegExp(`\\b${escapeRegex(word)}\\b`, 'gi');
    result = result.replace(re, (match) => preserveCase(match, typo));
  }

  return result;
}

function pickShorthandIndices(total, rate) {
  const count = Math.round((Math.min(100, Math.max(0, rate)) / 100) * total);
  const indices = new Set();
  if (count <= 0 || total <= 0) return indices;

  const pool = Array.from({ length: total }, (_, index) => index);
  for (let i = 0; i < Math.min(count, total); i += 1) {
    const pick = Math.floor(Math.random() * pool.length);
    indices.add(pool[pick]);
    pool.splice(pick, 1);
  }
  return indices;
}

module.exports = {
  applyCasualShorthand,
  pickShorthandIndices,
};
