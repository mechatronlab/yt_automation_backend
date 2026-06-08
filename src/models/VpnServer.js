const mongoose = require('mongoose');

const vpnServerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    ipAddress: {
      type: String,
      required: true,
      unique: true,
    },
    publicKey: {
      type: String,
      required: true,
    },
    port: {
      type: Number,
      default: 51820,
    },
    endpoint: {
      type: String,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('VpnServer', vpnServerSchema);
