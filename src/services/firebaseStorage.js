'use strict';

const fs = require('fs');
const path = require('path');
const { getStorageBucketRef } = require('../config/firebase');

const uploadBuffer = async (storagePath, buffer, contentType = 'application/x-openvpn-profile') => {
  const file = getStorageBucketRef().file(storagePath);
  await file.save(buffer, {
    metadata: { contentType },
    resumable: false,
  });
  return storagePath;
};

const downloadToPath = async (storagePath, localPath) => {
  const file = getStorageBucketRef().file(storagePath);
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await file.download({ destination: localPath });
  return localPath;
};

const deleteObject = async (storagePath) => {
  if (!storagePath) return;
  try {
    await getStorageBucketRef().file(storagePath).delete({ ignoreNotFound: true });
  } catch (err) {
    console.warn(`[FirebaseStorage] delete failed for ${storagePath}:`, err.message);
  }
};

const ovpnStoragePath = (userId, accountId) => `ovpn/${userId}/${accountId}.ovpn`;

module.exports = {
  uploadBuffer,
  downloadToPath,
  deleteObject,
  ovpnStoragePath,
};
