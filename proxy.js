/**
 * proxy.js
 * Minimal CORS proxy for ososedki-api.browser.js
 *
 * Usage:
 *   node proxy.js          # runs on port 3000
 *   PORT=8080 node proxy.js
 */

import { createServer } from 'http';
import { request } from 'https';
import { URL } from 'url';

const PORT = process.env.PORT || 3000;
const ALLOWED_TARGET_ORIGIN = 'https://ososedki.com';

const FORWARD_REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'max-age=0',
};

function sendError(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ error: message }));
}

const server = createServer((req, res) => {
  // ── CORS preflight ─────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'Method not allowed');
  }

  // Parse ?url= param
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  if (reqUrl.pathname !== '/proxy') {
    return sendError(res, 404, 'Not found — use /proxy?url=...');
  }

  const targetRaw = reqUrl.searchParams.get('url');
  if (!targetRaw) return sendError(res, 400, 'Missing ?url= parameter');

  let targetUrl;
  try {
    targetUrl = new URL(decodeURIComponent(targetRaw));
  } catch {
    return sendError(res, 400, 'Invalid target URL');
  }

  if (!targetUrl.href.startsWith(ALLOWED_TARGET_ORIGIN)) {
    return sendError(res, 403, `Only ${ALLOWED_TARGET_ORIGIN} is allowed`);
  }

  console.log(`[proxy] ${req.method} → ${targetUrl.href}`);

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || 443,
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: FORWARD_REQUEST_HEADERS,
  };

  const proxyReq = request(options, proxyRes => {
    const { statusCode, headers } = proxyRes;

    if ([301, 302, 307, 308].includes(statusCode) && headers.location) {
      console.log(`[proxy] ↪ redirect → ${headers.location}`);
      return sendError(res, 502, `Redirect to ${headers.location} — not followed`);
    }

    const outHeaders = {
      'Content-Type': headers['content-type'] || 'text/html',
      'Access-Control-Allow-Origin': '*',
      'X-Proxy-Target': targetUrl.href,
    };

    res.writeHead(statusCode, outHeaders);

    if (req.method === 'HEAD') {
      res.end();
    } else {
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', err => {
    console.error('[proxy] error:', err.message);
    sendError(res, 502, `Proxy error: ${err.message}`);
  });

  proxyReq.end();
});

server.listen(PORT, () => {
  console.log(`✅ CORS proxy running at http://localhost:${PORT}/proxy`);
  console.log(`   Example: http://localhost:${PORT}/proxy?url=https%3A%2F%2Fososedki.com%2F`);
});