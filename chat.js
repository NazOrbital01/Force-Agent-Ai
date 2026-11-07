/**
 * Forcx Agent Ai — Vercel serverless proxy ke FreeModel API.
 * API key diambil dari environment variable FREEMODEL_API_KEY.
 */

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'Method not allowed' } }));
    return;
  }

  const apiKey = process.env.FREEMODEL_API_KEY;
  if (!apiKey) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: {
          message:
            'FREEMODEL_API_KEY belum diatur. Buka Vercel Project Settings → Environment Variables.',
        },
      })
    );
    return;
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuffer = Buffer.concat(chunks);

    const upstream = await fetch('https://freemodel.in/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': req.headers['content-type'] || 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: bodyBuffer,
    });

    res.statusCode = upstream.status;
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') || 'application/json'
    );
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');

    if (!upstream.body) {
      res.end(await upstream.text());
      return;
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error('[api/chat] error:', err);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ error: { message: err.message || 'Proxy error' } })
      );
    } else {
      res.end();
    }
  }
}