const User = require('../models/User');
const GoogleAccount = require('../models/GoogleAccount');
const generateToken = require('../utils/generateJwt');
const { generateObjectId, Types } = require('../db/objectId');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const VpnProfile = require('../models/VpnProfile');
const openvpnService = require('../services/openvpnService');
const { formatVpnLocation } = require('../utils/vpnHelper');
const { getUploadDir, getServerListDir } = require('../utils/appPaths');
const { exchangeCodeAndSaveAccount, YOUTUBE_SCOPES } = require('../services/googleOAuthService');
const {
  getOAuthRedirectUri,
  sanitizeReturnTo,
  signOAuthState,
  verifyOAuthState,
  buildGoogleAuthUrl,
  redirectWithOAuthError,
  redirectWithOAuthPayload,
} = require('../utils/oauthHelpers');
const {
  resolveProject,
  getDefaultProjectId,
  isValidProjectId,
} = require('../config/projects');

const applyProjectToUser = async (user, projectId) => {
  if (!projectId || user.projectId === projectId) return user;
  user.projectId = projectId;
  await user.save();
  return user;
};

const googleLogin = async (req, res, next) => {
  try {
    const { googleId, email, name, avatar } = req.body;
    const projectId = isValidProjectId(req.body.projectId)
      ? req.body.projectId
      : getDefaultProjectId();

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
        projectId,
      });
    } else {
      await applyProjectToUser(user, projectId);
    }

    res.status(200).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      projectId: user.projectId,
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
  const tempAccountId = new Types.ObjectId().toString();

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
      const serverListDir = getServerListDir();

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
        
        const uploadDir = getUploadDir();

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

    const saved = await exchangeCodeAndSaveAccount(req.user._id, code, {
      redirectUri: 'postmessage',
      phoneNumber: (req.body.phoneNumber || '').trim(),
    });
    const account = await GoogleAccount.findById(saved.accountId);

    if (vpnProfile) {
      try {
        await openvpnService.releaseConfig(account._id);
      } catch (releaseErr) {
        console.warn('[connectGoogleAccount] Error releasing old config:', releaseErr.message);
      }

      const uploadDir = getUploadDir();
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

    if (vpnConnected && vpnProfile) {
      await openvpnService.disconnect(vpnProfile);
    }

    const statusCode = saved.updated ? 200 : 201;
    return res.status(statusCode).json({
      message: saved.updated
        ? 'Account connected successfully and tokens updated'
        : 'Account connected successfully and VPN auto-assigned',
      accountId: account._id,
      email: saved.email,
      name: saved.name,
      isActive: saved.isActive,
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

const LOGIN_SCOPES = ['openid', 'email', 'profile'];

const exchangeLoginCode = async (code, redirectUri, project) => {
  const resolved = project || resolveProject(getDefaultProjectId());
  const clientId = resolved.clientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = resolved.clientSecret || process.env.GOOGLE_CLIENT_SECRET;

  if (!clientSecret || clientSecret === 'your-google-client-secret') {
    throw new Error(
      'Invalid Google OAuth credentials: client secret is missing for the selected project. Set OAUTH_CLIENT_SECRET_* or GOOGLE_CLIENT_SECRET in .env.'
    );
  }

  const oAuth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);

  const tokenResponse = await oAuth2Client.getToken({ code, redirect_uri: redirectUri });
  const tokens = tokenResponse.tokens;
  oAuth2Client.setCredentials(tokens);

  let googleId;
  let email;
  let name;
  let avatar;

  if (tokens.id_token) {
    const ticket = await oAuth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    googleId = payload.sub;
    email = payload.email;
    name = payload.name;
    avatar = payload.picture || '';
  } else {
    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    const { data: profile } = await oauth2.userinfo.get();
    googleId = profile.id;
    email = profile.email;
    name = profile.name;
    avatar = profile.picture || '';
  }

  if (!googleId || !email || !name) {
    throw new Error('Google did not return a complete profile');
  }

  let user = await User.findOne({ googleId });
  if (!user) {
    user = await User.create({ googleId, email, name, avatar, projectId: resolved.id });
  } else {
    if (!user.avatar && avatar) user.avatar = avatar;
    await applyProjectToUser(user, resolved.id);
  }

  return user;
};

const startGoogleOAuthLogin = (req, res) => {
  const redirectUri = getOAuthRedirectUri(req);
  const returnTo = sanitizeReturnTo(req.query.returnTo, `${redirectUri.replace(/\/api\/auth\/google\/oauth-callback$/, '')}`);
  const project = resolveProject(req.query.projectId);
  const state = signOAuthState({
    flow: 'login',
    returnTo,
    redirectUri,
    projectId: project.id,
  });

  const url = buildGoogleAuthUrl({
    redirectUri,
    state,
    scopes: LOGIN_SCOPES,
    prompt: 'select_account consent',
    clientId: project.clientId,
    clientSecret: project.clientSecret,
  });

  res.redirect(url);
};

const resolveUserFromToken = async (token) => {
  if (!token) {
    throw new Error('Not authorized, no token');
  }
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(decoded.id).select('-password');
  if (!user) {
    throw new Error('Not authorized, user not found');
  }
  return user;
};

const startGoogleOAuthConnect = async (req, res, next) => {
  try {
    const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = await resolveUserFromToken(token);
    const redirectUri = getOAuthRedirectUri(req);
    const returnTo = sanitizeReturnTo(
      req.query.returnTo,
      `${redirectUri.replace(/\/api\/auth\/google\/oauth-callback$/, '')}`
    );
    const email = (req.query.email || '').trim();
    const tempVpnProfileId = (req.query.tempVpnProfileId || '').trim();
    const phoneNumber = (req.query.phoneNumber || '').trim();

    const project = resolveProject(user.projectId);
    const state = signOAuthState({
      flow: 'connect',
      userId: user._id.toString(),
      returnTo,
      redirectUri,
      email,
      tempVpnProfileId,
      phoneNumber,
      projectId: project.id,
    });

    const url = buildGoogleAuthUrl({
      redirectUri,
      state,
      scopes: YOUTUBE_SCOPES.split(' '),
      loginHint: email || undefined,
      // Force consent so Google always shows YouTube permissions
      // (select_account alone finishes silently if the user already logged in).
      prompt: 'select_account consent',
      accessType: 'offline',
      includeGrantedScopes: false,
      clientId: project.clientId,
      clientSecret: project.clientSecret,
    });

    res.redirect(url);
  } catch (error) {
    next(error);
  }
};

const completeConnectFromOAuthCode = async (userId, code, redirectUri, options = {}) => {
  let vpnProfile = null;
  let vpnConnected = false;
  const tempAccountId = new Types.ObjectId().toString();
  const { tempVpnProfileId } = options;

  try {
    let chosenFileName = null;
    let serverLocation = 'Unknown';

    if (tempVpnProfileId) {
      vpnProfile = await VpnProfile.findById(tempVpnProfileId);
      if (vpnProfile) {
        vpnConnected = true;
        serverLocation = vpnProfile.serverLocation;
        chosenFileName = vpnProfile.originalFileName;
      }
    }

    if (!vpnProfile) {
      const serverListDir = getServerListDir();

      if (fs.existsSync(serverListDir)) {
        const allFiles = fs.readdirSync(serverListDir)
          .filter((f) => f.toLowerCase().endsWith('.ovpn'))
          .sort();

        if (allFiles.length > 0) {
          const assignedProfiles = await VpnProfile.find({}).select('originalFileName');
          const assignedNames = new Set(assignedProfiles.map((p) => p.originalFileName));
          const unusedFiles = allFiles.filter((f) => !assignedNames.has(f));
          chosenFileName = unusedFiles.length > 0
            ? unusedFiles[Math.floor(Math.random() * unusedFiles.length)]
            : allFiles[Math.floor(Math.random() * allFiles.length)];
          serverLocation = formatVpnLocation(chosenFileName);
        }
      }

      if (chosenFileName) {
        const uploadDir = getUploadDir();
        const tempConfigFileName = `${tempAccountId}.ovpn`;
        const tempConfigPath = path.join(uploadDir, tempConfigFileName);
        const origContent = fs.readFileSync(path.join(serverListDir, chosenFileName));
        fs.writeFileSync(tempConfigPath, origContent);

        vpnProfile = await VpnProfile.create({
          googleAccount: tempAccountId,
          user: userId,
          configFileName: tempConfigFileName,
          originalFileName: chosenFileName,
          configPath: tempConfigPath,
          serverLocation,
        });

        try {
          await openvpnService.connect(vpnProfile);
          vpnConnected = true;
        } catch (vpnErr) {
          try {
            await vpnProfile.deleteOne();
            if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
          } catch {}
          vpnProfile = null;
        }
      }
    }

    const saved = await exchangeCodeAndSaveAccount(userId, code, {
      redirectUri,
      phoneNumber: (options.phoneNumber || '').trim(),
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    });
    const account = await GoogleAccount.findById(saved.accountId);

    if (vpnProfile) {
      try {
        await openvpnService.releaseConfig(account._id);
      } catch (releaseErr) {
        console.warn('[completeConnectFromOAuthCode] Error releasing old config:', releaseErr.message);
      }

      const uploadDir = getUploadDir();
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

    if (vpnConnected && vpnProfile) {
      await openvpnService.disconnect(vpnProfile);
    }

    return {
      accountId: account._id.toString(),
      email: saved.email,
      name: saved.name,
      needsVpnConfig: false,
      hasYoutubeChannel: saved.hasYoutubeChannel,
      youtubeChannel: saved.youtubeChannel || '',
      channelWarning: saved.channelWarning || null,
      vpn: vpnProfile ? {
        originalFileName: vpnProfile.originalFileName,
        serverLocation: vpnProfile.serverLocation,
      } : null,
    };
  } catch (error) {
    if (vpnConnected && vpnProfile) {
      try {
        await openvpnService.disconnect(vpnProfile);
      } catch (err) {
        console.error('Error disconnecting VPN on catch block:', err);
      }
    }
    if (vpnProfile && vpnProfile.googleAccount.toString() === tempAccountId.toString()) {
      try {
        await vpnProfile.deleteOne();
        if (fs.existsSync(vpnProfile.configPath)) fs.unlinkSync(vpnProfile.configPath);
      } catch {}
    }
    throw error;
  }
};

const oauthCallback = async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      let returnTo = '/';
      try {
        if (state) returnTo = verifyOAuthState(state).returnTo;
      } catch {}
      const blocked = String(error).toLowerCase().includes('access_denied')
        || String(error).toLowerCase().includes('blocked');
      const message = blocked
        ? 'Google blocked this new account. Add its Gmail as a Test user in Google Cloud Console → OAuth consent screen (Testing), then try again.'
        : error;
      return redirectWithOAuthError(res, returnTo, message);
    }

    if (!code || !state) {
      res.status(400);
      throw new Error('Missing OAuth code or state');
    }

    const payload = verifyOAuthState(state);
    const redirectUri = payload.redirectUri || getOAuthRedirectUri(req);

    if (payload.flow === 'login') {
      const project = resolveProject(payload.projectId);
      const user = await exchangeLoginCode(code, redirectUri, project);
      const token = generateToken(user._id);
      return redirectWithOAuthPayload(res, payload.returnTo, {
        token,
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          avatar: user.avatar,
          projectId: user.projectId,
        },
      });
    }

    if (payload.flow === 'connect') {
      const project = resolveProject(payload.projectId);
      const result = await completeConnectFromOAuthCode(payload.userId, code, redirectUri, {
        tempVpnProfileId: payload.tempVpnProfileId,
        phoneNumber: payload.phoneNumber,
        clientId: project.clientId,
        clientSecret: project.clientSecret,
      });
      return redirectWithOAuthPayload(res, payload.returnTo, {
        connect: result,
      });
    }

    res.status(200).send(
      '<html><body style="font-family:sans-serif;text-align:center;padding:40px;">' +
      '<h2>Google authorization complete</h2>' +
      '<p>You can close this tab. The automation script will continue.</p>' +
      '</body></html>'
    );
  } catch (err) {
    next(err);
  }
};

module.exports = {
  googleLogin,
  connectGoogleAccount,
  startGoogleOAuthLogin,
  startGoogleOAuthConnect,
  oauthCallback,
};
