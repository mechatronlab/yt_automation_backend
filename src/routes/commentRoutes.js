const express = require('express');
const router = express.Router();
const { 
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
  saveWizardVideos
} = require('../controllers/commentController');
const { protect } = require('../middlewares/authMiddleware');

// POST /api/comments/post — Post comments on a YouTube video from all connected accounts
router.post('/post', protect, postCommentsOnVideo);

// New Gemini-based comments generation routes
router.post('/generate-from-url', protect, generateCommentsFromUrl);
router.post('/generate-batch', protect, generateCommentsBatch);
router.post('/regenerate', protect, regenerateCommentFromUrl);
router.post('/suggest-angles', protect, suggestCommentAngles);
router.post('/search-videos', protect, searchVideos);

// Target / Discover Videos persistence
router.route('/discover-videos')
  .get(protect, getDiscoverVideos)
  .post(protect, saveDiscoverVideos);

// Commenting wizard videos persistence
router.route('/wizard-videos')
  .get(protect, getWizardVideos)
  .post(protect, saveWizardVideos);

// Campaigns persistence
router.route('/campaigns')
  .get(protect, getCampaigns)
  .post(protect, createCampaign);

router.put('/campaigns/:id', protect, updateCampaign);

module.exports = router;
