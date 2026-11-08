/**
 * Forcx Agent Ai — Vercel serverless proxy ke FreeModel API.
 * Sekarang wajib login (Firebase ID token) + enforce mode lock & token limit.
 */
const {
  getAdmin,
  LOCKED_MODES,
  UNLOCKED_ROLES,
  verifyRequest,
  getOrInitUser,
  sendJson,
} = require('./_lib/firebaseAdmin');

/** Rough token estimate when the upstream doesn't report usage: ~4 chars/token. */
function estimateTokens(str) {
  return Math.ceil((str || '').length / 4);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: { message: 'Method not allowed' } });
  }

  const apiKey = process.env.FREEMODEL_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, {
      error: {
        message:
          'FREEMODEL_API_KEY belum diatur. Buka Vercel Project Settings → Environment Variables.',
      },
    });
  }

  // ---- Auth + entitlement checks ----
  let decoded, db, user, userRef;
  try {
    decoded = await verifyRequest(req);
    const admin = getAdmin();
    db = admin.firestore();
    const r = await getOrInitUser(db, decoded.uid, { email: decoded.email, name: decoded.name });
    user = r.data;
    userRef = r.ref;
  } catch (e) {
    return sendJson(res, e.statusCode || 401, { error: { message: e.message || 'Unauthorized' } });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyBuffer = Buffer.concat(chunks);

  let parsedBody;
  try {
    parsedBody = JSON.parse(bodyBuffer.toString('utf8') || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
  }

  const mode = (parsedBody.mode || 'normal').toLowerCase();
  if (LOCKED_MODES.has(mode) && !UNLOCKED_ROLES.has(user.role)) {
    return sendJson(res, 403, {
      error: {
        message: `Mode "${mode}" terkunci. Upgrade ke Pro atau Premium untuk membuka Claude Code & Claude Work.`,
      },
    });
  }

  if (user.tokensUsed >= user.tokenLimit) {
    return sendJson(res, 403, {
      error: {
        message: `Limit token kamu (${user.tokenLimit.toLocaleString('id-ID')}) sudah habis. Redeem kode token untuk menambah limit.`,
      },
    });
  }

  const inputText = JSON.stringify(parsedBody.messages || '');
  const inputTokens = estimateTokens(inputText);

  try {
    const upstream = await fetch('https://freemodel.in/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: bodyBuffer,
    });

    res.statusCode = upstream.status;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');

    let outputChars = 0;

    if (!upstream.body) {
      const text = await upstream.text();
      outputChars = text.length;
      res.end(text);
    } else {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        outputChars += value.length;
        res.write(Buffer.from(value));
      }
      res.end();
    }

    // Best-effort usage accounting (fire-and-forget, doesn't block the response).
    const outputTokens = Math.ceil(outputChars / 4);
    userRef.update({
      tokensUsed: (user.tokensUsed || 0) + inputTokens + outputTokens,
    }).catch((e) => console.error('[api/chat] usage update failed:', e));
  } catch (err) {
    console.error('[api/chat] error:', err);
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: err.message || 'Proxy error' } });
    } else {
      res.end();
    }
  }
}
