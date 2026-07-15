const crypto = require('node:crypto');

const ITERATIONS = 310000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  if (!storedPassword || typeof storedPassword !== 'string') return false;

  const [salt, expectedHash] = storedPassword.split(':');
  if (!salt || !expectedHash) return false;

  const actualHash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  const expectedHashBuffer = Buffer.from(expectedHash, 'hex');
  return expectedHashBuffer.length === actualHash.length
    && crypto.timingSafeEqual(expectedHashBuffer, actualHash);
}

module.exports = { hashPassword, verifyPassword };
