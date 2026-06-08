const mongoose = require('mongoose');

const googleAccountSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    googleId: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    avatar: {
      type: String,
    },
    accessToken: {
      type: String,
      required: true,
    },
    refreshToken: {
      type: String,
      // Refresh tokens aren't always provided if already authorized
    },
    isActive: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ['connected', 'disconnected'],
      default: 'connected',
    },
  },
  {
    timestamps: true,
  }
);

// Compound index to ensure a user doesn't connect the same Google account twice
googleAccountSchema.index({ user: 1, googleId: 1 }, { unique: true });

module.exports = mongoose.model('GoogleAccount', googleAccountSchema);
