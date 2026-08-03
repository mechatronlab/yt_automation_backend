const crypto = require('crypto');

const IV_LENGTH = 16; // For AES, this is always 16

/**
 * Resolve a 32-byte AES key from ENCRYPTION_KEY.
 * Accepts either a 64-char hex string or any passphrase (hashed with SHA-256).
 */
function getEncryptionKey() {
  const raw = (process.env.ENCRYPTION_KEY || '').trim();
  if (!raw) {
    throw new Error('ENCRYPTION_KEY is missing. Set it in .env (any passphrase or 64-char hex).');
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  // Passphrase / placeholder values → stable 32-byte key
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(text) {
  if (!text) return text;

  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);

  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  if (!text) return text;

  const textParts = String(text).split(':');
  if (textParts.length < 2) {
    throw new Error('Invalid encrypted token format');
  }

  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);

  return decrypted.toString();
}

module.exports = { encrypt, decrypt };
