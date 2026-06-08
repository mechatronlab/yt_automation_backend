const mongoose = require('mongoose');

const vpnProfileSchema = new mongoose.Schema(
  {
    googleAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GoogleAccount',
      required: true,
      unique: true, // 1:1 mapping — each account gets exactly one VPN config
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    configFileName: {
      type: String,
      required: true, // The stored filename on disk (e.g., "{accountId}.ovpn")
    },
    originalFileName: {
      type: String,
      required: true, // The original name of the uploaded file
    },
    configPath: {
      type: String,
      required: true, // Absolute path to the file on disk
    },
    serverLocation: {
      type: String,
      default: '', // Optional — derived from original filename if possible
    },
    isConnected: {
      type: Boolean,
      default: false,
    },
    pid: {
      type: Number,
      default: null, // OS process ID of the running openvpn process
    },
    assignedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Index for fast lookups by user
vpnProfileSchema.index({ user: 1 });

module.exports = mongoose.model('VpnProfile', vpnProfileSchema);
