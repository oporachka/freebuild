import http from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Store, fail } from './store.mjs';
import { attachRooms } from './rooms.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function firebaseVerifier(projectId, keys = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'))) {
  return async token => {
    if (!projectId) fail('Вход ещё настраивается. Пока можно играть гостем.', 503);
    const { payload } = await jwtVerify(token, keys, { algorithms: ['RS256'], issuer: `https://securetoken.google.com/${projectId}`, audience: projectId, requiredClaims: ['sub', 'iat', 'exp', 'auth_time'] });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128 || payload.email_verified !== true || payload.auth_time > Date.now() / 1000 + 30) fail('Подтверди адрес почты и войди снова.', 403);
    return { uid: payload.sub, nick: payload.name || 'Игрок' };
  };
}
export function createApp(options = {}) {
  const config = options.config || { apiKey: process.env.FIREBASE_API_KEY || '', authDomain: process.env.FIREBASE_AUTH_DOMAIN || '', projectId: process.env.FIREBASE_PROJECT_ID || '', appId: process.env.FIREBASE_APP_ID || '' };
  const origins = new Set(options.origins || (process.env.ALLOWED_ORIGINS || 'http://127.0.0.1:3100,http://localhost:3100').split(','));
  const dataDir = process.env.DATA_DIR || path.join(root, 'data');
  if (!options.store) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const store = options.store || new Store(path.join(dataDir, 'game.sqlite'));
  const verify = options.verify || firebaseVerifier(config.projectId);
  const rates = new Map();
  const ipOf = req => process.env.TRUST_PROXY === '1' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
  function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
  function limit(key, max) { const now = Date.now(); let b = rates.get(key); if (!b || now - b.t > 60000) { b = { t: now, n: 0 }; rates.set(key, b); } if (++b.n > max) fail('Слишком много запросов. Подожди минуту.', 429); }
  const cleanup = setInterval(() => { for (const [k, b] of rates) if (Date.now() - b.t > 60000) rates.delete(k); }, 60000); cleanup.unref();
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 15000 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (origin && !origins.has(origin)) fail('Этот адрес сайта не разрешён.', 403);
        if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type'); res.writeHead(204); res.end(); return; }
        limit('ip:' + ipOf(req), 240);
        if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, version: '4.0', authReady: !!config.projectId });
        if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { firebase: config, version: '4.0', startingBalance: 2000 });
        if (!['GET', 'POST'].includes(req.method)) fail('Метод не поддерживается.', 405);
        const token = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '')?.[1];
        if (!token) fail('Войди в аккаунт.', 401);
        let user;
        try { user = await verify(token); } catch (e) { if (e.status) throw e; fail('Сессия истекла. Войди снова.', 401); }
        limit('uid:' + user.uid, 180);
        store.get(user.uid, user.nick);
        if (req.method === 'GET' && url.pathname === '/api/profile') return json(res, 200, store.get(user.uid));
        if (req.method !== 'POST') fail('Не найдено.', 404);
        if (!(req.headers['content-type'] || '').startsWith('application/json')) fail('Требуется JSON.', 415);
        let bytes = 0, chunks = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) fail('Запрос слишком большой.', 413); chunks.push(chunk); }
        let b; try { b = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('Неверный JSON.'); }
        if (!b || typeof b !== 'object' || Array.isArray(b)) fail('Неверный запрос.');
        const handlers = { '/api/migrate': () => store.migrate(user.uid, b), '/api/purchase': () => store.purchase(user.uid, b), '/api/equip': () => store.equip(user.uid, b), '/api/play': () => store.beginPlay(user.uid), '/api/reward': () => store.reward(user.uid, b) };
        if (!Object.hasOwn(handlers, url.pathname)) fail('Не найдено.', 404);
        return json(res, 200, handlers[url.pathname]());
      }
      if (!['GET', 'HEAD'].includes(req.method)) fail('Метод не поддерживается.', 405);
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith('/')) p += 'index.html';
      if (!(p === '/index.html' || p === '/privacy.html' || /^\/(client|versions|docs\/assets)\//.test(p))) fail('Не найдено.', 404);
      if (p.split('/').some(x => x === '..' || x.startsWith('.')) || p.includes('\\')) fail('Не найдено.', 404);
      const absolute = await realpath(path.join(root, p));
      if (!absolute.startsWith(root + path.sep) || !(await stat(absolute)).isFile()) fail('Не найдено.', 404);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': types[path.extname(absolute)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : await readFile(absolute));
    } catch (e) { if (!res.headersSent) json(res, e.status || (e.code === 'ENOENT' ? 404 : 500), { error: e.status ? e.message : 'Не удалось выполнить запрос.' }); else res.end(); }
  });
  const rooms = attachRooms(server, { origins, ipOf });
  return { server, store, close: async () => { clearInterval(cleanup); rooms.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp(); app.server.listen(Number(process.env.PORT || 3100), process.env.HOST || '127.0.0.1', () => console.log('Yosypnite 4.0 ready'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
