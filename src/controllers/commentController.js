const GoogleAccount = require('../models/GoogleAccount');
const { decrypt } = require('../utils/encryption');
const { postComment } = require('../services/youtubeService');

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
    const { videoUrl, comments } = req.body;

    if (!videoUrl) {
      res.status(400);
      throw new Error('Please provide a YouTube video URL');
    }

    if (!comments || !Array.isArray(comments) || comments.length === 0) {
      res.status(400);
      throw new Error('Please provide at least one comment');
    }

    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      res.status(400);
      throw new Error('Invalid YouTube URL. Could not extract video ID.');
    }

    // Fetch ALL connected accounts for this user
    const accounts = await GoogleAccount.find({
      user: req.user._id,
      status: 'connected',
    });

    if (!accounts.length) {
      res.status(400);
      throw new Error('No connected Google accounts found. Please add and sign in accounts first.');
    }

    // Shuffle comments and assign unique ones to each account (no duplicates).
    // If more accounts than comments, cycle through a fresh shuffled copy.
    const shuffled = [...comments].sort(() => Math.random() - 0.5);
    let commentPool = [...shuffled];

    const results = [];

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];

      // Refill the pool with a fresh shuffle if we run out
      if (commentPool.length === 0) {
        commentPool = [...comments].sort(() => Math.random() - 0.5);
      }

      // Take the next unique comment from the pool
      const commentText = commentPool.shift();

      try {
        const accessToken = decrypt(account.accessToken);
        const refreshToken = account.refreshToken ? decrypt(account.refreshToken) : null;

        await postComment(accessToken, refreshToken, videoId, commentText);

        results.push({
          accountId: account._id,
          email: account.email,
          name: account.name,
          comment: commentText,
          status: 'success',
        });
      } catch (error) {
        results.push({
          accountId: account._id,
          email: account.email,
          name: account.name,
          comment: commentText,
          status: 'failed',
          error: error.message || 'Unknown error',
        });
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
    next(error);
  }
};

module.exports = {
  postCommentsOnVideo,
};
