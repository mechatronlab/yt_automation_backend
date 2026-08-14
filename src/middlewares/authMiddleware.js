const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { isCloudRuntime } = require('../utils/runtime');

// TEMP TEST BYPASS — remove after comment-generation testing.
const isTestGenerateBypassEnabled = () =>
  !isCloudRuntime()
  && String(process.env.ALLOW_TEST_GENERATE_WITHOUT_ACCOUNTS || '').trim() === '1';

const getTestStubUser = () => ({
  _id: 'test-user',
  id: 'test-user',
  name: 'Test User',
  email: 'test@local.dev',
});

const protect = async (req, res, next) => {
  // TEMP TEST BYPASS — allow generation without Firebase login.
  if (isTestGenerateBypassEnabled()) {
    req.user = getTestStubUser();
    return next();
  }

  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];

      // Decode token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id).select('-password');

      if (!req.user) {
        res.status(401);
        return next(new Error('Not authorized, user not found'));
      }

      next();
    } catch (error) {
      res.status(401);
      next(new Error('Not authorized, token failed'));
    }
  }

  if (!token) {
    res.status(401);
    next(new Error('Not authorized, no token'));
  }
};

module.exports = { protect };
