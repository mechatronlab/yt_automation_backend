'use strict';

const BASE_VARIANTS = {
  khasi: {
    nga: 'ng',
    kwah: 'kwh',
    phone: 'fone',
    kam: 'km',
    mynta: 'mnta',
    shwa: 'swa',
    tip: 'tp',
    leh: 'le',
    phi: 'fi',
    kum: 'km',
    ban: 'bn',
    don: 'dn',
    kyrkieh: 'kyrkie',
    ieh: 'ie',
    kumno: 'kmno',
    kumne: 'kmne',
    kumta: 'kmta',
    shisha: 'shsha',
    shibun: 'shbn',
    khub: 'khub',
  },
  pnar: {
    nga: 'ng',
    kwah: 'kwh',
    phone: 'fone',
    kam: 'km',
    mynta: 'mnta',
    shwa: 'swa',
    tip: 'tp',
    leh: 'le',
    phi: 'fi',
    uwei: 'uwe',
    shang: 'shng',
    khub: 'khub',
    ym: 'ym',
    ymleh: 'ymle',
  },
  garo: {
    nga: 'ng',
    kwah: 'kwh',
    phone: 'fone',
    kam: 'km',
    mynta: 'mnta',
    tip: 'tp',
    leh: 'le',
    chak: 'chk',
    re: 'r',
    ba: 'ba',
    khub: 'khub',
    sal: 'sal',
  },
  english: {
    you: 'u',
    your: 'ur',
    though: 'tho',
    because: 'bc',
    really: 'rly',
    probably: 'prolly',
    something: 'smth',
    people: 'ppl',
    about: 'abt',
    through: 'thru',
    before: 'b4',
    great: 'gr8',
    okay: 'ok',
    phone: 'fone',
    watching: 'watchin',
    awesome: 'awsome',
    beautiful: 'beautifull',
    definitely: 'def',
    remember: 'rmbr',
    tonight: '2nite',
    love: 'luv',
  },
  hindi: {
    bahut: 'bhot',
    accha: 'acha',
    achha: 'acha',
    nahi: 'nhi',
    yaar: 'yr',
    bilkul: 'bkl',
    phir: 'fir',
    kuch: 'kch',
    dekh: 'dek',
    video: 'vidio',
    mast: 'mst',
    sach: 'such',
    kaise: 'kse',
    kyun: 'kyu',
    phone: 'fone',
    theek: 'thik',
    samajh: 'smjh',
  },
};

const VOICE_SWAP_COUNT = {
  gen_z: [3, 6],
  millennial: [2, 4],
  gen_x: [1, 2],
  boomer: [0, 1],
  neutral: [1, 3],
};

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

function applyCasualShorthand(text, language, voice = 'neutral') {
  const variants = { ...BASE_VARIANTS[language] };
  const entries = Object.entries(variants).filter(
    ([word, typo]) => word.toLowerCase() !== typo.toLowerCase(),
  );
  if (entries.length === 0) return text;

  const [minSwaps, maxSwaps] = VOICE_SWAP_COUNT[voice] || VOICE_SWAP_COUNT.neutral;
  const swapCount = minSwaps + Math.floor(Math.random() * (maxSwaps - minSwaps + 1));
  if (swapCount === 0) return text;

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

function pickShorthandIndices(total, rate, voice = 'neutral') {
  const voiceBoost = {
    gen_z: 1.25,
    millennial: 1.1,
    neutral: 1.0,
    gen_x: 0.7,
    boomer: 0.4,
  };
  const effectiveRate = Math.min(100, rate * (voiceBoost[voice] || 1));
  const count = Math.round((effectiveRate / 100) * total);
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
