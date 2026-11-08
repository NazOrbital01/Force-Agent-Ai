/**
 * POST /api/admin/create-key
 * Header: Authorization: Bearer <Firebase ID token> (caller must have role 'owner')
 * Body for a role key:
 *   { kind: 'role', role: 'pro'|'premium'|'free', amount: 1, unit: 'D'|'H',
 *     maxClaims: 10, visibility: 'public'|'private', code?: string, label?: string }
 * Body for a token key:
 *   { kind: 'token', tokenAmount: '5K', maxClaims: 50,
 *     visibility: 'public'|'private', code?: string, label?: string }
 *
 * role.amount/unit omitted (or amount=0) => permanent role grant (no expiry).
 * If `code` is omitted, a random 8-char code is generated.
 * If visibility is 'public', an announcement doc is written so every signed-in
 * client sees a popup with the package name + code. 'private' keys still work
 * for redeem, they're just never broadcast.
 */
const {
  getAdmin,
  TOKEN_LIMITS,
  verifyRequest,
  getOrInitUser,
  parseDurationToMs,
  parseTokenAmount,
  sendJson,
} = require('../_lib/firebaseAdmin');

function randomCode(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

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

  try {
    const decoded = await verifyRequest(req);
    const admin = getAdmin();
    const db = admin.firestore();

    const { data: caller } = await getOrInitUser(db, decoded.uid, { email: decoded.email, name: decoded.name });
    if (caller.role !== 'owner') {
      return sendJson(res, 403, { error: 'Hanya Owner yang bisa membuat kode.' });
    }

    const visibility = body.visibility === 'private' ? 'private' : 'public';
    const maxClaims = Math.max(1, parseInt(body.maxClaims, 10) || 1);
    const code = (body.code && String(body.code).trim()) || randomCode();

    const keyRef = db.collection('keys').doc(code);
    const existing = await keyRef.get();
    if (existing.exists) {
      return sendJson(res, 409, { error: `Kode "${code}" sudah dipakai, coba kode lain.` });
    }

    let keyDoc;
    let announceLabel;

    if (body.kind === 'role') {
      const role = body.role;
      if (!TOKEN_LIMITS.hasOwnProperty(role) || role === 'owner') {
        return sendJson(res, 400, { error: 'Role tidak valid.' });
      }
      const durationMs = body.amount ? parseDurationToMs(body.amount, body.unit) : null;
      if (body.amount && durationMs === null) {
        return sendJson(res, 400, { error: 'Durasi tidak valid. Pakai format: amount + unit (D/H).' });
      }
      const durationLabel = durationMs ? `${body.amount}${String(body.unit).toUpperCase()}` : 'permanen';

      keyDoc = {
        type: 'role',
        role,
        durationMs,
        durationLabel,
        maxClaims,
        claimsCount: 0,
        claimedBy: [],
        visibility,
        label: body.label || `Paket ${role[0].toUpperCase()}${role.slice(1)} ${durationLabel}`,
        createdAt: Date.now(),
        createdBy: decoded.uid,
        disabled: false,
      };
      announceLabel = keyDoc.label;
    } else if (body.kind === 'token') {
      const tokenAmount = parseTokenAmount(body.tokenAmount);
      if (!tokenAmount || tokenAmount <= 0) {
        return sendJson(res, 400, { error: 'Jumlah token tidak valid. Contoh: 5K atau 5000.' });
      }
      keyDoc = {
        type: 'token',
        tokenAmount,
        maxClaims,
        claimsCount: 0,
        claimedBy: [],
        visibility,
        label: body.label || `+${tokenAmount.toLocaleString('id-ID')} Token`,
        createdAt: Date.now(),
        createdBy: decoded.uid,
        disabled: false,
      };
      announceLabel = keyDoc.label;
    } else {
      return sendJson(res, 400, { error: 'kind harus "role" atau "token".' });
    }

    await keyRef.set(keyDoc);

    if (visibility === 'public') {
      await db.collection('announcements').add({
        code,
        label: announceLabel,
        maxClaims,
        createdAt: Date.now(),
      });
    }

    sendJson(res, 200, { ok: true, code, key: keyDoc });
  } catch (e) {
    sendJson(res, e.statusCode || 500, { error: e.message || 'Gagal membuat kode' });
  }
};
