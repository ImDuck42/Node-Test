/**
 * proxy.js
 * Minimal CORS proxy for the ososedki api client
 *
 * Usage:
 *   node proxy.js           # runs HTTP on 3000, HTTPS on 3001
 *   HTTPS_PORT=8080 HTTP_PORT=8081 node proxy.js
 */

import { URL }                                         from 'url';
import   path                                          from 'path';
import { request }                                     from 'https';
import { execSync }                                    from 'child_process';
import { fileURLToPath }                               from 'url';
import { networkInterfaces }                           from 'os';
import { createServer as createHttpServer }            from 'http';
import { createServer as createHttpsServer }           from 'https';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';


const dirname = path.dirname(fileURLToPath(import.meta.url));

const HTTPS_PORT            = process.env.HTTPS_PORT || 3001;
const HTTP_PORT             = process.env.HTTP_PORT  || 3000;
const PROXY_HOST            = process.env.PROXY_HOST || '0.0.0.0';
const ALLOWED_TARGET_ORIGIN = 'https://ososedki.com';

const FORWARD_REQUEST_HEADERS = {
  'User-Agent'               : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept'                   : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language'          : 'en-US,en;q=0.5',
  'DNT'                      : '1',
  'Connection'               : 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control'            : 'max-age=0',
};

function getLanAddresses() {
  const nets = networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  return addresses;
}

function sendError(res, status, message) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ error: message }));
}

function handleRequest(req, res) {
  // ── CORS preflight ─────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin'     : '*',
      'Access-Control-Allow-Methods'    : 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers'    : '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age'          : '86400',
    });
    return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'Method not allowed');
  }

  // Parse ?url= param
  const reqUrl = new URL(req.url, `https://localhost`);
  if (reqUrl.pathname !== '/proxy') {
    return sendError(res, 404, 'Not found — use /proxy?url=...');
  }

  const targetRaw = reqUrl.searchParams.get('url');
  if (!targetRaw) return sendError(res, 400, 'Missing ?url= parameter');

  let targetUrl;
  try {
    targetUrl = new URL(targetRaw);
  } catch {
    return sendError(res, 400, 'Invalid target URL');
  }

  if (!targetUrl.href.startsWith(ALLOWED_TARGET_ORIGIN)) {
    return sendError(res, 403, `Only ${ALLOWED_TARGET_ORIGIN} is allowed`);
  }

  console.log(`[proxy] ${req.method} → ${targetUrl.href}`);

  const options = {
    hostname: targetUrl.hostname,
    port    : targetUrl.port || 443,
    path    : targetUrl.pathname + targetUrl.search,
    method  : req.method,
    headers : FORWARD_REQUEST_HEADERS,
    timeout : 15000,
  };

  const proxyReq = request(options, proxyRes => {
    const { statusCode, headers } = proxyRes;

    if ([301, 302, 307, 308].includes(statusCode) && headers.location) {
      console.log(`[proxy] ↪ redirect → ${headers.location}`);
      return sendError(res, 502, `Redirect to ${headers.location} — not followed`);
    }

    const outHeaders = {
      'Content-Type'               : headers['content-type'] || 'text/html',
      'Access-Control-Allow-Origin': '*',
      'X-Proxy-Target'             : targetUrl.href,
    };

    res.writeHead(statusCode, outHeaders);

    if (req.method === 'HEAD') {
      res.end();
    } else {
      proxyRes.pipe(res);
      proxyRes.on('error', err => {
        console.error('[proxy] upstream stream error:', err.message);
        proxyReq.destroy();
      });
      res.on('error', err => {
        console.error('[proxy] client stream error:', err.message);
        proxyReq.destroy();
      });
    }
  });

  proxyReq.on('timeout', () => {
    console.error('[proxy] upstream timeout');
    proxyReq.destroy();
    sendError(res, 504, 'Upstream timeout');
  });

  proxyReq.on('error', err => {
    console.error('[proxy] error:', err.message);
    sendError(res, 502, `Proxy error: ${err.message}`);
  });

  // Abort upstream if the client disconnects early
  req.on('close', () => proxyReq.destroy());

  proxyReq.end();
}

function ensureSelfSignedCert() {
  const certDir  = path.join(dirname, '.proxy-certs');
  const keyPath  = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');

  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  }

  try {
    execSync('openssl version', { stdio: 'ignore' });
  } catch {
    return null;
  }

  mkdirSync(certDir, { recursive: true });

  const lanIPs   = getLanAddresses();
  const altNames = ['DNS:localhost', 'IP:127.0.0.1', ...lanIPs.map(ip => `IP:${ip}`)].join(',');

  execSync(
    `openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes ` +
    `-keyout "${keyPath}" -out "${certPath}" ` +
    `-subj "/CN=ososedki-proxy" -addext "subjectAltName=${altNames}"`,
    { stdio: 'ignore' }
  );

  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

// ──────────────────────────────────────────────────────────────────
// Start servers
// ──────────────────────────────────────────────────────────────────
const httpServer = createHttpServer(handleRequest);
httpServer.listen(HTTP_PORT, PROXY_HOST, () => {});

const certPair = ensureSelfSignedCert();
if (!certPair) {
  console.error('[https] openssl not found on this system — cannot generate a cert.');
  console.error('[https] Install openssl (usually preinstalled on Linux/macOS) and re-run.');
  process.exit(1);
}

const httpsServer = createHttpsServer(certPair, handleRequest);
httpsServer.listen(HTTPS_PORT, PROXY_HOST, () => {
  const lanIPs = getLanAddresses();
  console.log('=====================================================================');
  console.log('  HTTPS proxy running (For connecting to a LAN proxy):');
  console.log(`    https://localhost:${HTTPS_PORT}`); 
  for (const ip of lanIPs) {
    console.log(`    https://${ip}:${HTTPS_PORT}`);
  }
  console.log('');
  console.log('  HTTP proxy running (For using default Settings):');
  console.log(`    http://localhost:${HTTP_PORT}`);
  for (const ip of lanIPs) {
    console.log(`    http://${ip}:${HTTP_PORT}`);
  }
  console.log('');
  console.log('  First use of HTTPS: open the URL directly once and accept');
  console.log('  the "not private" warning. HTTP does NOT require this.');
  console.log('=====================================================================');
});

// ──────────────────────────────────────────────────────────────────
// Cleanup on Exit
// ──────────────────────────────────────────────────────────────────
['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
  function cleanupCerts() {
    const certDir = path.join(dirname, '.proxy-certs');
    if (existsSync(certDir)) {
      try {
        console.log('\n[proxy] Cleaning up .proxy-certs directory...');
        rmSync(certDir, { recursive: true, force: true });
      } catch (error) {
        console.error('[proxy] Failed to clean up certs on exit:', error.message);
      }
    }
  }

  process.on('exit', cleanupCerts);
  process.on(signal, () => {
    process.exit();
  });
});
