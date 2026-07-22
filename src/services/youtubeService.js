const { google } = require('googleapis');
const fs = require('fs');
const { getYoutubeClientForAccount, isInvalidGrantError, markAccountTokenExpired, reconnectMessage } = require('./googleTokenService');

/**
 * Initializes and returns an authenticated YouTube Data API v3 client.
 * @param {string} accessToken 
 * @param {string} refreshToken 
 * @returns {object} The youtube API client
 */
const getYoutubeClient = (accessToken, refreshToken) => {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET || ''
  );

  oAuth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  return google.youtube({ version: 'v3', auth: oAuth2Client });
};

/**
 * Look up the authenticated user's YouTube channel (tries multiple API strategies).
 */
const lookupYoutubeChannel = async (youtube) => {
  const queries = [
    { part: 'snippet,statistics', mine: true, maxResults: 5 },
    { part: 'snippet,statistics', managedByMe: true, maxResults: 5 },
  ];

  for (const params of queries) {
    const response = await youtube.channels.list(params);
    if (response.data.items?.length) {
      return response.data.items[0];
    }
  }

  return null;
};

/**
 * Fetches basic channel statistics (views, subscribers, video count).
 */
const fetchChannelStats = async (accessToken, refreshToken) => {
  const youtube = getYoutubeClient(accessToken, refreshToken);
  const channel = await lookupYoutubeChannel(youtube);

  if (!channel) {
    throw new Error('No YouTube channel found for this Google Account.');
  }

  return channel;
};

/**
 * Sync channel id/title onto a GoogleAccount document.
 */
const syncYoutubeChannelForAccount = async (account) => {
  const youtube = await getYoutubeClientForAccount(account);
  const channel = await lookupYoutubeChannel(youtube);

  const channelId = channel?.id || '';
  const channelTitle = channel?.snippet?.title || '';

  account.youtubeChannel = channelId;
  account.youtubeChannelTitle = channelTitle;
  await account.save();

  return channel;
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
        privacyStatus: videoMeta.privacyStatus || 'private',
      },
    },
    media: {
      body: fs.createReadStream(fileData.path),
    },
  });

  return res.data;
};

/**
 * Ensures the Google account has a YouTube channel (required for commenting).
 */
const ensureYoutubeChannel = async (youtube) => {
  const channel = await lookupYoutubeChannel(youtube);

  if (!channel) {
    throw new Error(
      'This Google account has no YouTube channel. Open https://www.youtube.com while signed in with this account, click your profile, and choose "Create a channel". Then reconnect the account here.'
    );
  }

  return channel;
};

const formatYoutubeApiError = (error, accountLabel = 'This account') => {
  const apiMessage = error?.response?.data?.error?.message || error?.message || 'Unknown YouTube API error';
  const reasons = (error?.response?.data?.error?.errors || []).map((e) => e.reason).filter(Boolean);

  if (
    apiMessage.includes('invalid authentication') ||
    apiMessage.includes('Invalid Credentials') ||
    apiMessage.toLowerCase().includes('invalid_grant') ||
    reasons.includes('authError')
  ) {
    return `${accountLabel}: Google login expired. Go to Accounts → disconnect this account → Connect Account again and approve YouTube permissions.`;
  }

  if (
    apiMessage.includes('Google+') ||
    reasons.includes('channelNotConnected') ||
    reasons.includes('youtubeSignupRequired')
  ) {
    return `${accountLabel} has no YouTube channel yet. Open https://www.youtube.com, sign in with that Google account, create a channel from your profile menu, then use "Check channel" in Accounts or reconnect.`;
  }

  if (reasons.includes('commentsDisabled')) {
    return 'Comments are disabled on this video.';
  }

  if (reasons.includes('insufficientPermissions') || apiMessage.includes('Insufficient Permission')) {
    return 'Missing YouTube comment permission. Disconnect and reconnect this account to grant comment access.';
  }

  return apiMessage;
};

/**
 * Posts a top-level comment using a connected GoogleAccount (refreshes token if needed).
 */
const postCommentForAccount = async (account, videoId, commentText) => {
  const youtube = await getYoutubeClientForAccount(account);
  const accountLabel = account.name || account.email || 'This account';

  try {
    const res = await youtube.commentThreads.insert({
      part: 'snippet',
      requestBody: {
        snippet: {
          videoId,
          topLevelComment: {
            snippet: {
              textOriginal: commentText,
            },
          },
        },
      },
    });

    const commentId = res.data?.snippet?.topLevelComment?.id || res.data?.id || null;

    if (!account.youtubeChannel) {
      try {
        await syncYoutubeChannelForAccount(account);
      } catch (syncErr) {
        console.warn(`[YouTube] Could not sync channel for ${account.email}: ${syncErr.message}`);
      }
    }

    return {
      ...res.data,
      commentId,
    };
  } catch (error) {
    if (isInvalidGrantError(error)) {
      await markAccountTokenExpired(account, 'invalid_grant');
      throw new Error(reconnectMessage(account.email));
    }
    throw new Error(formatYoutubeApiError(error, accountLabel));
  }
};

/**
 * Legacy helper for direct token usage.
 */
const postComment = async (accessToken, refreshToken, videoId, commentText) => {
  const youtube = getYoutubeClient(accessToken, refreshToken);

  try {
    await ensureYoutubeChannel(youtube);

    const res = await youtube.commentThreads.insert({
      part: 'snippet',
      requestBody: {
        snippet: {
          videoId,
          topLevelComment: {
            snippet: {
              textOriginal: commentText,
            },
          },
        },
      },
    });

    const commentId = res.data?.snippet?.topLevelComment?.id || res.data?.id || null;

    return {
      ...res.data,
      commentId,
    };
  } catch (error) {
    throw new Error(formatYoutubeApiError(error));
  }
};

module.exports = {
  fetchChannelStats,
  uploadVideoToYouTube,
  lookupYoutubeChannel,
  ensureYoutubeChannel,
  syncYoutubeChannelForAccount,
  postComment,
  postCommentForAccount,
};
