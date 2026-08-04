const GoogleAccount = require('../models/GoogleAccount');
const User = require('../models/User');
const { postCommentForAccount } = require('../services/youtubeService');
const VpnProfile = require('../models/VpnProfile');
const openvpnService = require('../services/openvpnService');
const { generateObjectId } = require('../db/objectId');

/**
 * Extracts a YouTube video ID from various URL formats.
 * Supports: youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, youtube.com/embed/
 */
const extractVideoId = (url) => {
  if (!url) return null;

  const patterns = [
    /(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
};

/**
 * Returns a random delay between min and max (in milliseconds).
 */
const randomDelay = (minMs = 2000, maxMs = 5000) => {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// @desc    Post comments on a YouTube video from all connected accounts
// @route   POST /api/comments/post
// @access  Private
const postCommentsOnVideo = async (req, res, next) => {
  try {
    const { videoUrl, comments, accountComments } = req.body;

    if (!videoUrl) {
      res.status(400);
      throw new Error('Please provide a YouTube video URL');
    }

    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      res.status(400);
      throw new Error('Invalid YouTube URL. Could not extract video ID.');
    }

    let activeAccountComments = {};

    if (accountComments && typeof accountComments === 'object') {
      for (const [accId, commentText] of Object.entries(accountComments)) {
        if (commentText && commentText.trim() !== '') {
          activeAccountComments[accId] = commentText.trim();
        }
      }
    } else if (comments && Array.isArray(comments) && comments.length > 0) {
      // Fallback/backward compatibility for global comment pool
      const allAccounts = await GoogleAccount.find({
        user: req.user._id,
        status: 'connected',
      });
      const shuffled = [...comments].sort(() => Math.random() - 0.5);
      let commentPool = [...shuffled];
      for (const acc of allAccounts) {
        if (commentPool.length === 0) {
          commentPool = [...comments].sort(() => Math.random() - 0.5);
        }
        activeAccountComments[acc._id.toString()] = commentPool.shift();
      }
    }

    const accountIds = Object.keys(activeAccountComments);
    if (accountIds.length === 0) {
      res.status(400);
      throw new Error('Please enter a comment for at least one account');
    }

    // Fetch accounts matching the IDs
    const accounts = await GoogleAccount.find({
      _id: { $in: accountIds },
      user: req.user._id,
      status: 'connected',
    });

    if (!accounts.length) {
      res.status(400);
      throw new Error('No valid connected Google accounts found for the provided comments.');
    }

    const results = [];

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const commentText = activeAccountComments[account._id.toString()];

      let vpnProfile = null;
      let vpnConnected = false;
      let vpnWarning = null;

      try {
        // Find VPN Profile for the current account
        vpnProfile = await VpnProfile.findOne({ googleAccount: account._id });

        if (vpnProfile) {
          console.log(`[postComments] Connecting to VPN for account ${account.email}...`);
          try {
            await openvpnService.disconnectAll();
            await openvpnService.connect(vpnProfile);
            vpnConnected = true;
            await new Promise(r => setTimeout(r, 3000));
          } catch (vpnErr) {
            vpnWarning = `VPN skipped: ${vpnErr.message}`;
            console.warn(`[postComments] ${vpnWarning} — posting comment without VPN for ${account.email}`);
          }
        }

        const posted = await postCommentForAccount(account, videoId, commentText);

        const successResult = {
          accountId: account._id,
          email: account.email,
          name: account.name,
          comment: commentText,
          status: 'success',
          commentId: posted.commentId || null,
          videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        };
        if (vpnWarning) {
          successResult.vpnWarning = vpnWarning;
        }
        results.push(successResult);
      } catch (error) {
        results.push({
          accountId: account._id,
          email: account.email,
          name: account.name,
          comment: commentText,
          status: 'failed',
          error: error.message || 'Unknown error',
        });
      } finally {
        if (vpnConnected && vpnProfile) {
          try {
            console.log(`[postComments] Disconnecting VPN for account ${account.email}...`);
            await openvpnService.disconnect(vpnProfile);
            // Settle teardown
            await new Promise(r => setTimeout(r, 2000));
          } catch (vpnDiscError) {
            console.error('[postComments] VPN disconnect error:', vpnDiscError.message);
          }
        }
      }

      // Add a random delay between accounts (skip delay after last account)
      if (i < accounts.length - 1) {
        await randomDelay(2000, 5000);
      }
    }

    const successful = results.filter((r) => r.status === 'success').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    res.status(200).json({
      message: `Commenting complete. ${successful} succeeded, ${failed} failed.`,
      videoId,
      total: accounts.length,
      successful,
      failed,
      results,
    });
  } catch (error) {
    try {
      await openvpnService.disconnectAll();
    } catch {}
    next(error);
  }
};

const { generateText, isQuotaExceededError } = require('../services/geminiService');
const {
  buildCommentSlots,
  validateLanguageDistribution,
  validateToneDistribution,
  defaultGenerationFilters,
} = require('../utils/commentSlots');
const {
  buildEnglishDraftPrompt,
  buildLanguageAdaptPrompt,
  buildNativeCommentPrompt,
  buildAngleSuggestionPrompt,
  parseGeminiCommentJson,
  parseGeminiAnglesJson,
  processGeneratedComments,
} = require('../utils/commentGeneration');
const { fetchTranscript } = require("youtube-transcript");

const maxTranscriptCharacters = 14000;
const maxCommentCount = 50;

function clampCommentCount(value) {
  const count = parseInt(value, 10);
  if (isNaN(count)) return 10;
  return Math.min(Math.max(count, 1), maxCommentCount);
}

function normalizeCommentLanguage(value = "english") {
  return value === "khasi" ? "khasi" : "english";
}

function normalizeMixCounts(rawMix = {}, keys = [], total = 10) {
  const mix = {};
  keys.forEach((key) => {
    mix[key] = Math.max(0, parseInt(rawMix[key], 10) || 0);
  });

  const sum = keys.reduce((acc, key) => acc + mix[key], 0);
  if (sum === total) {
    return mix;
  }

  if (sum === 0) {
    const base = Math.floor(total / keys.length);
    keys.forEach((key, index) => {
      mix[key] = index === keys.length - 1 ? total - base * (keys.length - 1) : base;
    });
    return mix;
  }

  const scaled = {};
  let assigned = 0;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      scaled[key] = Math.max(0, total - assigned);
      return;
    }
    scaled[key] = Math.round((mix[key] / sum) * total);
    assigned += scaled[key];
  });
  return scaled;
}

function normalizeGenerationFilters(filters = {}, count = 10) {
  const languageKeys = ['khasi', 'pnar', 'garo', 'english', 'hindi'];
  const toneKeys = ['positive', 'neutral', 'negative'];

  const rawLanguageMix = filters.languageMix || {};
  const languageSum = languageKeys.reduce(
    (sum, key) => sum + Math.max(0, parseInt(rawLanguageMix[key], 10) || 0),
    0,
  );
  // Prefer the user's language mix total; fall back to explicit count.
  const commentCount = clampCommentCount(
    languageSum > 0 ? languageSum : (filters.commentCount ?? count),
  );
  const defaults = defaultGenerationFilters(commentCount);

  const languageMix = normalizeMixCounts(
    Object.keys(rawLanguageMix).length ? rawLanguageMix : defaults.languageMix,
    languageKeys,
    commentCount,
  );
  const toneMix = normalizeMixCounts(
    filters.toneMix || defaults.toneMix,
    toneKeys,
    commentCount,
  );

  return {
    commentCount,
    languageMix,
    toneMode: filters.toneMode || defaults.toneMode,
    toneMix,
    voiceMode: 'single',
    voice: 'neutral',
    voiceMix: { neutral: commentCount },
    textSpeakPercent: Math.min(
      100,
      Math.max(
        0,
        filters.textSpeakPercent != null
          ? parseInt(filters.textSpeakPercent, 10)
          : defaults.textSpeakPercent,
      ),
    ),
    userIntent: String(filters.userIntent || '').trim().slice(0, 800),
    userKeywords: String(filters.userKeywords || '').trim().slice(0, 500),
    selectedAngles: Array.isArray(filters.selectedAngles)
      ? filters.selectedAngles.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : [],
  };
}

function buildFilterPromptRules(filters) {
  const languageLabels = {
    khasi: "Khasi",
    pnar: "Pnar",
    garo: "Garo",
    english: "English",
    hindi: "Hindi",
  };

  const languageLines = Object.entries(filters.languageMix)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `- Exactly ${value} comment${value === 1 ? "" : "s"} in ${languageLabels[key]}`)
    .join("\n");

  const toneLines = Object.entries(filters.toneMix || {})
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `- Exactly ${value} ${key} comment${value === 1 ? "" : "s"}`)
    .join("\n");

  return `
Language mix (must match exactly):
${languageLines}

Sentiment mix (must match exactly):
${toneLines || `- Exactly ${filters.commentCount} positive comments`}

Natural writing:
- Sound like real YouTube commenters, not AI and not Gen Z slang.
- Be specific to the video; avoid generic praise or brochure language.
${filters.userIntent ? `- User guidance: ${filters.userIntent}` : ''}
${filters.userKeywords ? `- User keywords (optional): ${filters.userKeywords}` : ''}
${(filters.selectedAngles || []).length ? `- Preferred angles: ${(filters.selectedAngles || []).join('; ')}` : ''}
- Apply light natural misspellings/shorthand to about ${filters.textSpeakPercent}% of comments.
`;
}

function generateFallbackCommentObjects({
  title = 'this video',
  channelTitle = '',
  slots = [],
  spellingErrorRate = 0,
}) {
  const shortTitle = String(title).slice(0, 80);
  const channel = channelTitle || 'this channel';
  const templates = {
    english: [
      `Really enjoyed ${shortTitle}!`,
      `Great upload from ${channel} 🔥`,
      `This ${shortTitle} was so good`,
      `Thanks ${channel}, needed this today`,
    ],
    khasi: [
      `Ka video kaba aiñ ${shortTitle} ka long kaba sngi`,
      `Kaba aiñ na ${channel}, kaba bha`,
      `Nga kwah ban peit shuh ia kane ka video`,
    ],
    hindi: [
      `${shortTitle} mast tha yaar`,
      `${channel} ka content hamesha solid hai`,
      `Video dekh ke maza aa gaya`,
    ],
    pnar: [
      `Ka video kaba aiñ ${shortTitle} ka long kaba sngi`,
      `Kaba aiñ na ${channel}, kaba bha`,
    ],
    garo: [
      `Ka video kaba aiñ ${shortTitle} ka long kaba sngi`,
      `Kaba aiñ na ${channel}, kaba bha`,
    ],
  };

  const items = slots.map((slot, index) => {
    const pool = templates[slot.language] || templates.english;
    return {
      text: pool[index % pool.length],
      language: slot.language,
      tone: slot.tone || 'positive',
      voice: slot.voice || 'neutral',
    };
  });

  return processGeneratedComments(items, slots, spellingErrorRate, title);
}

async function generateCommentsWithSlots({
  title,
  description = '',
  channelTitle = '',
  transcript = '',
  slots = [],
  avoidComments = [],
  accountPersona = '',
  spellingErrorRate = 0,
  userIntent = '',
  userKeywords = '',
  selectedAngles = [],
}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Gemini API key is missing.');
  }

  const nativeLangs = new Set(['khasi', 'pnar', 'garo']);
  const indexed = slots.map((slot, index) => ({ slot, index }));
  const nativeIndexed = indexed.filter(({ slot }) => nativeLangs.has(slot.language));
  const otherIndexed = indexed.filter(({ slot }) => !nativeLangs.has(slot.language));
  const items = new Array(slots.length).fill(null);

  try {
    // English / Hindi: draft (+ adapt for Hindi)
    if (otherIndexed.length > 0) {
      const otherSlots = otherIndexed.map(({ slot }) => slot);
      const draftRaw = await generateText(
        buildEnglishDraftPrompt({
          title,
          description,
          channelTitle,
          transcript,
          slots: otherSlots,
          accountPersona,
          avoidComments,
          userIntent,
          selectedAngles,
            userKeywords,
        }),
        {
          temperature: 0.7,
          topP: 0.9,
          maxOutputTokens: 4096,
        },
      );
      const drafts = parseGeminiCommentJson(draftRaw);

      const needsAdapt = otherSlots.some((slot) => slot.language === 'hindi');
      let adapted = [];
      if (needsAdapt) {
        const runAdapt = async () => parseGeminiCommentJson(
          await generateText(
            buildLanguageAdaptPrompt({ title, drafts, slots: otherSlots }),
            { temperature: 0.45, topP: 0.85, maxOutputTokens: 4096 },
          ),
        );
        try {
          adapted = await runAdapt();
        } catch (adaptError) {
          console.warn(`[generateCommentsWithSlots] Hindi adapt failed, retrying: ${adaptError.message}`);
          try {
            adapted = await runAdapt();
          } catch (retryError) {
            console.warn(`[generateCommentsWithSlots] Hindi adapt retry failed: ${retryError.message}`);
            adapted = [];
          }
        }
      }

      otherIndexed.forEach(({ slot, index }, j) => {
        const draft = drafts[j] || {};
        const item = adapted[j] || {};
        const meaningEn = String(item.meaning_en || item.meaningEn || draft.meaning_en || draft.text || '').trim();
        const text = slot.language === 'english'
          ? String(item.text || draft.text || meaningEn || '').trim()
          : String(item.text || '').trim();
        items[index] = {
          text,
          meaning_en: meaningEn,
          language: slot.language,
          tone: slot.tone || 'positive',
          voice: 'neutral',
        };
      });
    }

    // Khasi / Pnar / Garo: direct generation (never English→translate — that caused nonsense mixes)
    if (nativeIndexed.length > 0) {
      const nativeSlots = nativeIndexed.map(({ slot }) => slot);
      try {
        const nativeRaw = await generateText(
          buildNativeCommentPrompt({
            title,
            description,
            channelTitle,
            transcript,
            slots: nativeSlots,
            accountPersona,
            avoidComments,
            userIntent,
            selectedAngles,
            userKeywords,
          }),
          {
            temperature: 0.4,
            topP: 0.8,
            maxOutputTokens: 4096,
          },
        );
        const nativeItems = parseGeminiCommentJson(nativeRaw);
        nativeIndexed.forEach(({ slot, index }, j) => {
          const item = nativeItems[j] || {};
          items[index] = {
            text: String(item.text || '').trim(),
            meaning_en: String(item.meaning_en || item.meaningEn || '').trim(),
            language: slot.language,
            tone: slot.tone || item.tone || 'positive',
            voice: 'neutral',
          };
        });
      } catch (nativeError) {
        console.warn(`[generateCommentsWithSlots] Native generation failed: ${nativeError.message}`);
        nativeIndexed.forEach(({ slot, index }) => {
          items[index] = {
            text: '',
            meaning_en: '',
            language: slot.language,
            tone: slot.tone || 'positive',
            voice: 'neutral',
          };
        });
      }
    }

    return {
      comments: processGeneratedComments(
        items.map((item) => item || {}),
        slots,
        spellingErrorRate,
        title,
        userIntent,
      ),
      provider: 'gemini',
    };
  } catch (error) {
    console.warn(`[generateCommentsWithSlots] Gemini failed: ${error.message}`);
    throw new Error(
      isQuotaExceededError(error?.cause || error)
        ? 'Gemini API quota reached. Wait a few minutes and retry, or enable billing at ai.google.dev.'
        : (error.message || 'Gemini comment generation failed'),
    );
  }
}

function normalizeComments(text = "") {
  const cleaned = text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.map(String).map((comment) => comment.trim()).filter(Boolean);
    }
    if (Array.isArray(parsed.comments)) {
      return parsed.comments
        .map(String)
        .map((comment) => comment.trim())
        .filter(Boolean);
    }
  } catch (e) {
    // Fall back to line parsing
  }

  return cleaned
    .split(/\n+/)
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean);
}

function humanizeComments(comments = []) {
  return comments
    .map((comment) =>
      comment
        .replace(/\bThis video\b/g, "this video")
        .replace(/\bI found this video to be\b/g, "this was")
        .replace(/\bThank you for sharing\b/g, "thanks for sharing")
        .trim(),
    )
    .filter(Boolean);
}

function compactTranscript(items = []) {
  const transcript = items
    .map((item) => item.text)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return transcript.slice(0, maxTranscriptCharacters);
}

async function fetchVideoTranscript(videoId) {
  try {
    const transcriptItems = await fetchTranscript(videoId, { lang: "en" });
    const text = compactTranscript(transcriptItems);

    return {
      available: Boolean(text),
      source: "captions",
      segmentCount: transcriptItems.length,
      text,
    };
  } catch (error) {
    console.warn(`Transcript unavailable for ${videoId}: ${error.message}`);
    return {
      available: false,
      source: "metadata",
      segmentCount: 0,
      text: "",
    };
  }
}

async function fetchVideoDetails(videoId) {
  if (!process.env.YOUTUBE_API_KEY) {
    throw new Error("YouTube API key is missing.");
  }

  const params = new URLSearchParams({
    part: "snippet",
    id: videoId,
    key: process.env.YOUTUBE_API_KEY,
  });

  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`
  );
  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || "Failed to fetch video details from YouTube."
    );
  }

  const video = data.items?.[0];
  if (!video) {
    throw new Error("No public YouTube video found for that URL.");
  }

  const snippet = video.snippet;
  return {
    id: video.id,
    title: snippet.title,
    description: snippet.description || "",
    channelTitle: snippet.channelTitle,
    thumbnail:
      snippet.thumbnails?.maxres?.url ||
      snippet.thumbnails?.standard?.url ||
      snippet.thumbnails?.high?.url ||
      snippet.thumbnails?.medium?.url ||
      snippet.thumbnails?.default?.url ||
      "",
  };
}

function generateFallbackComments({
  title = 'this video',
  channelTitle = '',
  count = 1,
  language = 'english',
}) {
  const shortTitle = String(title).slice(0, 80);
  const channel = channelTitle || 'this channel';

  const englishTemplates = [
    `Really enjoyed ${shortTitle}!`,
    `Great upload from ${channel} 🔥`,
    `This ${shortTitle} was so good`,
    `Thanks ${channel}, needed this today`,
    `Can't stop watching ${shortTitle} 😂`,
    `Solid video as always from ${channel}`,
    `Loved the energy in this one`,
    `More content like ${shortTitle} please`,
    `This hit different, great edit`,
    `Underrated video right here 👏`,
  ];

  const khasiTemplates = [
    `Ka video kaba aiñ ${shortTitle} ka long kaba sngi`,
    `Kaba aiñ na ${channel}, kaba bha`,
    `Nga kwah ban peit shuh ia kane ka video`,
    `Kaba sngewbha ia ka jingpyni`,
    `Kane ka video ka long kaba aiñ`,
  ];

  const pool = language === 'khasi' ? khasiTemplates : englishTemplates;
  const results = [];

  for (let i = 0; i < count; i += 1) {
    results.push(pool[i % pool.length]);
  }

  return results;
}

async function generateComments({
  title,
  description,
  channelTitle,
  transcript = "",
  count = 10,
  avoidComments = [],
  language = "english",
  filters = null,
  slots = null,
  accountPersona = '',
}) {
  const commentCount = clampCommentCount(count);
  const commentLanguage = normalizeCommentLanguage(language);
  const generationFilters = filters
    ? normalizeGenerationFilters(filters, commentCount)
    : null;

  if (Array.isArray(slots) && slots.length > 0) {
    return generateCommentsWithSlots({
      title,
      description,
      channelTitle,
      transcript,
      slots,
      avoidComments,
      accountPersona,
      spellingErrorRate: generationFilters?.textSpeakPercent ?? 0,
      userIntent: generationFilters?.userIntent || '',
      userKeywords: generationFilters?.userKeywords || '',
      selectedAngles: generationFilters?.selectedAngles || [],
    });
  }

  if (generationFilters) {
    const builtSlots = buildCommentSlots(generationFilters, commentCount);
    return generateCommentsWithSlots({
      title,
      description,
      channelTitle,
      transcript,
      slots: builtSlots,
      avoidComments,
      accountPersona,
      spellingErrorRate: generationFilters.textSpeakPercent,
      userIntent: generationFilters.userIntent || '',
      userKeywords: generationFilters.userKeywords || '',
      selectedAngles: generationFilters.selectedAngles || [],
    });
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Gemini API key is missing.");
  }

  const languageRules = generationFilters
    ? `
- Follow the language mix exactly — each comment must use its assigned language naturally.
- For Khasi, Pnar, and Garo comments, use realistic native phrasing (light English mixing is fine).
- For Hindi comments, use natural Hinglish where it fits YouTube comment culture.
`
    : commentLanguage === "khasi"
      ? `
- Generate the comments in natural Khasi as much as possible.
- It is okay to use common Khasi-English mixed phrasing if that sounds more realistic.
- Translate the meaning of the title, description, and transcript before writing the comments.
- Keep the comments readable for Khasi speakers and avoid overly formal textbook phrasing.
`
      : `
- Generate the comments in natural English.
`;

  const filterRules = generationFilters ? buildFilterPromptRules(generationFilters) : "";

  const prompt = `
Generate exactly ${commentCount} realistic YouTube comment${commentCount === 1 ? "" : "s"} related to this video.

Video title: ${title}
Channel: ${channelTitle || "Unknown"}
Description: ${description || "No description provided."}
Transcript: ${transcript || "No transcript available. Use the title and description only."}
Avoid making comments similar to these existing comments:
${avoidComments.length ? avoidComments.map((comment) => `- ${comment}`).join("\n") : "- None"}

Rules:
- Write like real viewers in a YouTube comment section, not like an assistant.
- If transcript is available, base comments on the actual spoken content.
${languageRules}
${filterRules}
- Make every comment feel different: some casual, some excited, some curious, some appreciative.
- Use natural imperfections where it fits: contractions, simple words, short reactions, light slang.
- Include emojis in some comments, but not every comment. Keep them natural.
- Keep most comments between 6 and 18 words.
- Avoid polished marketing language, generic praise, hashtags, numbering, markdown, and quotation marks.
- Do not say you watched the whole video unless the transcript clearly supports it.
- Return only a JSON array of ${commentCount} string${commentCount === 1 ? "" : "s"}.
`;

  try {
    const text = await generateText(prompt);
    return {
      comments: humanizeComments(normalizeComments(text)).slice(0, commentCount),
      provider: 'gemini',
    };
  } catch (error) {
    console.warn(`[generateComments] Gemini failed, using template fallback: ${error.message}`);
    const fallbackSlots = Array.from({ length: commentCount }, () => ({ language: commentLanguage }));
    return {
      comments: generateFallbackCommentObjects({
        title,
        channelTitle,
        slots: fallbackSlots,
        spellingErrorRate: 0,
      }),
      provider: isQuotaExceededError(error?.cause || error) ? 'template-quota-fallback' : 'template-fallback',
      warning: error.message,
    };
  }
}

const generateCommentsFromUrl = async (req, res, next) => {
  try {
    const { youtubeUrl, count, language = "english", filters = null, accountPersona = '' } = req.body;
    const videoId = extractVideoId(youtubeUrl);
    const commentCount = clampCommentCount(count);
    const normalizedFilters = filters ? normalizeGenerationFilters(filters, commentCount) : null;

    if (!videoId) {
      res.status(400);
      throw new Error("Paste a valid YouTube video URL.");
    }

    const video = await fetchVideoDetails(videoId);
    const transcript = await fetchVideoTranscript(videoId);
    const slots = normalizedFilters
      ? buildCommentSlots(normalizedFilters, commentCount)
      : null;
    const generated = await generateComments({
      ...video,
      transcript: transcript.text,
      count: commentCount,
      language,
      filters: normalizedFilters,
      slots,
      accountPersona,
    });

    res.status(200).json({
      video: {
        ...video,
        transcriptAvailable: transcript.available,
        transcriptSegmentCount: transcript.segmentCount,
      },
      analysis: {
        source: transcript.source,
        transcriptAvailable: transcript.available,
        transcriptSegmentCount: transcript.segmentCount,
      },
      comments: generated.comments,
      slots,
      language: normalizeCommentLanguage(language),
      filters: normalizedFilters,
      languageProvider: generated.provider,
      warning: generated.warning || null,
    });
  } catch (error) {
    next(error);
  }
};

const generateCommentsBatch = async (req, res, next) => {
  try {
    const {
      videos = [],
      accounts = [],
      filters = null,
      totalCount,
      accountPersona = '',
    } = req.body;

    if (!Array.isArray(videos) || videos.length === 0) {
      res.status(400);
      throw new Error('Add at least one video URL.');
    }
    if (!Array.isArray(accounts) || accounts.length === 0) {
      res.status(400);
      throw new Error('Select at least one account.');
    }

    const commentCount = clampCommentCount(totalCount ?? filters?.commentCount ?? 10);
    const normalizedFilters = normalizeGenerationFilters(filters || {}, commentCount);
    const effectiveCount = normalizedFilters.commentCount;
    const langErr = validateLanguageDistribution(normalizedFilters.languageMix, effectiveCount);
    if (langErr) {
      res.status(400);
      throw new Error(langErr);
    }
    const toneErr = validateToneDistribution(normalizedFilters.toneMix, effectiveCount);
    if (toneErr) {
      res.status(400);
      throw new Error(toneErr);
    }

    const slots = buildCommentSlots(normalizedFilters, effectiveCount);
    const pairs = videos.flatMap((video) =>
      accounts.map((account) => ({ video, account })),
    );

    const assignments = slots.map((slot, index) => ({
      slot,
      pair: pairs[index % pairs.length],
      index,
    }));

    const groupedByVideo = new Map();
    assignments.forEach((assignment) => {
      const videoUrl = assignment.pair.video.youtubeUrl || assignment.pair.video.url;
      if (!groupedByVideo.has(videoUrl)) {
        groupedByVideo.set(videoUrl, []);
      }
      groupedByVideo.get(videoUrl).push(assignment);
    });

    const allComments = new Array(slots.length);
    let provider = 'gemini';
    let warning = null;

    for (const [videoUrl, groupAssignments] of groupedByVideo.entries()) {
      const videoId = extractVideoId(videoUrl);
      if (!videoId) {
        res.status(400);
        throw new Error(`Invalid YouTube URL: ${videoUrl}`);
      }

      const video = await fetchVideoDetails(videoId);
      const transcript = await fetchVideoTranscript(videoId);
      const groupSlots = groupAssignments.map((item) => item.slot);
      const persona = groupAssignments[0]?.pair?.account?.persona
        || accountPersona
        || '';

      const generated = await generateCommentsWithSlots({
        title: video.title,
        description: video.description,
        channelTitle: video.channelTitle,
        transcript: transcript.text,
        slots: groupSlots,
        accountPersona: persona,
        spellingErrorRate: normalizedFilters.textSpeakPercent,
        userIntent: normalizedFilters.userIntent || '',
        userKeywords: normalizedFilters.userKeywords || '',
        selectedAngles: normalizedFilters.selectedAngles || [],
      });

      if (generated.warning) warning = generated.warning;
      if (generated.provider !== 'gemini') provider = generated.provider;

      groupAssignments.forEach((assignment, localIndex) => {
        const result = generated.comments[localIndex];
        const account = assignment.pair.account;
        allComments[assignment.index] = {
          ...result,
          videoId: video.id,
          videoUrl,
          videoTitle: video.title,
          channelTitle: video.channelTitle,
          accountId: String(account.id || account._id || ''),
          accountPersona: account.persona || persona || '',
        };
      });
    }

    res.status(200).json({
      comments: allComments.filter(Boolean),
      slots,
      filters: normalizedFilters,
      languageProvider: provider,
      warning,
    });
  } catch (error) {
    next(error);
  }
};

const suggestCommentAngles = async (req, res, next) => {
  try {
    const { youtubeUrl } = req.body;
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
      res.status(400);
      throw new Error('Paste a valid YouTube video URL.');
    }
    if (!process.env.GEMINI_API_KEY) {
      res.status(400);
      throw new Error('Gemini API key is missing.');
    }

    const video = await fetchVideoDetails(videoId);
    const transcript = await fetchVideoTranscript(videoId);
    const prompt = buildAngleSuggestionPrompt({
      title: video.title,
      description: video.description,
      channelTitle: video.channelTitle,
      transcript: transcript.text,
    });

    const text = await generateText(prompt);
    const angles = parseGeminiAnglesJson(text);

    res.status(200).json({
      angles,
      video: {
        id: video.id,
        title: video.title,
        channelTitle: video.channelTitle,
      },
    });
  } catch (error) {
    next(error);
  }
};

const regenerateCommentFromUrl = async (req, res, next) => {
  try {
    const {
      youtubeUrl,
      existingComments = [],
      language = "english",
      filters = null,
      singleSlot = null,
      accountPersona = '',
    } = req.body;
    const videoId = extractVideoId(youtubeUrl);

    if (!videoId) {
      res.status(400);
      throw new Error("Paste a valid YouTube video URL.");
    }

    const video = await fetchVideoDetails(videoId);
    const transcript = await fetchVideoTranscript(videoId);
    const normalizedFilters = filters ? normalizeGenerationFilters(filters, 1) : null;
    const slots = singleSlot
      ? [{
          language: singleSlot.language || language || 'english',
          tone: ['negative', 'neutral', 'positive'].includes(singleSlot.tone) ? singleSlot.tone : 'positive',
          voice: 'neutral',
        }]
      : normalizedFilters
        ? buildCommentSlots(normalizedFilters, 1).slice(0, 1)
        : [{ language: language === 'khasi' ? 'khasi' : 'english', tone: 'positive', voice: 'neutral' }];

    const generated = await generateCommentsWithSlots({
      title: video.title,
      description: video.description,
      channelTitle: video.channelTitle,
      transcript: transcript.text,
      slots,
      avoidComments: Array.isArray(existingComments) ? existingComments : [],
      accountPersona,
      spellingErrorRate: normalizedFilters?.textSpeakPercent ?? 40,
      userIntent: normalizedFilters?.userIntent || '',
      userKeywords: normalizedFilters?.userKeywords || '',
      selectedAngles: normalizedFilters?.selectedAngles || [],
    });

    res.status(200).json({
      comment: generated.comments[0] || null,
      language: normalizeCommentLanguage(generated.comments[0]?.language || language),
      filters: normalizedFilters,
      languageProvider: generated.provider,
      warning: generated.warning || null,
    });
  } catch (error) {
    next(error);
  }
};

// Helper: Format view counts into K/M formats
function formatViews(viewsStr) {
  const views = parseInt(viewsStr, 10);
  if (isNaN(views)) return "0";
  if (views >= 1000000) {
    return (views / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (views >= 1000) {
    return (views / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return views.toString();
}

// Helper: Parse ISO 8601 duration string into mm:ss format
function formatDuration(isoDuration) {
  if (!isoDuration) return "0:00";
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return "0:00";
  const hours = parseInt(match[1] || 0, 10);
  const minutes = parseInt(match[2] || 0, 10);
  const seconds = parseInt(match[3] || 0, 10);

  let result = "";
  if (hours > 0) {
    result += hours + ":" + (minutes < 10 ? "0" : "");
  }
  result += minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
  return result;
}

// Helper: Format ISO date string into relative time
function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours <= 0) return "Just now";
    return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  }
  if (diffDays < 7) {
    return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
  }
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 4) {
    return `${diffWeeks} week${diffWeeks > 1 ? "s" : ""} ago`;
  }
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) {
    return `${diffMonths} month${diffMonths > 1 ? "s" : ""} ago`;
  }
  const diffYears = Math.floor(diffDays / 365);
  return `${diffYears} year${diffYears > 1 ? "s" : ""} ago`;
}

// Helper: Generate static mock videos if APIs fail
function getStaticMockVideos(keyword) {
  const titles = [
    `I Built an AI CRM Workflow That Saves 6 Hours a Week`,
    `Automating Client Follow-ups Without Sounding Robotic`,
    `My Notion AI Dashboard for Running a Solo Agency`,
    `The Automation Stack I Use for Every Small Business`,
    `AI for Small Business: A Step-by-Step Guide to Getting Started`,
    `Why Your Automation Agency is Failing (And How to Fix It)`
  ];
  const channels = ["Startup Systems", "Modern Ops", "Solo Founder Studio", "No-Code Build", "Automate Daily", "Growth Engine"];
  const views = ["184000", "72000", "231000", "95000", "45000", "120000"];
  const durations = ["PT15M33S", "PT8M12S", "PT12M45S", "PT22M10S", "PT10M15S", "PT18M25S"];

  return titles.map((title, index) => {
    const published = new Date();
    published.setDate(published.getDate() - (index + 2));
    return {
      id: `mock-video-static-${index}`,
      title,
      description: `In this video, we explore how to leverage ${keyword} to streamline workflows, scale operations, and save precious hours every week.`,
      channelTitle: channels[index % channels.length],
      publishedAt: published.toISOString(),
      thumbnail: `https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=360&auto=format&fit=crop&q=60`,
      views: views[index % views.length],
      duration: durations[index % durations.length],
      source: "Keyword search",
    };
  });
}

// Helper: Generate mock search results via Gemini
async function generateMockVideosViaGemini(keyword) {
  if (!process.env.GEMINI_API_KEY) {
    return getStaticMockVideos(keyword);
  }

  try {
    const prompt = `
Generate exactly 6 realistic YouTube search result videos for the search query/keyword: "${keyword}".
Each video should have:
- title: A realistic, catchy YouTube title that a creator would use.
- channelTitle: A realistic tech/business channel name.
- description: A brief, realistic YouTube description (1-2 sentences).
- publishedAt: A recent ISO date (e.g. between 1 and 30 days ago).
- views: A realistic view count (e.g., between 5000 and 500000).
- duration: A realistic YouTube video duration in ISO 8601 format (e.g., "PT12M30S" or "PT8M45S").

Return ONLY a JSON array of objects representing these videos.
Example format:
[
  {
    "title": "...",
    "channelTitle": "...",
    "description": "...",
    "publishedAt": "2026-06-10T12:00:00Z",
    "views": "154000",
    "duration": "PT12M30S"
  }
]
Do not include any explanation, do not wrap in markdown codeblocks, do not add any text other than the JSON array.
`;

    const text = (await generateText(prompt)).trim();
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const videos = JSON.parse(cleaned);

    if (Array.isArray(videos)) {
      return videos.map((v, index) => ({
        id: `mock-video-${index}-${Math.random().toString(36).substr(2, 9)}`,
        title: v.title,
        description: v.description,
        channelTitle: v.channelTitle,
        publishedAt: v.publishedAt || new Date().toISOString(),
        thumbnail: `https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=360&auto=format&fit=crop&q=60`,
        views: v.views || "15000",
        duration: v.duration || "PT10M0S",
        source: "Keyword search",
      }));
    }
  } catch (err) {
    console.error("Failed to generate mock videos via Gemini:", err);
  }

  return getStaticMockVideos(keyword);
}

// Helper: Calculate Niche Match Relevance Score via Gemini
async function calculateNicheMatches(keyword, videos) {
  if (!process.env.GEMINI_API_KEY) {
    return videos.map(() => 90);
  }

  try {
    const videosListText = videos.map((v, i) => {
      return `ID: ${i}\nTitle: "${v.title}"\nDescription: "${v.description?.slice(0, 300)}..."`;
    }).join("\n\n");

    const prompt = `
You are an AI specialized in YouTube automation and keyword research.
We are analyzing how relevant a list of YouTube videos is to the target niche/keyword: "${keyword}".

For each video, compute a relevance score (niche match percentage) from 0 to 100 representing how closely the video content aligns with this niche/keyword.
- 90-100: Perfect match (e.g. video specifically about automation/CRM for small business if keyword is "AI CRM for small business")
- 70-89: Good match (e.g. video general to CRM or small business AI)
- 40-69: Moderate match (e.g. video about general small business tools or generic AI apps)
- Under 40: Low/no match

Videos list:
${videosListText}

Return ONLY a JSON array containing the calculated integer scores for each video in the exact order of the list.
Example format: [96, 91, 88, 75, 42]
Do not include any explanation, do not wrap in markdown codeblocks, do not add any text other than the JSON array.
`;

    const text = (await generateText(prompt)).trim();
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const scores = JSON.parse(cleaned);

    if (Array.isArray(scores) && scores.length === videos.length) {
      return scores.map(s => Math.min(Math.max(parseInt(s, 10) || 50, 0), 100));
    }
  } catch (err) {
    const reason = err?.quotaExceeded
      ? 'Gemini quota reached'
      : (err?.message || 'Gemini unavailable');
    console.warn(`[Discover] Niche scores via keyword fallback (${reason})`);
  }

  // Text relevance fallback
  return videos.map(v => {
    const text = (v.title + " " + v.description).toLowerCase();
    const words = keyword.toLowerCase().split(/\s+/);
    let matches = 0;
    words.forEach(w => {
      if (text.includes(w)) matches++;
    });
    const percentage = Math.round(50 + (matches / words.length) * 45);
    return Math.min(percentage, 100);
  });
}

// Search YouTube API function
async function searchYouTubeVideos(query, filters = {}) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error("YouTube API key is missing");
  }

  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    maxResults: "10",
    q: query,
    key: apiKey,
  });

  if (filters.uploadDate && filters.uploadDate !== "any") {
    const now = new Date();
    if (filters.uploadDate === "today") {
      now.setDate(now.getDate() - 1);
    } else if (filters.uploadDate === "this_week") {
      now.setDate(now.getDate() - 7);
    } else if (filters.uploadDate === "this_month") {
      now.setMonth(now.getMonth() - 1);
    }
    params.append("publishedAfter", now.toISOString());
  }

  if (filters.duration && filters.duration !== "any") {
    params.append("videoDuration", filters.duration);
  }

  if (filters.country) {
    const countryCodes = {
      "India": "IN",
      "United States": "US",
      "United Kingdom": "GB",
      "Canada": "CA",
      "Australia": "AU"
    };
    const regionCode = countryCodes[filters.country];
    if (regionCode) {
      params.append("regionCode", regionCode);
    }
  }

  const searchUrl = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
  const response = await fetch(searchUrl);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "YouTube search failed");
  }

  const items = data.items || [];
  if (items.length === 0) {
    return [];
  }

  const videoIds = items.map(item => item.id.videoId).filter(Boolean);

  const detailsParams = new URLSearchParams({
    part: "statistics,contentDetails",
    id: videoIds.join(","),
    key: apiKey,
  });

  const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?${detailsParams.toString()}`;
  const detailsResponse = await fetch(detailsUrl);
  const detailsData = await detailsResponse.json();

  const detailsMap = {};
  if (detailsResponse.ok && detailsData.items) {
    detailsData.items.forEach(item => {
      detailsMap[item.id] = {
        views: item.statistics?.viewCount || "0",
        duration: item.contentDetails?.duration || "PT0S",
      };
    });
  }

  return items.map(item => {
    const videoId = item.id.videoId;
    const detail = detailsMap[videoId] || { views: "0", duration: "PT0S" };
    return {
      id: videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
      thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || "",
      views: detail.views,
      duration: detail.duration,
      source: "Keyword search",
    };
  });
}

// Controller function: Search and evaluate YouTube videos
const searchVideos = async (req, res, next) => {
  try {
    const {
      keyword,
      minNicheMatch = "80% and above",
      uploadDate = "any",
      minViews = "any",
      duration = "any",
      country = "India",
      province = ""
    } = req.body;

    if (!keyword?.trim()) {
      res.status(400);
      throw new Error("Keyword is required.");
    }

    let videos = [];
    let isMocked = false;

    try {
      videos = await searchYouTubeVideos(keyword.trim(), { uploadDate, duration, country });
    } catch (err) {
      console.warn("Falling back to mock videos due to search error:", err.message);
      videos = await generateMockVideosViaGemini(keyword.trim());
      isMocked = true;
    }

    if (videos.length === 0) {
      videos = await generateMockVideosViaGemini(keyword.trim());
      isMocked = true;
    }

    const scores = await calculateNicheMatches(keyword.trim(), videos);

    let results = videos.map((video, idx) => {
      const matchScore = scores[idx] || 80;
      return {
        ...video,
        nicheMatch: matchScore,
        formattedViews: formatViews(video.views),
        formattedDuration: formatDuration(video.duration),
        formattedRelativeTime: formatRelativeTime(video.publishedAt),
      };
    });

    const minMatchVal = parseInt(minNicheMatch) || 0;
    results = results.filter(v => v.nicheMatch >= minMatchVal);

    if (minViews && minViews !== "any") {
      const minViewsMap = {
        "10k": 10000,
        "100k": 100000,
        "1m": 1000000
      };
      const threshold = minViewsMap[minViews.toLowerCase()] || 0;
      results = results.filter(v => parseInt(v.views, 10) >= threshold);
    }

    res.status(200).json({
      videos: results,
      isMocked,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all saved discover videos for the logged-in user profile
// @route   GET /api/comments/discover-videos
// @access  Private
const getDiscoverVideos = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(200).json({ videos: [] });
    }

    let videos = user.discoveredVideos || [];

    // One-time migration from legacy per-Google-account storage
    if (!videos.length) {
      const activeAccount = await GoogleAccount.findOne({ user: req.user._id, isActive: true });
      if (activeAccount?.discoveredVideos?.length) {
        videos = activeAccount.discoveredVideos;
        user.discoveredVideos = videos;
        await user.save();
      }
    }

    res.status(200).json({ videos });
  } catch (error) {
    next(error);
  }
};

// @desc    Save/Upsert discover videos on the logged-in user profile
// @route   POST /api/comments/discover-videos
// @access  Private
const saveDiscoverVideos = async (req, res, next) => {
  try {
    const { videos } = req.body;
    if (!videos || !Array.isArray(videos)) {
      res.status(400);
      throw new Error('Please provide an array of videos');
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      res.status(404);
      throw new Error('User profile not found');
    }

    const currentVideosMap = new Map();
    (user.discoveredVideos || []).forEach((v) => {
      if (v && v.id) {
        currentVideosMap.set(v.id, v);
      }
    });

    videos.forEach((v) => {
      if (v && v.id) {
        currentVideosMap.set(v.id, {
          id: v.id,
          title: v.title || 'YouTube Video',
          channelTitle: v.channelTitle || v.channel || 'Unknown Channel',
          description: v.description || '',
          publishedAt: v.publishedAt || '',
          thumbnail: v.thumbnail || '',
          views: v.views || '0',
          duration: v.duration || 'PT0S',
          nicheMatch: v.nicheMatch || 0,
          source: v.source || 'Keyword search',
          keyword: v.keyword || '',
        });
      }
    });

    user.discoveredVideos = Array.from(currentVideosMap.values());
    await user.save();

    console.log(
      `[saveDiscoverVideos] Saved ${user.discoveredVideos.length} discover videos for user ${user.email}`
    );
    res.status(200).json({
      message: `${videos.length} videos saved successfully`,
      videos: user.discoveredVideos,
    });
  } catch (error) {
    console.error('[saveDiscoverVideos] Error saving discover videos:', error);
    next(error);
  }
};

const resolveCampaignTargetAccounts = async (userId, accountIds) => {
  if (Array.isArray(accountIds) && accountIds.length > 0) {
    const accounts = await GoogleAccount.find({
      _id: { $in: accountIds },
      user: userId,
      status: 'connected',
    });

    if (!accounts.length) {
      const error = new Error('No valid connected accounts found for this campaign.');
      error.statusCode = 404;
      throw error;
    }

    return accounts;
  }

  const activeAccount = await GoogleAccount.findOne({ user: userId, isActive: true });
  if (!activeAccount) {
    const error = new Error('No active Google Account profile found. Connect an account first.');
    error.statusCode = 404;
    throw error;
  }

  return [activeAccount];
};

const findAccountsWithCampaign = async (userId, campaignId, accountIds) => {
  if (Array.isArray(accountIds) && accountIds.length > 0) {
    const accounts = await GoogleAccount.find({
      _id: { $in: accountIds },
      user: userId,
    });
    return accounts.filter((account) =>
      (account.campaigns || []).some((campaign) => String(campaign._id) === String(campaignId))
    );
  }

  const accounts = await GoogleAccount.find({ user: userId });
  return accounts.filter((account) =>
    (account.campaigns || []).some((campaign) => String(campaign._id) === String(campaignId))
  );
};

const normalizeCampaignForResponse = (campaign, account) => ({
  ...campaign,
  googleAccountId: account._id,
  profileEmail: account.email,
  profileName: account.name,
});

// @desc    Get saved campaigns (all profiles, or one profile via ?googleAccountId=)
// @route   GET /api/comments/campaigns
// @access  Private
const getCampaigns = async (req, res, next) => {
  try {
    const { googleAccountId } = req.query;

    if (googleAccountId) {
      const account = await GoogleAccount.findOne({
        _id: googleAccountId,
        user: req.user._id,
      });

      if (!account) {
        return res.status(200).json([]);
      }

      return res.status(200).json(
        (account.campaigns || []).map((campaign) => normalizeCampaignForResponse(campaign, account))
      );
    }

    const accounts = await GoogleAccount.find({ user: req.user._id });
    const seen = new Set();
    const campaigns = [];

    for (const account of accounts) {
      for (const campaign of account.campaigns || []) {
        if (seen.has(String(campaign._id))) continue;
        seen.add(String(campaign._id));
        campaigns.push(normalizeCampaignForResponse(campaign, account));
      }
    }

    campaigns.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.status(200).json(campaigns);
  } catch (error) {
    next(error);
  }
};

// @desc    Create a campaign on the selected Google account profile(s)
// @route   POST /api/comments/campaigns
// @access  Private
const createCampaign = async (req, res, next) => {
  try {
    const {
      name,
      source,
      videos,
      accounts,
      comments,
      ready,
      status,
      details,
      accountIds,
    } = req.body;

    if (!name) {
      res.status(400);
      throw new Error('Campaign name is required');
    }

    const targetAccounts = await resolveCampaignTargetAccounts(req.user._id, accountIds);
    const campaignId = generateObjectId();
    const participantProfiles = targetAccounts.map((account) => ({
      id: account._id,
      email: account.email,
      name: account.name,
    }));

    const newCampaign = {
      _id: campaignId,
      name,
      source: source || 'Pasted URLs',
      videos: Number(videos) || 0,
      accounts: Number(accounts) || targetAccounts.length,
      comments: Number(comments) || 0,
      ready: Number(ready) || 0,
      status: status || 'Generating',
      details: details || [],
      accountIds: participantProfiles.map((profile) => profile.id),
      participantProfiles,
      createdAt: new Date().toISOString(),
    };

    for (const account of targetAccounts) {
      if (!account.campaigns) {
        account.campaigns = [];
      }
      account.campaigns.push({ ...newCampaign });
      account.markModified('campaigns');
      await account.save();
    }

    res.status(201).json(newCampaign);
  } catch (error) {
    if (error.statusCode) {
      res.status(error.statusCode);
    }
    next(error);
  }
};

// @desc    Update a campaign on every profile that stores it
// @route   PUT /api/comments/campaigns/:id
// @access  Private
const updateCampaign = async (req, res, next) => {
  try {
    const { status, details, ready, accountIds } = req.body;
    const campaignId = req.params.id;
    const targetAccounts = await findAccountsWithCampaign(
      req.user._id,
      campaignId,
      accountIds
    );

    if (!targetAccounts.length) {
      res.status(404);
      throw new Error('Campaign not found');
    }

    let updatedCampaign = null;

    for (const account of targetAccounts) {
      const campaignIndex = account.campaigns.findIndex(
        (campaign) => String(campaign._id) === String(campaignId)
      );
      if (campaignIndex === -1) continue;

      const campaign = account.campaigns[campaignIndex];
      if (status) campaign.status = status;
      if (details) campaign.details = details;
      if (ready !== undefined) campaign.ready = Number(ready);

      account.campaigns[campaignIndex] = campaign;
      account.markModified('campaigns');
      await account.save();
      updatedCampaign = campaign;
    }

    res.status(200).json(updatedCampaign);
  } catch (error) {
    next(error);
  }
};

// @desc    Get all saved wizard videos for the active profile
// @route   GET /api/comments/wizard-videos
// @access  Private
const getWizardVideos = async (req, res, next) => {
  try {
    const activeAccount = await GoogleAccount.findOne({ user: req.user._id, isActive: true });
    if (!activeAccount) {
      return res.status(200).json({ videos: [] });
    }
    res.status(200).json({ videos: activeAccount.wizardAddedVideos || [] });
  } catch (error) {
    next(error);
  }
};

// @desc    Save/replace wizard videos array in active profile
// @route   POST /api/comments/wizard-videos
// @access  Private
const saveWizardVideos = async (req, res, next) => {
  try {
    const { videos } = req.body;
    if (!videos || !Array.isArray(videos)) {
      res.status(400);
      throw new Error('Please provide an array of videos');
    }

    const activeAccount = await GoogleAccount.findOne({ user: req.user._id, isActive: true });
    if (!activeAccount) {
      res.status(404);
      throw new Error('No active Google Account profile found. Connect an account first.');
    }

    activeAccount.wizardAddedVideos = videos.map(v => ({
      id: v.id,
      url: v.url,
      title: v.title || 'YouTube Video',
      channel: v.channel || 'Unknown Channel',
      nicheMatch: Number(v.nicheMatch) || 0,
      success: v.success !== undefined ? v.success : true
    }));

    activeAccount.markModified('wizardAddedVideos');
    await activeAccount.save();

    res.status(200).json({ message: 'Wizard videos saved successfully', videos: activeAccount.wizardAddedVideos });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  postCommentsOnVideo,
  generateCommentsFromUrl,
  generateCommentsBatch,
  regenerateCommentFromUrl,
  suggestCommentAngles,
  searchVideos,
  getDiscoverVideos,
  saveDiscoverVideos,
  getCampaigns,
  createCampaign,
  updateCampaign,
  getWizardVideos,
  saveWizardVideos,
};
