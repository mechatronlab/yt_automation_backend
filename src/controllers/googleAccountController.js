const GoogleAccount = require('../models/GoogleAccount');
const VpnProfile = require('../models/VpnProfile');
const { encrypt } = require('../utils/encryption');
const openvpnService = require('../services/openvpnService');
const { syncYoutubeChannelForAccount } = require('../services/youtubeService');

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

    account = await GoogleAccount.create({
      user: req.user._id,
      googleId,
      email,
      name,
      avatar,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      isActive: true,
    });

    res.status(201).json({ message: 'Account added successfully', accountId: account._id, isActive: true });
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

// @desc    Activate an account (does not deactivate other accounts)
// @route   PUT /api/google-accounts/:id/active
// @access  Private
const setActiveAccount = async (req, res, next) => {
  try {
    const targetAccount = await GoogleAccount.findOne({ _id: req.params.id, user: req.user._id });

    if (!targetAccount) {
      res.status(404);
      throw new Error('Account not found');
    }

    targetAccount.isActive = true;
    await targetAccount.save();

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
      console.error('[VPN] Connect error during account activate:', vpnError.message);
      return res.status(200).json({
        message: 'Account activated, but VPN connection failed',
        accountId: targetAccount._id,
        vpnWarning: vpnError.message,
      });
    }

    res.status(200).json({
      message: 'Account activated',
      accountId: targetAccount._id,
      vpn: vpnInfo,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Deactivate an account manually
// @route   PUT /api/google-accounts/:id/inactive
// @access  Private
const setInactiveAccount = async (req, res, next) => {
  try {
    const targetAccount = await GoogleAccount.findOne({ _id: req.params.id, user: req.user._id });

    if (!targetAccount) {
      res.status(404);
      throw new Error('Account not found');
    }

    targetAccount.isActive = false;
    await targetAccount.save();

    try {
      const vpnProfile = await VpnProfile.findOne({ googleAccount: targetAccount._id });
      if (vpnProfile) {
        await openvpnService.disconnect(vpnProfile);
      }
    } catch (vpnError) {
      console.error('[VPN] Disconnect error during account deactivate:', vpnError.message);
    }

    res.status(200).json({
      message: 'Account deactivated',
      accountId: targetAccount._id,
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

// @desc    Update a connected Google account (details + optional VPN config)
// @route   PUT /api/google-accounts/:id
// @access  Private
const updateAccount = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, email, youtubeChannel, dailyMaxComments, status, persona } = req.body;

    const account = await GoogleAccount.findOne({ _id: id, user: req.user._id });
    if (!account) {
      res.status(404);
      throw new Error('Account not found');
    }

    // Update text fields
    if (name) account.name = name;
    if (email) account.email = email;
    if (youtubeChannel !== undefined) account.youtubeChannel = youtubeChannel;
    if (dailyMaxComments !== undefined) account.dailyMaxComments = Number(dailyMaxComments);
    if (status) account.status = status;
    if (persona !== undefined) account.persona = persona;
    if (req.body.phoneNumber !== undefined) account.phoneNumber = req.body.phoneNumber;

    await account.save();

    // Check if a VPN config file was uploaded
    let vpnInfo = null;
    if (req.file) {
      const originalName = req.file.originalname || '';
      if (!originalName.toLowerCase().endsWith('.ovpn')) {
        res.status(400);
        throw new Error('Only .ovpn files are allowed');
      }

      // Save VPN file and update database profile
      const vpnProfile = await openvpnService.saveUploadedConfig(req.file, id, req.user._id);
      vpnInfo = {
        originalFileName: vpnProfile.originalFileName,
        serverLocation: vpnProfile.serverLocation,
        isConnected: vpnProfile.isConnected,
      };
    }

    res.status(200).json({
      message: 'Account details updated successfully',
      account: {
        _id: account._id,
        name: account.name,
        email: account.email,
        youtubeChannel: account.youtubeChannel,
        dailyMaxComments: account.dailyMaxComments,
        status: account.status,
        persona: account.persona,
        phoneNumber: account.phoneNumber,
      },
      vpn: vpnInfo,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Re-check whether this Google account has a YouTube channel
// @route   POST /api/google-accounts/:id/refresh-channel
// @access  Private
const refreshYoutubeChannel = async (req, res, next) => {
  try {
    const account = await GoogleAccount.findOne({ _id: req.params.id, user: req.user._id });
    if (!account) {
      res.status(404);
      throw new Error('Account not found');
    }

    const channel = await syncYoutubeChannelForAccount(account);

    res.status(200).json({
      message: channel
        ? `YouTube channel found: ${channel.snippet?.title || channel.id}`
        : 'No YouTube channel found for this Google account yet.',
      youtubeChannel: account.youtubeChannel || '',
      youtubeChannelTitle: account.youtubeChannelTitle || '',
      hasYoutubeChannel: !!account.youtubeChannel,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all YouTube channels associated with a Google account
// @route   GET /api/google-accounts/:id/channels
// @access  Private
const getAccountChannels = async (req, res, next) => {
  try {
    const account = await GoogleAccount.findOne({ _id: req.params.id, user: req.user._id });
    if (!account) {
      res.status(404);
      throw new Error('Account not found');
    }

    const { getYoutubeClientForAccount } = require('../services/googleTokenService');
    const { lookupAllChannels } = require('../services/youtubeService');

    let channels = [];
    let apiError = null;
    try {
      const youtube = await getYoutubeClientForAccount(account);
      const items = await lookupAllChannels(youtube);
      channels = items.map((ch) => ({
        id: ch.id,
        title: ch.snippet?.title || 'Unknown Channel',
        handle: ch.snippet?.customUrl || '',
        subscribers: ch.statistics?.subscriberCount || '0',
        avatarUrl: ch.snippet?.thumbnails?.default?.url || '',
        isSelected: account.youtubeChannel === ch.id,
      }));
    } catch (err) {
      apiError = err.message || 'Failed to fetch channels';
      console.warn(`[Channels] API fetch error for ${account.email}: ${apiError}`);
    }

    res.status(200).json({
      accountId: account._id,
      email: account.email || '',
      selectedChannelId: account.youtubeChannel || '',
      selectedChannelTitle: account.youtubeChannelTitle || '',
      channels,
      apiError,
      hint: apiError
        ? 'Reconnect this account from Accounts → Connect Account and approve YouTube permissions. If you have Brand channels, pick the channel you want on Google’s consent screen.'
        : channels.length <= 1
          ? 'Google’s API returns only the YouTube channel authorized for this login. Extra Brand channels under the same Gmail need a separate Connect Account — pick that Brand channel on Google’s screen.'
          : null,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Select active YouTube channel for commenting
// @route   POST /api/google-accounts/:id/select-channel
// @access  Private
const selectAccountChannel = async (req, res, next) => {
  try {
    const { channelId, channelTitle } = req.body;
    const account = await GoogleAccount.findOne({ _id: req.params.id, user: req.user._id });
    if (!account) {
      res.status(404);
      throw new Error('Account not found');
    }

    let resolvedId = (channelId || '').trim();
    let resolvedTitle = (channelTitle || '').trim();

    // Resolve @handle / title to a real channel id when possible
    const looksLikeId = /^UC[\w-]{20,}$/.test(resolvedId);
    if (resolvedId && !looksLikeId) {
      try {
        const { getYoutubeClientForAccount } = require('../services/googleTokenService');
        const { resolveChannelByQuery, lookupAllChannels } = require('../services/youtubeService');
        const youtube = await getYoutubeClientForAccount(account);
        const resolved = await resolveChannelByQuery(youtube, resolvedId);
        if (resolved) {
          resolvedId = resolved.id;
          resolvedTitle = resolved.snippet?.title || resolvedTitle || resolvedId;
        } else {
          // Prefer an authorized channel whose title/handle matches the typed text
          const owned = await lookupAllChannels(youtube);
          const q = resolvedId.replace(/^@/, '').toLowerCase();
          const match = owned.find((ch) => {
            const title = (ch.snippet?.title || '').toLowerCase();
            const handle = (ch.snippet?.customUrl || '').replace(/^@/, '').toLowerCase();
            return title === q || handle === q || title.includes(q) || handle.includes(q);
          });
          if (match) {
            resolvedId = match.id;
            resolvedTitle = match.snippet?.title || resolvedTitle;
          }
        }
      } catch (resolveErr) {
        console.warn(`[Channels] Could not resolve "${resolvedId}": ${resolveErr.message}`);
      }
    }

    account.youtubeChannel = resolvedId || '';
    if (resolvedTitle !== undefined) account.youtubeChannelTitle = resolvedTitle || resolvedId;
    await account.save();

    res.status(200).json({
      message: `Selected YouTube channel: ${account.youtubeChannelTitle || account.youtubeChannel}`,
      accountId: account._id,
      youtubeChannel: account.youtubeChannel,
      youtubeChannelTitle: account.youtubeChannelTitle,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  addAccount,
  getAccounts,
  uploadVpnConfig,
  setActiveAccount,
  setInactiveAccount,
  removeAccount,
  updateAccount,
  refreshYoutubeChannel,
  getAccountChannels,
  selectAccountChannel,
};
