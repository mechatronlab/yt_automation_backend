const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
  addAccount,
  getAccounts,
  uploadVpnConfig,
  setActiveAccount,
  removeAccount,
} = require('../controllers/googleAccountController');
const { protect } = require('../middlewares/authMiddleware');

// Multer config — store .ovpn files in memory (we save them manually in the controller)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.ovpn')) {
      cb(null, true);
    } else {
      cb(new Error('Only .ovpn files are allowed'), false);
    }
  },
});

router.route('/')
  .post(protect, addAccount)
  .get(protect, getAccounts);

router.post('/:id/vpn-config', protect, upload.single('ovpnFile'), uploadVpnConfig);
router.put('/:id/active', protect, setActiveAccount);
router.delete('/:id', protect, removeAccount);

module.exports = router;
