/**
 * Shared Firebase Admin initializer.
 * Requires env var FIREBASE_SERVICE_ACCOUNT = full service-account JSON (as a single-line string).
 * Get it from Firebase Console -> Project Settings -> Service Accounts -> Generate new private key.
 */
const admin = require('firebase-admin');

function getAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not set.');
    }
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  return admin;
}

/** Role -> token limit per billing cycle. 'owner' is unlimited. */
const TOKEN_LIMITS = {
  free: 35000,
  pro: 50000,
  premium: 100000,
  owner: Number.MAX_SAFE_INTEGER,
};

/** Modes that require role pro/premium/owner. */
const LOCKED_MODES = new Set(['code', 'work']);
const UNLOCKED_ROLES = new Set(['pro', 'premium', 'owner']);

/** The one hardcoded, permanent Owner redeem key. Not stored in Firestore. */
const OWNER_REDEEM_CODE = 'aBcDkUbOlOng';

function parseDurationToMs(amount, unit) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === 'D' || unit === 'd') return n * 24 * 60 * 60 * 1000;
  if (unit === 'H' || unit === 'h') return n * 60 * 60 * 1000;
  return null;
}

/** '5K' -> 5000, '35000' -> 35000 */
function parseTokenAmount(str) {
  if (typeof str === 'number') return Math.floor(str);
  const s = String(str).trim().toUpperCase();
  const m = s.match(/^([\d.]+)\s*(K|M)?$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] === 'K') n *= 1000;
  if (m[2] === 'M') n *= 1000000;
  return Math.round(n);
}

/** Verifies the Firebase ID token from an Authorization: Bearer <token> header. */
async function verifyRequest(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    const err = new Error('Missing Authorization: Bearer <idToken> header.');
    err.statusCode = 401;
    throw err;
  }
  const adminSdk = getAdmin();
  try {
    const decoded = await adminSdk.auth().verifyIdToken(match[1]);
    return decoded; // { uid, email, name, ... }
  } catch (e) {
    const err = new Error('Invalid or expired ID token.');
    err.statusCode = 401;
    throw err;
  }
}

/**
 * Reads the user doc, lazily reverting an expired role grant back to 'free'.
 * Returns the (possibly updated) user doc data, never null (creates a default if missing).
 */
async function getOrInitUser(db, uid, fallbackProfile) {
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const now = Date.now();

  if (!snap.exists) {
    const fresh = {
      email: fallbackProfile?.email || null,
      name: fallbackProfile?.name || null,
      role: 'free',
      roleExpiresAt: null,
      tokenLimit: TOKEN_LIMITS.free,
      tokensUsed: 0,
      createdAt: now,
    };
    await ref.set(fresh);
    return { ref, data: fresh };
  }

  let data = snap.data();
  if (data.role !== 'owner' && data.roleExpiresAt && data.roleExpiresAt <= now) {
    data = {
      ...data,
      role: 'free',
      roleExpiresAt: null,
      tokenLimit: TOKEN_LIMITS.free,
    };
    await ref.update({ role: 'free', roleExpiresAt: null, tokenLimit: TOKEN_LIMITS.free });
  }
  return { ref, data };
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

module.exports = {
  getAdmin,
  TOKEN_LIMITS,
  LOCKED_MODES,
  UNLOCKED_ROLES,
  OWNER_REDEEM_CODE,
  parseDurationToMs,
  parseTokenAmount,
  verifyRequest,
  getOrInitUser,
  sendJson,
};
