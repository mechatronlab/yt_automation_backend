const express = require('express');
const router = express.Router();
const multer = require('multer');
const { getStats, uploadVideo } = require('../controllers/youtubeController');
const { protect } = require('../middlewares/authMiddleware');

// Configure multer for temporary storage
const upload = multer({ dest: 'uploads/' });

router.get('/stats', protect, getStats);
// The 'video' string here is the field name Postman/frontend will use for the file
router.post('/upload', protect, upload.single('video'), uploadVideo);

module.exports = router;
