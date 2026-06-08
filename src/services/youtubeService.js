const { google } = require('googleapis');
const fs = require('fs');

/**
 * Initializes and returns an authenticated YouTube Data API v3 client.
 * @param {string} accessToken 
 * @param {string} refreshToken 
 * @returns {object} The youtube API client
 */
const getYoutubeClient = (accessToken, refreshToken) => {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    // Google Client Secret is normally required for refresh logic.
    // If your frontend uses implicit flow, it might just give you access tokens.
    // We pass empty string if not strictly needed, but getting fresh tokens requires a secret.
    process.env.GOOGLE_CLIENT_SECRET || '' 
  );

  oAuth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken
  });

  return google.youtube({ version: 'v3', auth: oAuth2Client });
};

/**
 * Fetches basic channel statistics (views, subscribers, video count).
 */
const fetchChannelStats = async (accessToken, refreshToken) => {
  const youtube = getYoutubeClient(accessToken, refreshToken);
  
  const response = await youtube.channels.list({
    part: 'snippet,statistics',
    mine: true
  });

  if (!response.data.items || response.data.items.length === 0) {
    throw new Error('No YouTube channel found for this Google Account.');
  }

  return response.data.items[0];
};

/**
 * Uploads a video to YouTube.
 */
const uploadVideoToYouTube = async (accessToken, refreshToken, fileData, videoMeta) => {
  const youtube = getYoutubeClient(accessToken, refreshToken);
  
  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: videoMeta.title || 'Untitled Video',
        description: videoMeta.description || '',
        tags: videoMeta.tags ? videoMeta.tags.split(',') : [],
      },
      status: {
        privacyStatus: videoMeta.privacyStatus || 'private', // 'private', 'unlisted', 'public'
      },
    },
    media: {
      body: fs.createReadStream(fileData.path),
    },
  });

  return res.data;
};

/**
 * Posts a top-level comment on a YouTube video.
 * @param {string} accessToken 
 * @param {string} refreshToken 
 * @param {string} videoId - The YouTube video ID
 * @param {string} commentText - The comment text to post
 * @returns {object} The created comment resource
 */
const postComment = async (accessToken, refreshToken, videoId, commentText) => {
  const youtube = getYoutubeClient(accessToken, refreshToken);

  const res = await youtube.commentThreads.insert({
    part: 'snippet',
    requestBody: {
      snippet: {
        videoId: videoId,
        topLevelComment: {
          snippet: {
            textOriginal: commentText,
          },
        },
      },
    },
  });

  return res.data;
};

module.exports = {
  fetchChannelStats,
  uploadVideoToYouTube,
  postComment
};
