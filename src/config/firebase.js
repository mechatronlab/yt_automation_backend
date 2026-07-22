'use strict';

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

let cachedApp = null;

const getProjectId = () => (
  process.env.FIREBASE_PROJECT_ID
  || process.env.GCLOUD_PROJECT
  || process.env.GCP_PROJECT
  || 'ytautomation-2fae5'
);

const getStorageBucket = () => {
  const explicit = (process.env.FIREBASE_STORAGE_BUCKET || '').trim();
  if (explicit) return explicit;
  return `${getProjectId()}.firebasestorage.app`;
};

const loadServiceAccount = () => {
  const jsonInline = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (jsonInline) {
    return JSON.parse(jsonInline);
  }

  const configuredPath = (process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim();
  const candidatePaths = [
    configuredPath ? path.resolve(process.cwd(), configuredPath) : null,
    path.join(process.cwd(), 'firebase-service-account.json'),
  ].filter(Boolean);

  for (const filePath of candidatePaths) {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  }

  return null;
};

const credentialsHelpMessage = () => {
  const projectId = getProjectId();
  return [
    'Firebase credentials missing.',
    '',
    '1. Open https://console.firebase.google.com/project/' + projectId + '/settings/serviceaccounts/adminsdk',
    '2. Click "Generate new private key" and save the JSON file as:',
    '   ' + path.join(process.cwd(), 'firebase-service-account.json'),
    '3. Or set FIREBASE_SERVICE_ACCOUNT_PATH in .env to the file location.',
    '4. Restart: npm start',
  ].join('\n');
};

const initFirebase = () => {
  if (cachedApp) {
    return cachedApp;
  }

  if (admin.apps.length) {
    cachedApp = admin.app();
    return cachedApp;
  }

  const projectId = getProjectId();
  const storageBucket = getStorageBucket();
  const serviceAccount = loadServiceAccount();
  const { isCloudRuntime } = require('../utils/runtime');

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id || projectId,
      storageBucket,
    });
  } else if (isCloudRuntime()) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId,
      storageBucket,
    });
  } else {
    throw new Error(credentialsHelpMessage());
  }

  cachedApp = admin.app();
  return cachedApp;
};

const getFirestore = () => initFirebase().firestore();
const getStorageBucketRef = () => initFirebase().storage().bucket(getStorageBucket());

module.exports = {
  initFirebase,
  getFirestore,
  getStorageBucketRef,
  getProjectId,
  getStorageBucket,
};
