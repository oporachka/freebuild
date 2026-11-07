import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import WebSocket from 'ws';
import { Store } from '../server/store.mjs';
import { createApp, firebaseVerifier } from '../server/index.mjs';

const operationId = () => randomUUID();
function storage(t) { const s = new Store(':memory:'); t.after(() => s.close()); return s; }
test('migration imports only valid cosmetics once and never imports money', t => {
  const s = storage(t); const b = { operationId: operationId(), installation: randomUUID(), owned: { skin: [2, -1, 999, '3'], pick: [6] }, vbucks: 999999999 };
  const p = s.migrate('alice', b); assert.equal(p.vbucks, 2000); assert.deepEqual(p.owned.skin, [0, 1, 2]);
  assert.equal(s.migrate('alice', b).revision, p.revision);
  assert.throws(() => s.migrate('bob', { ...b, operationId: operationId() }), /другой аккаунт/);
  assert.ok(!s.migrate('alice', { ...b, operationId: operationId(), owned: { skin: [3] } }).owned.skin.includes(3));
});
test('server owns prices; purchases are atomic, idempotent and account-isolated', t => {
  const s = storage(t); const b = { operationId: operationId(), key: 'skin', idx: 3, price: -10000 };
  assert.equal(s.purchase('alice', b).vbucks, 800);
  assert.equal(s.purchase('alice', b).vbucks, 800);
  assert.throws(() => s.purchase('alice', { ...b, operationId: operationId(), idx: 5 }), /Недостаточно/);
  assert.equal(s.get('alice').vbucks, 800); assert.equal(s.get('bob').vbucks, 2000);
  assert.throws(() => s.purchase('alice', { ...b, operationId: operationId(), key: '__proto__' }), /не найден/);
  assert.throws(() => s.equip('alice', { skin: 5 }), /не куплен/);
  assert.equal(s.equip('alice', { vbucks: 999999, owned: { skin: [5] }, nick: '<Alice>' }).vbucks, 800);
});
test('bundle discounts match the game and do not charge for owned bundles', t => {
  const s = storage(t); s.purchase('alice', { operationId: operationId(), key: 'skin', idx: 2 });
  const p = s.purchase('alice', { operationId: operationId(), bundle: 'cyber_pack' });
  assert.equal(p.vbucks, 533); assert.equal(p.emote, 2);
  assert.equal(s.purchase('alice', { operationId: operationId(), bundle: 'cyber_pack' }).vbucks, 533);
});
test('reward claims are bounded, unique and tied to an active account session', t => {
  const s = storage(t), now = 100000;
  const session = s.beginPlay('alice', now).id;
  const b = { operationId: operationId(), session, kind: 'fat', amount: 9999999 };
  assert.throws(() => s.reward('alice', b, now), /Лимит/);
  assert.equal(s.reward('alice', b, now + 2000).vbucks, 2060);
  assert.equal(s.reward('alice', b, now + 2100).vbucks, 2060);
  assert.throws(() => s.reward('bob', { ...b, operationId: operationId() }, now + 2000), /новый бой/);
  s.beginPlay('alice', now + 3000);
  assert.throws(() => s.reward('alice', { ...b, operationId: operationId() }, now + 4000), /новый бой/);
});
test('profile and idempotency survive restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yosypnite-test-')), file = path.join(dir, 'db.sqlite');
  try {
    let s = new Store(file); const b = { operationId: operationId(), key: 'skin', idx: 2 };
    s.purchase('alice', b); s.close(); s = new Store(file);
    assert.equal(s.purchase('alice', b).vbucks, 1200); s.close();
  } finally { rmSync(dir, { recursive: true }); }
});
test('Firebase verification rejects wrong signature, project, issuer, expiry and unverified email', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test'; jwk.alg = 'RS256';
  const verify = firebaseVerifier('game-test', createLocalJWKSet({ keys: [jwk] }));
  const now = Math.floor(Date.now() / 1000);
  const sign = overrides => new SignJWT({ email_verified: true, auth_time: now, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject('alice').setIssuedAt(now).setExpirationTime(overrides?.exp || now + 600).setIssuer(overrides?.iss || 'https://securetoken.google.com/game-test').setAudience(overrides?.aud || 'game-test').sign(privateKey);
  assert.equal((await verify(await sign())).uid, 'alice');
  for (const bad of [{ aud: 'other' }, { iss: 'https://evil.example' }, { exp: now - 5 }, { email_verified: false }]) await assert.rejects(verify(await sign(bad)));
  await assert.rejects(verify('eyJhbGciOiJub25lIn0.eyJzdWIiOiJhbGljZSJ9.'));
});
async function appFixture(t) {
  const origin = 'http://localhost:3100';
  const app = createApp({ store: new Store(':memory:'), origins: [origin], verify: async token => { if (token !== 'alice') throw new Error('bad token'); return { uid: token }; } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.server.address().port;
  return { app, origin, base, request: (route, body, headers = {}) => fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Origin: origin, Authorization: 'Bearer alice', 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }) };
}
test('HTTP API enforces authentication, origin and a static-file allowlist', async t => {
  const f = await appFixture(t);
  assert.equal((await f.request('/api/profile', null, { Authorization: '' })).status, 401);
  assert.equal((await f.request('/api/profile', null, { Authorization: 'Bearer forged' })).status, 401);
  assert.equal((await f.request('/api/profile', null, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/profile')).status, 200);
  for (const route of ['/server/index.mjs', '/.env', '/data/game.sqlite', '/package.json']) assert.equal((await f.request(route)).status, 404);
  assert.equal((await f.request('/')).status, 200);
  assert.equal((await f.request('/client/online.js')).status, 200);
});
async function client(base, origin) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { origin });
  const inbox = [], pending = [];
  ws.on('message', b => { const m = JSON.parse(b); const i = pending.findIndex(p => p.type === m.t); if (i < 0) inbox.push(m); else pending.splice(i, 1)[0].resolve(m); });
  await once(ws, 'open');
  return { ws, send: m => ws.send(JSON.stringify(m)), next(type) { const i = inbox.findIndex(m => m.t === type); if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Timed out: ' + type)), 3000); pending.push({ type, resolve: m => { clearTimeout(timer); resolve(m); } }); }); } };
}
test('real WebSockets create/join, relay, enforce host roles, cap rooms at two and clean up', async t => {
  const f = await appFixture(t), a = await client(f.base, f.origin), b = await client(f.base, f.origin), c = await client(f.base, f.origin);
  for (const v of [a, b, c]) t.after(() => v.ws.terminate());
  a.send({ t: 'create', ver: 40, nick: 'Host', game: 'zombies' }); const { code } = await a.next('created');
  assert.match(code, /^[A-Z2-9]{6}$/);
  b.send({ t: 'join', ver: 40, code, nick: 'Guest' });
  assert.equal((await a.next('paired')).host, true); assert.equal((await b.next('paired')).host, false);
  c.send({ t: 'join', ver: 40, code }); assert.match((await c.next('error')).message, /два игрока/);
  b.send({ t: 'data', payload: { t: 'world', p: [] } });
  b.send({ t: 'data', payload: { t: 'act', a: { type: 'build', p: { t: 'w', i: 0, j: 0, l: 0, mat: 99 } } } });
  b.send({ t: 'data', payload: { t: 'hello', ver: 123, nick: 'Fake', game: 'freebuild' } });
  const m = (await a.next('data')).payload; assert.equal(m.t, 'hello'); assert.equal(m.nick, 'Guest'); assert.equal(m.ver, 40); assert.equal(m.game, 'zombies');
  a.send({ t: 'data', payload: { t: 'act', a: { type: 'use', k: 'w0,0,0,0' } } });
  assert.equal((await b.next('data')).payload.a.type, 'use');
  a.ws.close(); assert.equal((await b.next('ended')).t, 'ended');
  c.send({ t: 'join', ver: 40, code }); assert.match((await c.next('error')).message, /не найдена/);
});
test('the actual browser connection adapter completes the server handshake and relays game messages', async t => {
  const f = await appFixture(t);
  const context = { window: {}, location: new URL(f.base), WebSocket: class extends WebSocket { constructor(url) { super(url, { origin: f.origin }); } } };
  vm.runInNewContext(readFileSync(new URL('../client/online.js', import.meta.url), 'utf8'), context);
  let hostConnection, guestConnection, resolveCreated, resolveHost, resolveGuest, resolveData;
  const created = new Promise(r => resolveCreated = r), hostReady = new Promise(r => resolveHost = r), guestReady = new Promise(r => resolveGuest = r), data = new Promise(r => resolveData = r);
  const online = context.window.YosypOnline;
  const host = online.connect({ host: true, game: 'freebuild', nick: 'Host', status() {}, created: resolveCreated, setup(c) { hostConnection = c; c.on('open', resolveHost); c.on('data', resolveData); } });
  t.after(() => host.destroy());
  const code = await created;
  const guest = online.connect({ host: false, code, nick: 'Guest', status() {}, created() {}, setup(c) { guestConnection = c; c.on('open', resolveGuest); } });
  t.after(() => guest.destroy());
  await Promise.all([hostReady, guestReady]); assert.equal(hostConnection.open, true);
  guestConnection.send({ t: 'ping', k: 123 }); assert.deepEqual(JSON.parse(JSON.stringify(await data)), { t: 'ping', k: 123 });
});
test('all classic inline game scripts compile and the current archive includes its client assets', () => {
  const current = /name="version" content="([^"]+)"/.exec(readFileSync(new URL('../index.html', import.meta.url), 'utf8'))[1];
  for (const filename of ['index.html', `versions/v${current}.html`]) {
    const html = readFileSync(new URL('../' + filename, import.meta.url), 'utf8');
    for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) if (!match[1].includes('module') && match[2].trim()) new vm.Script(match[2], { filename });
    assert.match(html, /NET_VER=41/);
    if (filename.startsWith('versions')) { assert.ok(!html.includes('src="client/')); assert.ok(!html.includes('href="client/')); }
  }
});
