const GoogleAccount = require('../models/GoogleAccount');
const VpnProfile = require('../models/VpnProfile');
const { encrypt } = require('../utils/encryption');
const openvpnService = require('../services/openvpnService');

// @desc    Add a new connected Google account
// @route   POST /api/google-accounts
// @access  Private
const addAccount = async (req, res, next) => {
  try {
    const { googleId, email, name, avatar, accessToken, refreshToken } = req.body;

    if (!googleId || !email || !name || !accessToken) {
      res.status(400);
      throw new Error('Please provide googleId, email, name, and accessToken');
    }

    const encryptedAccessToken = encrypt(accessToken);
    const encryptedRefreshToken = refreshToken ? encrypt(refreshToken) : undefined;

    // Check if user already connected this account
    let account = await GoogleAccount.findOne({ user: req.user._id, googleId });

    if (account) {
      // Update tokens if it already exists
      account.accessToken = encryptedAccessToken;
      if (encryptedRefreshToken) account.refreshToken = encryptedRefreshToken;
      account.name = name;
      account.avatar = avatar;
      account.status = 'connected';
      await account.save();
      
      return res.status(200).json({ message: 'Account updated successfully', accountId: account._id });
    }

    // Check if this is the user's first account. If so, make it active.
    const accountCount = await GoogleAccount.countDocuments({ user: req.user._id });
    const isActive = accountCount === 0;

    account = await GoogleAccount.create({
      user: req.user._id,
      googleId,
      email,
      name,
      avatar,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      isActive,
    });

    res.status(201).json({ message: 'Account added successfully', accountId: account._id, isActive });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all connected Google accounts (with VPN status)
// @route   GET /api/google-accounts
// @access  Private
const getAccounts = async (req, res, next) => {
  try {
    // Exclude tokens when sending data to the frontend
    const accounts = await GoogleAccount.find({ user: req.user._id })
      .select('-accessToken -refreshToken')
      .sort('-createdAt')
      .lean();

    // Fetch VPN profiles for all accounts to include vpn status
    const accountIds = accounts.map((a) => a._id);
    const vpnProfiles = await VpnProfile.find({ googleAccount: { $in: accountIds } });

    // Build a lookup map and verify process status
    const vpnMap = {};
    for (const vp of vpnProfiles) {
      const isConnected = await openvpnService.isProfileConnected(vp);
      vpnMap[vp.googleAccount.toString()] = {
        hasVpnConfig: true,
        originalFileName: vp.originalFileName,
        serverLocation: vp.serverLocation,
        isVpnConnected: isConnected,
      };
    }

    // Attach VPN info to each account
    const accountsWithVpn = accounts.map((acc) => ({
      ...acc,
      vpn: vpnMap[acc._id.toString()] || { hasVpnConfig: false },
    }));

    res.status(200).json(accountsWithVpn);
  } catch (error) {
    next(error);
  }
};

// @desc    Upload an .ovpn file for a Google account
// @route   POST /api/google-accounts/:id/vpn-config
// @access  Private
const uploadVpnConfig = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Verify the account belongs to this user
    const account = await GoogleAccount.findOne({ _id: id, user: req.user._id });
    if (!account) {
      res.status(404);
      throw new Error('Account not found');
    }

    // Validate file upload
    if (!req.file) {
      res.status(400);
      throw new Error('Please upload an .ovpn file');
    }

    // Validate file extension
    const originalName = req.file.originalname || '';
    if (!originalName.toLowerCase().endsWith('.ovpn')) {
      res.status(400);
      throw new Error('Only .ovpn files are allowed');
    }

    // Save the file and create/update VpnProfile
    const vpnProfile = await openvpnService.saveUploadedConfig(req.file, id, req.user._id);

    res.status(200).json({
      message: 'VPN config uploaded successfully',
      vpn: {
        originalFileName: vpnProfile.originalFileName,
        serverLocation: vpnProfile.serverLocation,
        isConnected: vpnProfile.isConnected,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Set an account as active
// @route   PUT /api/google-accounts/:id/active
// @access  Private
const setActiveAccount = async (req, res, next) => {
  try {
    const targetAccount = await GoogleAccount.findOne({ _id: req.params.id, user: req.user._id });

    if (!targetAccount) {
      res.status(404);
      throw new Error('Account not found');
    }

    // 1. Disconnect current VPN before switching
    try {
      await openvpnService.disconnectAll();
    } catch (vpnError) {
      console.error('[VPN] Disconnect error during account switch:', vpnError.message);
    }

    // 2. Set all other accounts to inactive
    await GoogleAccount.updateMany(
      { user: req.user._id, _id: { $ne: targetAccount._id } },
      { $set: { isActive: false } }
    );

    // 3. Set target account to active
    targetAccount.isActive = true;
    await targetAccount.save();

    // 4. Connect the new account's VPN
    let vpnInfo = null;
    try {
      const vpnProfile = await VpnProfile.findOne({ googleAccount: targetAccount._id });
      if (vpnProfile) {
        await openvpnService.connect(vpnProfile);
        vpnInfo = {
          serverLocation: vpnProfile.serverLocation,
          originalFileName: vpnProfile.originalFileName,
          isConnected: true,
        };
      }
    } catch (vpnError) {
      console.error('[VPN] Connect error during account switch:', vpnError.message);
      res.status(500);
      throw new Error(`Active account switched, but VPN connection failed: ${vpnError.message}`);
    }

    res.status(200).json({
      message: 'Active account updated',
      accountId: targetAccount._id,
      vpn: vpnInfo,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Remove a connected account
// @route   DELETE /api/google-accounts/:id
// @access  Private
const removeAccount = async (req, res, next) => {
  try {
    const targetAccount = await GoogleAccount.findOne({ _id: req.params.id, user: req.user._id });

    if (!targetAccount) {
      res.status(404);
      throw new Error('Account not found');
    }

    // 1. Disconnect and release VPN before deleting account
    try {
      await openvpnService.releaseConfig(targetAccount._id);
    } catch (vpnError) {
      console.error('[VPN] Cleanup error during account removal:', vpnError.message);
    }

    await targetAccount.deleteOne();

    // If the removed account was the active one, switch to another account + its VPN
    if (targetAccount.isActive) {
      const anotherAccount = await GoogleAccount.findOne({ user: req.user._id });
      if (anotherAccount) {
        anotherAccount.isActive = true;
        await anotherAccount.save();

        // Connect the new active account's VPN
        try {
          const vpnProfile = await VpnProfile.findOne({ googleAccount: anotherAccount._id });
          if (vpnProfile) {
            await openvpnService.connect(vpnProfile);
          }
        } catch (vpnError) {
          console.error('[VPN] Auto-connect error after account removal:', vpnError.message);
        }
      }
    }

    res.status(200).json({ message: 'Account removed successfully', id: req.params.id });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  addAccount,
  getAccounts,
  uploadVpnConfig,
  setActiveAccount,
  removeAccount,
};
