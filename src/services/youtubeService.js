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
 * Look up YouTube channels for the OAuth token.
 * Note: Google only returns the channel authorized for this token.
 * Brand accounts under the same Gmail need a separate OAuth (pick that channel at consent).
 */
const lookupAllChannels = async (youtube) => {
  const channelMap = new Map();

  const queries = [
    { part: 'snippet,statistics,status', mine: true, maxResults: 50 },
    // Content-partner only; ignore failures for normal Gmail accounts
    { part: 'snippet,statistics,status', managedByMe: true, maxResults: 50 },
  ];

  for (const params of queries) {
    try {
      const response = await youtube.channels.list(params);
      if (response.data.items?.length) {
        for (const item of response.data.items) {
          if (!channelMap.has(item.id)) {
            channelMap.set(item.id, item);
          }
        }
      }
    } catch (e) {
      console.warn(`[YouTube API] channel query failed:`, e.message);
    }
  }

  return Array.from(channelMap.values());
};

/**
 * Resolve a channel by @handle, legacy username, or channel ID (UC...).
 */
const resolveChannelByQuery = async (youtube, query) => {
  const raw = String(query || '').trim();
  if (!raw) return null;

  if (/^UC[\w-]{20,}$/.test(raw)) {
    const response = await youtube.channels.list({
      part: 'snippet,statistics',
      id: [raw],
      maxResults: 1,
    });
    return response.data.items?.[0] || null;
  }

  const handle = raw.startsWith('@') ? raw : `@${raw.replace(/\s+/g, '')}`;
  try {
    const byHandle = await youtube.channels.list({
      part: 'snippet,statistics',
      forHandle: handle.replace(/^@/, ''),
      maxResults: 1,
    });
    if (byHandle.data.items?.length) return byHandle.data.items[0];
  } catch (e) {
    console.warn(`[YouTube API] forHandle failed for ${handle}:`, e.message);
  }

  try {
    const byUser = await youtube.channels.list({
      part: 'snippet,statistics',
      forUsername: raw.replace(/^@/, ''),
      maxResults: 1,
    });
    if (byUser.data.items?.length) return byUser.data.items[0];
  } catch (e) {
    console.warn(`[YouTube API] forUsername failed for ${raw}:`, e.message);
  }

  try {
    const search = await youtube.search.list({
      part: 'snippet',
      q: raw,
      type: 'channel',
      maxResults: 5,
    });
    const match = (search.data.items || []).find((item) => {
      const title = (item.snippet?.title || '').toLowerCase();
      const q = raw.replace(/^@/, '').toLowerCase();
      return title.includes(q) || q.includes(title);
    }) || search.data.items?.[0];

    if (match?.snippet?.channelId) {
      const byId = await youtube.channels.list({
        part: 'snippet,statistics',
        id: [match.snippet.channelId],
        maxResults: 1,
      });
      return byId.data.items?.[0] || null;
    }
  } catch (e) {
    console.warn(`[YouTube API] channel search failed for ${raw}:`, e.message);
  }

  return null;
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
  if (!account.youtubeChannel) {
    throw new Error(
      `No YouTube channel selected for ${account.email || account.name || 'this account'}. ` +
      'Choose a channel in the wizard (Change Channel) before posting.'
    );
  }

  const youtube = await getYoutubeClientForAccount(account);
  const accountLabel = account.name || account.email || 'This account';

  // Confirm the selected channel is still available under this Gmail OAuth token
  try {
    const channels = await lookupAllChannels(youtube);
    if (channels.length) {
      const match = channels.find((ch) => ch.id === account.youtubeChannel);
      if (!match) {
        throw new Error(
          `Selected channel "${account.youtubeChannelTitle || account.youtubeChannel}" ` +
          `is not available for ${account.email}. Open Change Channel and pick a valid channel.`
        );
      }
    }
  } catch (err) {
    if (String(err.message || '').includes('not available') || String(err.message || '').includes('No YouTube channel')) {
      throw err;
    }
    console.warn(`[YouTube] Channel pre-check skipped for ${account.email}: ${err.message}`);
  }

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

    return {
      ...res.data,
      commentId,
      youtubeChannel: account.youtubeChannel,
      youtubeChannelTitle: account.youtubeChannelTitle || '',
      email: account.email || '',
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
  lookupAllChannels,
  lookupYoutubeChannel,
  resolveChannelByQuery,
  ensureYoutubeChannel,
  syncYoutubeChannelForAccount,
  postComment,
  postCommentForAccount,
};
