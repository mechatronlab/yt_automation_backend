#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const projectId = process.env.FIREBASE_PROJECT_ID || 'ytautomation-2fae5';
const target = path.join(__dirname, '..', 'firebase-service-account.json');

console.log('\nFirebase credentials setup for project:', projectId);
console.log('\nSteps:');
console.log('  1. Open:');
console.log('     https://console.firebase.google.com/project/' + projectId + '/settings/serviceaccounts/adminsdk');
console.log('  2. Click "Generate new private key"');
console.log('  3. Save the downloaded file as:');
console.log('     ' + target);
console.log('  4. Enable Firestore + Storage in Firebase Console if not done yet');
console.log('  5. Run: npm start\n');

if (fs.existsSync(target)) {
  console.log('OK: firebase-service-account.json found.\n');
  process.exit(0);
}

console.log('MISSING: firebase-service-account.json\n');
process.exit(1);
