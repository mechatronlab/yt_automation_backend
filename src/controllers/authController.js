const User = require('../models/User');
const GoogleAccount = require('../models/GoogleAccount');
const generateToken = require('../utils/generateJwt');
const { encrypt } = require('../utils/encryption');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');

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
// VPN config is NOT assigned here — user uploads .ovpn separately.
const connectGoogleAccount = async (req, res, next) => {
  try {
    const { code } = req.body;

    if (!code) {
      res.status(400);
      throw new Error('Please provide an authorization code');
    }

    const oAuth2Client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'postmessage'
    );

    // Exchange the authorization code for tokens
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    // Get the Google profile using the tokens
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
      return res.status(200).json({
        message: 'Account tokens updated',
        accountId: account._id,
        email: profile.email,
        name: profile.name,
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

    res.status(201).json({
      message: 'Account connected successfully. Please upload an .ovpn file for VPN.',
      accountId: account._id,
      email: profile.email,
      name: profile.name,
      isActive,
      needsVpnConfig: true,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  googleLogin,
  connectGoogleAccount,
};
