'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

// Models that return 404 or are retired on the v1beta generateContent API.
const UNAVAILABLE_MODELS = new Set([
  'gemini-1.5-flash',
  'gemini-1.5-flash-latest',
  'gemini-1.5-flash-8b',
  'gemini-1.5-flash-8b-latest',
  'gemini-1.5-pro',
  'gemini-1.5-pro-latest',
]);

const DEFAULT_MODEL_CHAIN = [
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.5-flash',
];

const getModelChain = () => {
  const primary = (process.env.GEMINI_MODEL || '').trim();
  const fallbacks = (process.env.GEMINI_MODEL_FALLBACKS || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  const chain = [...new Set([primary, ...fallbacks, ...DEFAULT_MODEL_CHAIN].filter(Boolean))];
  return chain.filter((model) => !UNAVAILABLE_MODELS.has(model));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getErrorMessage = (error) => String(error?.message || error || '');

const isQuotaExceededError = (error) => {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('429')
    || message.includes('quota exceeded')
    || message.includes('exceeded your current quota')
    || message.includes('rate limit')
    || message.includes('rate-limit')
    || message.includes('resource exhausted')
    || message.includes('too many requests')
  );
};

const isModelNotFoundError = (error) => {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('404')
    || message.includes('not found for api version')
    || message.includes('is not supported for generatecontent')
  );
};

const isTransientGeminiError = (error) => {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('503')
    || message.includes('500')
    || message.includes('unavailable')
    || message.includes('high demand')
    || message.includes('overloaded')
  );
};

const isRetryableGeminiError = (error) =>
  isQuotaExceededError(error) || isTransientGeminiError(error);

const parseRetryAfterSeconds = (error) => {
  const match = getErrorMessage(error).match(/retry in ([\d.]+)s/i);
  if (!match) return null;
  return Math.min(Math.ceil(parseFloat(match[1])), 120);
};

const formatGeminiError = (error) => {
  const message = getErrorMessage(error);
  if (isQuotaExceededError(error)) {
    return 'Gemini API quota reached. Wait a few minutes, set GEMINI_MODEL=gemini-2.0-flash-lite in .env, or enable billing at ai.google.dev.';
  }
  if (isModelNotFoundError(error)) {
    return 'Configured Gemini model is not available. Set GEMINI_MODEL=gemini-2.0-flash-lite in .env and restart the server.';
  }
  if (message.includes('503') || message.includes('high demand')) {
    return 'Gemini is temporarily overloaded. Please try again in a minute.';
  }
  return message;
};

function pickBestChainError(errors = []) {
  if (!errors.length) return null;
  return (
    errors.find((entry) => entry.quota)?.error
    || errors.find((entry) => entry.transient)?.error
    || errors.find((entry) => !entry.notFound)?.error
    || errors[errors.length - 1].error
  );
}

/**
 * Generate text with Gemini, retrying transient errors and falling back across models.
 */
const generateText = async (prompt, options = {}) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Gemini API key is missing.');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const models = getModelChain();
  const maxRetries = options.maxRetries ?? 2;
  const attemptErrors = [];
  let quotaHits = 0;

  for (const modelName of models) {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: options.temperature ?? 0.95,
            topP: options.topP ?? 0.95,
            maxOutputTokens: options.maxOutputTokens ?? 8192,
          },
        });
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        if (modelName !== models[0]) {
          console.warn(`[Gemini] Used fallback model: ${modelName}`);
        }
        return text;
      } catch (error) {
        const quota = isQuotaExceededError(error);
        const transient = isTransientGeminiError(error);
        const notFound = isModelNotFoundError(error);

        attemptErrors.push({ model: modelName, error, quota, transient, notFound });

        console.warn(
          `[Gemini] ${modelName} attempt ${attempt + 1} failed: ${getErrorMessage(error).slice(0, 200)}`
        );

        if (notFound) {
          break;
        }

        if (quota) {
          quotaHits += 1;
          break;
        }

        if (!transient) {
          break;
        }

        if (attempt < maxRetries - 1) {
          const retryAfter = parseRetryAfterSeconds(error);
          await sleep((retryAfter || (attempt + 1)) * 1000);
        }
      }
    }
  }

  const lastError = pickBestChainError(attemptErrors);
  const wrapped = new Error(formatGeminiError(lastError));
  wrapped.cause = lastError;
  wrapped.quotaExceeded = quotaHits > 0;
  throw wrapped;
};

module.exports = {
  generateText,
  getModelChain,
  formatGeminiError,
  isQuotaExceededError,
  isRetryableGeminiError,
};
