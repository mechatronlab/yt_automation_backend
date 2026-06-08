const express = require('express');
const router = express.Router();
const { postCommentsOnVideo } = require('../controllers/commentController');
const { protect } = require('../middlewares/authMiddleware');

// POST /api/comments/post — Post comments on a YouTube video from all connected accounts
router.post('/post', protect, postCommentsOnVideo);

module.exports = router;
