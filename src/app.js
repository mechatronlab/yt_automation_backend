const express = require('express');
const cors = require('cors');
const { errorHandler } = require('./middlewares/errorMiddleware');
const authRoutes = require('./routes/authRoutes');
const googleAccountRoutes = require('./routes/googleAccountRoutes');
const youtubeRoutes = require('./routes/youtubeRoutes');
const commentRoutes = require('./routes/commentRoutes');
const vpnRoutes = require('./routes/vpnRoutes');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve the frontend HTML page

app.get('/api/health', (req, res) => {
  res.status(200).json({ message: 'API is running' });
});

app.get('/api/config/client', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID });
});

app.use('/api/auth', authRoutes);
app.use('/api/google-accounts', googleAccountRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/vpn', vpnRoutes);

app.use(errorHandler);

module.exports = app;
