#!/usr/bin/env node
'use strict';

/**
 * Prints the exact Google Cloud Console settings needed for Project 1/2/3 login.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('../src/config/envDefaults').applyEnvDefaults({ cloud: false });

const { getProjects } = require('../src/config/projects');
const { getOAuthRedirectUri } = require('../src/utils/oauthHelpers');

const productionRedirect = 'https://ytautomation-2fae5.web.app/api/auth/google/oauth-callback';
const productionOrigin = 'https://ytautomation-2fae5.web.app';
const localRedirect = getOAuthRedirectUri(null);

console.log('\n=== Fix redirect_uri_mismatch (Project 2 / Project 3) ===\n');
console.log('Add these to EVERY OAuth client (Project 1, 2, and 3):\n');
console.log('Authorized JavaScript origins:');
console.log(`  - ${productionOrigin}`);
console.log('  - http://localhost:5003');
console.log('  - http://127.0.0.1:5003\n');
console.log('Authorized redirect URIs:');
console.log(`  - ${productionRedirect}`);
console.log(`  - ${localRedirect}`);
console.log('  - http://127.0.0.1:5003/api/auth/google/oauth-callback\n');

console.log('OAuth clients in this app:\n');
for (const project of getProjects()) {
  console.log(`  ${project.label} (${project.id})`);
  console.log(`    Client ID: ${project.clientId || '(missing)'}`);
  console.log(
    `    Console: https://console.cloud.google.com/apis/credentials?project=${project.id}`
  );
  console.log('');
}

console.log('Steps:');
console.log('  1. Open each project Console link above');
console.log('  2. Edit the OAuth 2.0 Web client');
console.log('  3. Paste the redirect URI exactly (no trailing slash)');
console.log('  4. Save, wait 1–2 minutes, then try Project 2/3 login again\n');
