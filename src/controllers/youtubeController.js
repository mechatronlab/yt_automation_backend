const fs = require('fs');
const GoogleAccount = require('../models/GoogleAccount');
const { decrypt } = require('../utils/encryption');
const { fetchChannelStats, uploadVideoToYouTube } = require('../services/youtubeService');

// Helper to get the active account and decrypt its tokens
const getActiveAccountTokens = async (userId) => {
  const account = await GoogleAccount.findOne({ user: userId, isActive: true });
  if (!account) {
    throw new Error('No active Google Account found. Please connect and activate a channel.');
  }
  
  const accessToken = decrypt(account.accessToken);
  const refreshToken = account.refreshToken ? decrypt(account.refreshToken) : null;
  
  return { accessToken, refreshToken };
};

// @desc    Get Channel Stats for Active Account
// @route   GET /api/youtube/stats
// @access  Private
const getStats = async (req, res, next) => {
  try {
    const { accessToken, refreshToken } = await getActiveAccountTokens(req.user._id);
    
    const stats = await fetchChannelStats(accessToken, refreshToken);
    
    res.status(200).json(stats);
  } catch (error) {
    next(error);
  }
};

// @desc    Upload Video to Active Account
// @route   POST /api/youtube/upload
// @access  Private
const uploadVideo = async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400);
      throw new Error('Please upload a video file');
    }

    const { title, description, tags, privacyStatus } = req.body;
    
    const { accessToken, refreshToken } = await getActiveAccountTokens(req.user._id);

    const videoMeta = { title, description, tags, privacyStatus };
    
    // Upload the file
    const youtubeResponse = await uploadVideoToYouTube(accessToken, refreshToken, req.file, videoMeta);
    
    // Cleanup temporary file after upload
    fs.unlinkSync(req.file.path);

    res.status(200).json({
      message: 'Video uploaded successfully',
      videoId: youtubeResponse.id,
      url: `https://youtu.be/${youtubeResponse.id}`,
      data: youtubeResponse
    });
  } catch (error) {
    // Attempt cleanup if something goes wrong
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    next(error);
  }
};

module.exports = {
  getStats,
  uploadVideo
};
