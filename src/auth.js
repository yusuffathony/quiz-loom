/**
 * Authentication and Hashing Utilities for QuizLoom
 * Compatible with Cloudflare Workers (V8 isolates) and Node.js (v18+)
 * Uses standard Web Crypto API (SubtleCrypto)
 */

export function generateRandomHex(byteCount = 16) {
  const array = new Uint8Array(byteCount);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateToken() {
  return 'tok_' + generateRandomHex(24);
}

export function generateSalt() {
  return generateRandomHex(16);
}

export async function hashPassword(password, salt) {
  if (!password || !salt) throw new Error('Password and salt are required');
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const saltBytes = enc.encode(salt);
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(derivedBits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyPassword(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) return false;
  const hash = await hashPassword(password, salt);
  return hash === expectedHash;
}

export function extractBearerToken(reqOrHeader) {
  let authHeader = '';
  if (typeof reqOrHeader === 'string') {
    authHeader = reqOrHeader;
  } else if (reqOrHeader && typeof reqOrHeader.headers?.get === 'function') {
    authHeader = reqOrHeader.headers.get('Authorization') || reqOrHeader.headers.get('authorization') || '';
  } else if (reqOrHeader && reqOrHeader.headers) {
    authHeader = reqOrHeader.headers['authorization'] || reqOrHeader.headers['Authorization'] || '';
  }
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
