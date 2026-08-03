#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getGoogleOAuthSetup } = require('../src/utils/oauthHelpers');

const setup = getGoogleOAuthSetup(null);
const redirectUris = [...new Set(setup.authorizedRedirectUris)];

console.log('\nGoogle Cloud Console → APIs & Services → Credentials → your OAuth client\n');
console.log('Authorized redirect URIs (add every URL you use):\n');
redirectUris.forEach((uri) => console.log(`  - ${uri}`));
console.log('\nIf you use localtunnel/ngrok, also add:');
console.log('  - https://YOUR-TUNNEL-HOST/api/auth/google/oauth-callback\n');
console.log('After saving in Google Console, wait 1–2 minutes before testing.\n');
