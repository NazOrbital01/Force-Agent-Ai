/**
 * POST /api/auth/bootstrap
 * Header: Authorization: Bearer <Firebase ID token>
 * Creates the user's Firestore doc on first login (role: free, 35K tokens),
 * or returns the existing one (with lazy role-expiry applied).
 */
const { getAdmin, verifyRequest, getOrInitUser, sendJson } = require('../_lib/firebaseAdmin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  try {
    const decoded = await verifyRequest(req);
    const admin = getAdmin();
    const db = admin.firestore();

    const { data } = await getOrInitUser(db, decoded.uid, {
      email: decoded.email || null,
      name: decoded.name || null,
    });

    sendJson(res, 200, {
      uid: decoded.uid,
      email: data.email,
      name: data.name,
      role: data.role,
      roleExpiresAt: data.roleExpiresAt,
      tokenLimit: data.tokenLimit,
      tokensUsed: data.tokensUsed,
    });
  } catch (e) {
    sendJson(res, e.statusCode || 500, { error: e.message || 'Bootstrap failed' });
  }
};
