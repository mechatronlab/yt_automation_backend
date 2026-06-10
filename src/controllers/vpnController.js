const mongoose = require('mongoose');
const VpnProfile = require('../models/VpnProfile');
const openvpnService = require('../services/openvpnService');
const { formatVpnLocation } = require('../utils/vpnHelper');

// @desc    Get all VPN profiles assigned to current user's accounts
// @route   GET /api/vpn/configs/assigned
// @access  Private
const getAssignedConfigs = async (req, res, next) => {
  try {
    const profiles = await VpnProfile.find({ user: req.user._id })
      .populate('googleAccount', 'email name')
      .sort('-assignedAt');

    res.status(200).json(profiles);
  } catch (error) {
    next(error);
  }
};

// @desc    Connect VPN for a specific Google account
// @route   POST /api/vpn/connect/:googleAccountId
// @access  Private
const connectVpn = async (req, res, next) => {
  try {
    const { googleAccountId } = req.params;

    const vpnProfile = await VpnProfile.findOne({
      googleAccount: googleAccountId,
      user: req.user._id,
    });

    if (!vpnProfile) {
      res.status(404);
      throw new Error('No VPN profile found for this account. Please upload an .ovpn file first.');
    }

    // Disconnect any currently active VPN first
    await openvpnService.disconnectAll();

    // Connect the requested profile's VPN
    await openvpnService.connect(vpnProfile);

    res.status(200).json({
      message: 'VPN connected successfully',
      originalFileName: vpnProfile.originalFileName,
      serverLocation: vpnProfile.serverLocation,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Disconnect current active VPN
// @route   POST /api/vpn/disconnect
// @access  Private
const disconnectVpn = async (req, res, next) => {
  try {
    await openvpnService.disconnectAll();

    res.status(200).json({
      message: 'VPN disconnected successfully',
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get current VPN connection status and public IP
// @route   GET /api/vpn/status
// @access  Private
const getVpnStatus = async (req, res, next) => {
  try {
    const status = await openvpnService.getStatus();

    // Find the currently connected profile if any
    let connectedProfile = await VpnProfile.findOne({
      user: req.user._id,
      isConnected: true,
    }).populate('googleAccount', 'email name');

    if (connectedProfile) {
      const isConnected = await openvpnService.isProfileConnected(connectedProfile);
      if (!isConnected) {
        connectedProfile = null;
      }
    }

    res.status(200).json({
      ...status,
      connectedProfile: connectedProfile
        ? {
            originalFileName: connectedProfile.originalFileName,
            serverLocation: connectedProfile.serverLocation,
            googleAccount: connectedProfile.googleAccount,
          }
        : null,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Pre-connect to a random unused VPN config from serverListTCP pool (or a specified one)
// @route   POST /api/vpn/pre-connect
// @access  Private
const preConnectVpn = async (req, res, next) => {
  const tempAccountId = new mongoose.Types.ObjectId();
  let vpnProfile = null;

  try {
    const { vpnFile } = req.body;
    const fs = require('fs');
    const path = require('path');
    const serverListDir = path.resolve(process.cwd(), 'serverListTCP');
    let chosenFileName = vpnFile || null;
    let serverLocation = 'Unknown';

    if (fs.existsSync(serverListDir)) {
      const allFiles = fs.readdirSync(serverListDir)
        .filter(f => f.toLowerCase().endsWith('.ovpn'))
        .sort();

      if (allFiles.length > 0) {
        if (!chosenFileName) {
          // Query already assigned configurations
          const assignedProfiles = await VpnProfile.find({}).select('originalFileName');
          const assignedNames = new Set(assignedProfiles.map(p => p.originalFileName));

          // Find unused files
          const unusedFiles = allFiles.filter(f => !assignedNames.has(f));

          // Pick one (prefer unused, fallback to random if all used)
          if (unusedFiles.length > 0) {
            chosenFileName = unusedFiles[Math.floor(Math.random() * unusedFiles.length)];
          } else {
            chosenFileName = allFiles[Math.floor(Math.random() * allFiles.length)];
          }
        }

        serverLocation = formatVpnLocation(chosenFileName);
      }
    }

    if (!chosenFileName) {
      res.status(404);
      throw new Error('No VPN configuration files found in serverListTCP pool.');
    }

    console.log(`[vpnController] Selected VPN config for pre-connect: ${chosenFileName}`);

    const uploadDir = path.resolve(process.cwd(), 'uploads', 'ovpn');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const tempConfigFileName = `${tempAccountId}.ovpn`;
    const tempConfigPath = path.join(uploadDir, tempConfigFileName);

    // Copy file content
    const origContent = fs.readFileSync(path.join(serverListDir, chosenFileName));
    fs.writeFileSync(tempConfigPath, origContent);

    // Create temporary profile in database
    vpnProfile = await VpnProfile.create({
      googleAccount: tempAccountId,
      user: req.user._id,
      configFileName: tempConfigFileName,
      originalFileName: chosenFileName,
      configPath: tempConfigPath,
      serverLocation: serverLocation,
    });

    // Disconnect any active connections first
    await openvpnService.disconnectAll();

    // Connect
    await openvpnService.connect(vpnProfile);

    res.status(200).json({
      message: 'VPN pre-connected successfully',
      tempVpnProfileId: vpnProfile._id,
      serverLocation: vpnProfile.serverLocation,
      originalFileName: vpnProfile.originalFileName,
    });
  } catch (error) {
    if (vpnProfile) {
      try {
        await vpnProfile.deleteOne();
        const fs = require('fs');
        if (fs.existsSync(vpnProfile.configPath)) {
          fs.unlinkSync(vpnProfile.configPath);
        }
      } catch {}
    }
  }
};

// @desc    Get list of all raw VPN config files in the serverListTCP pool
// @route   GET /api/vpn/configs/pool
// @access  Private
const getPoolConfigs = async (req, res, next) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const serverListDir = path.resolve(process.cwd(), 'serverListTCP');
    let files = [];
    
    if (fs.existsSync(serverListDir)) {
      files = fs.readdirSync(serverListDir)
        .filter(f => f.toLowerCase().endsWith('.ovpn'))
        .sort();
    }
    res.status(200).json(files);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAssignedConfigs,
  connectVpn,
  disconnectVpn,
  getVpnStatus,
  preConnectVpn,
  getPoolConfigs,
};
