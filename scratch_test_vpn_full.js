require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { exec } = require('child_process');

const connectDB = require('./src/config/db');
const GoogleAccount = require('./src/models/GoogleAccount');
const VpnProfile = require('./src/models/VpnProfile');
const User = require('./src/models/User');
const openvpnService = require('./src/services/openvpnService');

function getPublicIp() {
  return new Promise((resolve) => {
    exec('curl -s --max-time 10 https://api.ipify.org', (err, stdout) => {
      resolve(err ? 'Failed to fetch IP' : stdout.trim());
    });
  });
}

async function runTest() {
  console.log('Connecting to database...');
  await connectDB();

  // Find a user to link to
  const user = await User.findOne({});
  if (!user) {
    console.error('❌ No user found in users collection to associate with.');
    process.exit(1);
  }
  console.log(`Using user: ${user.email} (${user._id})`);

  // Create temporary Google Account
  console.log('Creating temporary Google Account...');
  const googleAccount = await GoogleAccount.create({
    user: user._id,
    googleId: '99999999999999999999',
    email: 'testvpn@gmail.com',
    name: 'Test VPN Account',
    isActive: true,
    status: 'connected',
    accessToken: 'test-token',
  });
  console.log(`Created Google Account: ${googleAccount.email} (${googleAccount._id})`);

  // Setup the .ovpn file
  const srcConfig = '/Users/macbook/Downloads/serverListTCP/NCVPN-AU-Adelaide-TCP.ovpn';
  const destDir = path.join(process.cwd(), 'uploads', 'ovpn');
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  const destConfigPath = path.join(destDir, `${googleAccount._id}.ovpn`);

  console.log(`Copying OVPN config from ${srcConfig} to ${destConfigPath}...`);
  fs.copyFileSync(srcConfig, destConfigPath);

  // Create VpnProfile
  console.log('Creating VpnProfile...');
  const vpnProfile = await VpnProfile.create({
    googleAccount: googleAccount._id,
    user: user._id,
    configFileName: `${googleAccount._id}.ovpn`,
    originalFileName: 'NCVPN-AU-Adelaide-TCP.ovpn',
    configPath: destConfigPath,
    serverLocation: 'NCVPN AU Adelaide TCP',
  });
  console.log(`Created VpnProfile: ${vpnProfile._id}`);

  // Step 1: Check IP before VPN
  console.log('\n--- Step 1: Checking current public IP (before VPN) ---');
  const ipBefore = await getPublicIp();
  console.log(`Public IP before VPN: ${ipBefore}`);

  // Step 2: Connect
  console.log('\n--- Step 2: Connecting to VPN ---');
  try {
    const connectedProfile = await openvpnService.connect(vpnProfile);
    console.log(`✅ Connect resolved. isConnected: ${connectedProfile.isConnected}, PID: ${connectedProfile.pid}`);
  } catch (err) {
    console.error('❌ Connection failed:', err.message);
    await cleanup(googleAccount._id, vpnProfile._id, destConfigPath);
    process.exit(1);
  }

  // Step 3: Wait and check IP during VPN
  console.log('Waiting 10 seconds for the VPN tunnel to fully establish...');
  await new Promise((r) => setTimeout(r, 10000));

  console.log('\n--- Step 3: Checking public IP (during VPN) ---');
  const ipDuring = await getPublicIp();
  console.log(`Public IP during VPN: ${ipDuring}`);

  // Step 4: Disconnect
  console.log('\n--- Step 4: Disconnecting VPN ---');
  await openvpnService.disconnect(vpnProfile);
  console.log('Waiting 3 seconds for connection to tear down...');
  await new Promise((r) => setTimeout(r, 3000));

  // Step 5: Check IP after VPN
  console.log('\n--- Step 5: Checking public IP (after VPN) ---');
  const ipAfter = await getPublicIp();
  console.log(`Public IP after VPN: ${ipAfter}`);

  // Clean up database and disk
  await cleanup(googleAccount._id, vpnProfile._id, destConfigPath);
  console.log('\nDone!');
}

async function cleanup(accountId, profileId, configPath) {
  console.log('\nCleaning up test records and files...');
  try {
    if (accountId) await GoogleAccount.deleteOne({ _id: accountId });
    if (profileId) await VpnProfile.deleteOne({ _id: profileId });
    if (configPath && fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    console.log('✅ Cleanup successful.');
  } catch (e) {
    console.error('⚠️ Cleanup error:', e.message);
  }
  await mongoose.disconnect();
}

runTest().catch((err) => {
  console.error('Test script crashed:', err);
  mongoose.disconnect();
});
