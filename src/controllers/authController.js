const User = require('../models/User');
const GoogleAccount = require('../models/GoogleAccount');
const generateToken = require('../utils/generateJwt');
const { encrypt } = require('../utils/encryption');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const VpnProfile = require('../models/VpnProfile');
const openvpnService = require('../services/openvpnService');
const { formatVpnLocation } = require('../utils/vpnHelper');

const googleLogin = async (req, res, next) => {
  try {
    const { googleId, email, name, avatar } = req.body;

    if (!googleId || !email || !name) {
      res.status(400);
      throw new Error('Please provide googleId, email, and name');
    }
    let user = await User.findOne({ googleId });

    if (!user) {
      user = await User.create({
        googleId,
        email,
        name,
        avatar,
      });
    }

    res.status(200).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      token: generateToken(user._id),
    });
  } catch (error) {
    next(error);
  }
};

// Exchanges a Google authorization code for access/refresh tokens,
// fetches the Google profile, and saves it as a connected account.
// Connects to a random unused VPN config from serverListTCP pool,
// saves that VPN config to database for this account, and disconnects.
const connectGoogleAccount = async (req, res, next) => {
  let vpnProfile = null;
  let vpnConnected = false;
  const tempAccountId = new mongoose.Types.ObjectId();

  try {
    const { code, tempVpnProfileId } = req.body;

    if (!code) {
      res.status(400);
      throw new Error('Please provide an authorization code');
    }

    let chosenFileName = null;
    let serverLocation = 'Unknown';

    // ─── Check if VPN was pre-connected by the frontend ──────────────
    if (tempVpnProfileId) {
      vpnProfile = await VpnProfile.findById(tempVpnProfileId);
      if (vpnProfile) {
        vpnConnected = true; // Pre-connected VPN is already active!
        serverLocation = vpnProfile.serverLocation;
        chosenFileName = vpnProfile.originalFileName;
        console.log(`[connectGoogleAccount] Using pre-connected VPN: ${serverLocation} (ID: ${tempVpnProfileId})`);
      }
    }

    // ─── Pick an unused VPN config from pool if not pre-connected ────
    if (!vpnProfile) {
      const serverListDir = path.resolve(process.cwd(), 'serverListTCP');

      if (fs.existsSync(serverListDir)) {
        const allFiles = fs.readdirSync(serverListDir)
          .filter(f => f.toLowerCase().endsWith('.ovpn'))
          .sort();

        if (allFiles.length > 0) {
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

          serverLocation = formatVpnLocation(chosenFileName);
        }
      }

      // ─── If a VPN was chosen, connect to it first ───────────────────
      if (chosenFileName) {
        console.log(`[connectGoogleAccount] Selected VPN config: ${chosenFileName}`);
        
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

        console.log(`[connectGoogleAccount] Auto-connecting to VPN server: ${serverLocation}`);
        try {
          await openvpnService.connect(vpnProfile);
          vpnConnected = true;
        } catch (vpnErr) {
          console.error(`[connectGoogleAccount] VPN connection failed: ${vpnErr.message}. Proceeding without VPN.`);
          // Remove the temporary VpnProfile and file since connection failed
          try {
            await vpnProfile.deleteOne();
            if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
          } catch {}
          vpnProfile = null;
        }
      }
    }

    const oAuth2Client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'postmessage'
    );

    // Exchange the authorization code for tokens (runs through the VPN if connected!)
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    // Get the Google profile using the tokens (runs through the VPN if connected!)
    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    // Encrypt tokens before saving
    const encryptedAccessToken = encrypt(tokens.access_token);
    const encryptedRefreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined;

    // Check if this Google account is already connected
    let account = await GoogleAccount.findOne({ user: req.user._id, googleId: profile.id });

    if (account) {
      account.accessToken = encryptedAccessToken;
      if (encryptedRefreshToken) account.refreshToken = encryptedRefreshToken;
      account.name = profile.name;
      account.email = profile.email;
      account.avatar = profile.picture;
      account.status = 'connected';
      await account.save();

      // If we connected a new VPN config, clean up any old VPN config for this account
      if (vpnProfile) {
        try {
          await openvpnService.releaseConfig(account._id);
        } catch (releaseErr) {
          console.warn('[connectGoogleAccount] Error releasing old config:', releaseErr.message);
        }

        // Update the new vpnProfile association
        const uploadDir = path.resolve(process.cwd(), 'uploads', 'ovpn');
        const oldPath = vpnProfile.configPath;
        const newFileName = `${account._id}.ovpn`;
        const newPath = path.join(uploadDir, newFileName);

        if (fs.existsSync(oldPath)) {
          fs.renameSync(oldPath, newPath);
        }

        vpnProfile.googleAccount = account._id;
        vpnProfile.configFileName = newFileName;
        vpnProfile.configPath = newPath;
        await vpnProfile.save();
      }

      // Disconnect active VPN (so we return to normal network routing)
      if (vpnConnected && vpnProfile) {
        await openvpnService.disconnect(vpnProfile);
      }

      return res.status(200).json({
        message: 'Account connected successfully and tokens updated',
        accountId: account._id,
        email: profile.email,
        name: profile.name,
        vpn: vpnProfile ? {
          originalFileName: vpnProfile.originalFileName,
          serverLocation: vpnProfile.serverLocation,
        } : null,
      });
    }

    // If first account for this user, make it active
    const accountCount = await GoogleAccount.countDocuments({ user: req.user._id });
    const isActive = accountCount === 0;

    account = await GoogleAccount.create({
      user: req.user._id,
      googleId: profile.id,
      email: profile.email,
      name: profile.name,
      avatar: profile.picture,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      isActive,
    });

    // Update the new vpnProfile association
    if (vpnProfile) {
      const uploadDir = path.resolve(process.cwd(), 'uploads', 'ovpn');
      const oldPath = vpnProfile.configPath;
      const newFileName = `${account._id}.ovpn`;
      const newPath = path.join(uploadDir, newFileName);

      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath);
      }

      vpnProfile.googleAccount = account._id;
      vpnProfile.configFileName = newFileName;
      vpnProfile.configPath = newPath;
      await vpnProfile.save();
    }

    // Disconnect active VPN (so we return to normal network routing)
    if (vpnConnected && vpnProfile) {
      await openvpnService.disconnect(vpnProfile);
    }

    res.status(201).json({
      message: 'Account connected successfully and VPN auto-assigned',
      accountId: account._id,
      email: profile.email,
      name: profile.name,
      isActive,
      needsVpnConfig: false,
      vpn: vpnProfile ? {
        originalFileName: vpnProfile.originalFileName,
        serverLocation: vpnProfile.serverLocation,
      } : null,
    });
  } catch (error) {
    // Make sure we disconnect the VPN on error
    if (vpnConnected && vpnProfile) {
      try {
        await openvpnService.disconnect(vpnProfile);
      } catch (err) {
        console.error('Error disconnecting VPN on catch block:', err);
      }
    }
    // Clean up temporary profile on error
    if (vpnProfile && vpnProfile.googleAccount.toString() === tempAccountId.toString()) {
      try {
        await vpnProfile.deleteOne();
        if (fs.existsSync(vpnProfile.configPath)) fs.unlinkSync(vpnProfile.configPath);
      } catch {}
    }
    next(error);
  }
};

module.exports = {
  googleLogin,
  connectGoogleAccount
};
