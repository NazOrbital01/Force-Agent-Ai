/**
 * POST /api/redeem
 * Header: Authorization: Bearer <Firebase ID token>
 * Body: { code: string }
 *
 * Validates the code server-side and applies it atomically, so claim counts
 * and limits can't be raced or spoofed from the browser.
 */
const {
  getAdmin,
  TOKEN_LIMITS,
  OWNER_REDEEM_CODE,
  verifyRequest,
  getOrInitUser,
  sendJson,
} = require('./_lib/firebaseAdmin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const code = (body.code || '').trim();
  if (!code) return sendJson(res, 400, { error: 'Masukkan kode redeem.' });

  try {
    const decoded = await verifyRequest(req);
    const admin = getAdmin();
    const db = admin.firestore();
    const uid = decoded.uid;

    // --- Special case: the permanent Owner key. Not stored in Firestore. ---
    if (code === OWNER_REDEEM_CODE) {
      const { ref } = await getOrInitUser(db, uid, { email: decoded.email, name: decoded.name });
      await ref.update({
        role: 'owner',
        roleExpiresAt: null,
        tokenLimit: TOKEN_LIMITS.owner,
      });
      return sendJson(res, 200, {
        ok: true,
        message: 'Owner key diterima. Role: Owner (permanen).',
        role: 'owner',
      });
    }

    // --- Normal keys live in keys/{code} ---
    const keyRef = db.collection('keys').doc(code);
    const userRef = db.collection('users').doc(uid);

    const result = await db.runTransaction(async (tx) => {
      const keySnap = await tx.get(keyRef);
      if (!keySnap.exists) {
        const err = new Error('Kode tidak ditemukan atau sudah tidak berlaku.');
        err.statusCode = 404;
        throw err;
      }
      const key = keySnap.data();

      const claimedBy = key.claimedBy || [];
      if (claimedBy.includes(uid)) {
        const err = new Error('Kamu sudah pernah redeem kode ini.');
        err.statusCode = 409;
        throw err;
      }
      if ((key.claimsCount || 0) >= key.maxClaims) {
        const err = new Error('Kuota redeem kode ini sudah habis.');
        err.statusCode = 410;
        throw err;
      }
      if (key.disabled) {
        const err = new Error('Kode ini sudah dinonaktifkan.');
        err.statusCode = 410;
        throw err;
      }

      let userSnap = await tx.get(userRef);
      let userData = userSnap.exists
        ? userSnap.data()
        : {
            email: decoded.email || null,
            name: decoded.name || null,
            role: 'free',
            roleExpiresAt: null,
            tokenLimit: TOKEN_LIMITS.free,
            tokensUsed: 0,
            createdAt: Date.now(),
          };

      let message;
      if (key.type === 'role') {
        userData.role = key.role;
        userData.roleExpiresAt = key.durationMs ? Date.now() + key.durationMs : null;
        userData.tokenLimit = TOKEN_LIMITS[key.role] ?? userData.tokenLimit;
        message = `Role "${key.role}" aktif${key.durationMs ? ` selama ${key.durationLabel || ''}` : ' (permanen)'}.`;
      } else if (key.type === 'token') {
        userData.tokenLimit = (userData.tokenLimit || TOKEN_LIMITS.free) + key.tokenAmount;
        message = `+${key.tokenAmount.toLocaleString('id-ID')} token ditambahkan ke limit kamu.`;
      } else {
        const err = new Error('Tipe kode tidak dikenali.');
        err.statusCode = 500;
        throw err;
      }

      tx.set(userRef, userData, { merge: true });
      tx.update(keyRef, {
        claimsCount: (key.claimsCount || 0) + 1,
        claimedBy: [...claimedBy, uid],
      });

      return { message, role: userData.role, tokenLimit: userData.tokenLimit };
    });

    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendJson(res, e.statusCode || 500, { error: e.message || 'Redeem gagal' });
  }
};
