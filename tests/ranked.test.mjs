import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import WebSocket from 'ws';
import { Store } from '../server/store.mjs';
import { Ranked, searchRange } from '../server/ranked.mjs';
import { createGeometry } from '../server/ranked-geometry.mjs';
import { createApp } from '../server/index.mjs';

function fixture(t, options = {}) {
  const store = new Store(':memory:'); let now = 100000;
  const ranked = new Ranked({ store, verify: async uid => { if (uid === 'bad') throw new Error('invalid token'); return { uid }; }, send: (ws, m) => ws.messages.push(structuredClone(m)), now: () => now, autoTick: false, timings: { countdown: 10, between: 20 }, ...options });
  t.after(() => { ranked.close(); store.close(); });
  const socket = () => ({ readyState: 1, messages: [], close() { this.readyState = 3; ranked.leave(this); } });
  const enqueue = async (uid, ws = socket()) => { await ranked.enqueue(ws, { t: 'ranked_queue', ver: 41, token: uid }); return ws; };
  const advance = ms => { now += ms; ranked.tick(); };
  return { store, ranked, socket, enqueue, advance, time: () => now };
}
async function duel(t) {
  const f = fixture(t), a = await f.enqueue('alice'), b = await f.enqueue('bob'), match = a.rankedMatch;
  f.ranked.handle(a, { t: 'ranked_ready' }); f.ranked.handle(b, { t: 'ranked_ready' }); f.advance(11);
  const data = (ws, payload, round = match.round) => f.ranked.handle(ws, { t: 'data', round, payload });
  const shot = (ws = a, extra = {}) => { const p = match.players[ws.rankIndex], q = match.players[1 - ws.rankIndex]; data(ws, { t: 'shot', s: 'ar', a: [p.x, p.y + 2, p.z], b: [[q.x, q.y + 2, q.z]], ...extra }); };
  return { ...f, a, b, match, data, shot };
}

test('existing accounts get 1000 PTS without losing purchases and clients cannot set rating', t => {
  const { store } = fixture(t);
  store.db.prepare('INSERT INTO players VALUES(?,?)').run('old', JSON.stringify({ nick: 'Old', vbucks: 950, owned: { skin: [0, 2] }, skin: 2, revision: 7 }));
  const p = store.get('old'); assert.equal(p.vbucks, 950); assert.equal(p.skin, 2); assert.equal(p.ranked.pts, 1000);
  assert.equal(store.equip('old', { pts: 999999, ranked: { pts: 999999 } }).ranked.pts, 1000);
  assert.equal(store.get('new').ranked.games, 0);
});
test('Elo settlement is atomic and idempotent for both players', t => {
  const { store } = fixture(t), id = store.beginRanked('a', 'b');
  const result = store.finishRanked(id, 0, [5, 2], 'win'); assert.deepEqual(result.delta, [16, -16]);
  assert.deepEqual(store.finishRanked(id, 1, [2, 5], 'win'), result);
  assert.deepEqual(store.rating('a'), { pts: 1016, wins: 1, losses: 0, games: 1 });
  assert.deepEqual(store.rating('b'), { pts: 984, wins: 0, losses: 1, games: 1 });
  assert.equal(store.get('a').revision, 2); assert.equal(store.get('b').revision, 2);
});
test('stronger opponents give more PTS and ratings cannot fall below zero', t => {
  const { store } = fixture(t); store.get('low'); store.get('high');
  store.db.prepare('UPDATE rankings SET pts=? WHERE uid=?').run(700, 'low'); store.db.prepare('UPDATE rankings SET pts=? WHERE uid=?').run(1300, 'high');
  let id = store.beginRanked('low', 'high'); assert.ok(store.finishRanked(id, 0, [5, 4], 'win').delta[0] > 16);
  store.db.prepare('UPDATE rankings SET pts=0 WHERE uid=?').run('low');
  id = store.beginRanked('high', 'low'); store.finishRanked(id, 0, [5, 0], 'win'); assert.equal(store.rating('low').pts, 0);
});
test('unfinished scores, self-matches and concurrent matches cannot settle', t => {
  const { store } = fixture(t); assert.throws(() => store.beginRanked('a', 'a'));
  const id = store.beginRanked('a', 'b'); assert.throws(() => store.beginRanked('a', 'c'));
  assert.throws(() => store.finishRanked(id, 0, [4, 1], 'win')); assert.throws(() => store.finishRanked(id, 9, [5, 0], 'win'));
  assert.equal(store.rating('a').pts, 1000);
});
test('settled PTS persist after restart; interrupted matches are voided without losses', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yosyp-ranked-')), file = path.join(dir, 'db.sqlite');
  try {
    let store = new Store(file); const id = store.beginRanked('a', 'b'); store.finishRanked(id, 0, [5, 0], 'win'); store.beginRanked('a', 'c'); store.close();
    store = new Store(file); store.abortUnfinishedRanked(); assert.equal(store.rating('a').pts, 1016); assert.equal(store.rating('a').games, 1); assert.equal(store.rating('c').games, 0); store.close();
  } finally { rmSync(dir, { recursive: true }); }
});
test('queue requires verified identity, rejects duplicate accounts, and ignores client PTS', async t => {
  const f = fixture(t); const bad = await f.enqueue('bad'); assert.equal(bad.readyState, 3); assert.equal(f.ranked.queue.size, 0);
  const a = await f.enqueue('alice'); const duplicate = await f.enqueue('alice'); assert.equal(duplicate.readyState, 3); assert.equal(f.ranked.queue.size, 1);
  assert.equal(a.rankedQueue.pts, 1000); assert.equal(f.store.rating('alice').games, 0);
});
test('queue cancellation during token verification cannot resurrect a search', async t => {
  let resolve; const f = fixture(t, { verify: () => new Promise(r => resolve = r) }); const ws = f.socket();
  const pending = f.ranked.enqueue(ws, { t: 'ranked_queue', ver: 41, token: 'late' }); ws.close(); resolve({ uid: 'late' }); await pending;
  assert.equal(f.ranked.queue.size, 0); assert.equal(f.ranked.accounts.size, 0);
});
test('matchmaker chooses a close rating and expands its range for both waiting players', async t => {
  const f = fixture(t); f.store.get('far'); f.store.db.prepare('UPDATE rankings SET pts=1400 WHERE uid=?').run('far');
  const a = await f.enqueue('alice'), far = await f.enqueue('far'); assert.equal(f.ranked.matches.size, 0);
  const close = await f.enqueue('near'); assert.equal(a.rankedMatch, close.rankedMatch); assert.equal(f.ranked.queue.size, 1);
  a.close();
  const next = await f.enqueue('next'); f.advance(89000); assert.equal(next.rankedMatch, undefined); f.advance(1000); assert.equal(next.rankedMatch, far.rankedMatch);
  assert.equal(searchRange(0), 100); assert.equal(searchRange(900), 600);
});
test('both players must become ready before a ranked round starts', async t => {
  const f = fixture(t), a = await f.enqueue('a'), b = await f.enqueue('b'), match = a.rankedMatch;
  f.ranked.handle(a, { t: 'ranked_ready' }); assert.equal(match.phase, 'preparing');
  f.ranked.handle(b, { t: 'ranked_ready' }); assert.equal(match.phase, 'countdown'); f.advance(11); assert.equal(match.phase, 'playing');
});

test('a failed match creation reports an error and releases the failed search identity', async t => {
  const f = fixture(t), a = await f.enqueue('a'), original = f.store.beginRanked.bind(f.store);
  f.store.beginRanked = () => { throw new Error('Storage unavailable'); };
  const b = await f.enqueue('b');
  assert.equal(b.readyState, 3); assert.match(b.messages.at(-1).message, /Не удалось начать поиск/);
  assert.equal(f.ranked.accounts.has('b'), false); assert.equal(f.ranked.queue.size, 1);
  f.store.beginRanked = original;
  const retry = await f.enqueue('b'); assert.equal(a.rankedMatch, retry.rankedMatch);
});

test('ready timeout is free, round timeout compares health, ties replay and match timeout voids PTS', async t => {
  const f = fixture(t), a = await f.enqueue('a'); await f.enqueue('b'); f.advance(45000);
  assert.equal(a.messages.at(-1).reason, 'cancelled'); assert.equal(f.store.rating('a').games, 0);
  const c = await f.enqueue('c'), d = await f.enqueue('d'), match = c.rankedMatch;
  f.ranked.handle(c, { t: 'ranked_ready' }); f.ranked.handle(d, { t: 'ranked_ready' }); f.advance(11);
  match.players[0].sh = 50; f.advance(180000); assert.deepEqual(match.score, [0, 1]); assert.equal(match.phase, 'between');
  f.advance(21); f.advance(11); f.advance(180000); assert.deepEqual(match.score, [0, 1]); assert.equal(match.roundWinner, null);
  f.advance(1800001); assert.equal(c.messages.at(-1).reason, 'timeout'); assert.equal(f.store.rating('c').games, 0); assert.equal(f.store.rating('d').games, 0);
});
test('server damage produces exactly five round wins and one rating settlement', async t => {
  const f = await duel(t);
  for (let round = 1; round <= 5; round++) {
    for (let n = 0; n < 5; n++) { f.advance(200); f.shot(); }
    assert.equal(f.match.score[0], round);
    if (round < 5) { assert.equal(f.store.rating('alice').pts, 1000); f.advance(21); f.advance(11); }
  }
  assert.equal(f.match.finished, true); assert.equal(f.ranked.matches.size, 0);
  assert.equal(f.store.rating('alice').pts, 1016); assert.equal(f.store.rating('bob').pts, 984);
  assert.equal(f.a.messages.filter(m => m.t === 'ranked_result').length, 1); assert.equal(f.b.messages.filter(m => m.t === 'ranked_result').length, 1);
});
test('forged HP, damage, death, old rounds and rapid shots cannot award rounds', async t => {
  const f = await duel(t); f.data(f.a, { t: 'hit', dmg: 1e9 }); f.data(f.b, { t: 'died' });
  f.data(f.a, { t: 'st', s: { x: 2, y: 0, z: -14, yaw: 0, pitch: 0, hp: 1e9, sh: 1e9, slot: 'ar' } }); assert.equal(f.match.players[0].hp, 100);
  f.shot(); const shield = f.match.players[1].sh; assert.equal(shield, 55); f.shot(); assert.equal(f.match.players[1].sh, shield);
  f.advance(200); f.data(f.a, { t: 'shot', s: 'ar', a: [2, 2, -14], b: [[2, 2, 18]] }, 0); assert.equal(f.match.players[1].sh, shield);
  f.shot(f.a, { a: [90, 2, 18] }); assert.equal(f.match.players[1].sh, shield); assert.deepEqual(f.match.score, [0, 0]);
});
test('server rejects teleporting and corrects the client to the accepted position', async t => {
  const f = await duel(t); f.data(f.a, { t: 'st', s: { x: 90, y: 0, z: -14, yaw: 0, pitch: 0, slot: 'ar' } });
  assert.equal(f.match.players[0].x, 2); assert.deepEqual(f.a.messages.at(-1).position, [2, 0, -14]);
});
test('ranked walls block shots, use server HP, and cannot be edited by an opponent', async t => {
  const f = await duel(t); f.data(f.a, { t: 'act', a: { type: 'build', p: { t: 'w', i: 0, j: -2, l: 0, ax: 0, mat: 0, hp: 999999, own: 'g' } } });
  const key = 'w0,-2,0,0', wall = f.match.geometry.pieces.get(key); assert.equal(wall.hp, 100); assert.equal(wall.own, 'h');
  f.shot(); assert.equal(f.match.players[1].sh, 100); assert.equal(wall.hp, 86);
  f.match.players[1].z = -6; f.data(f.b, { t: 'act', a: { type: 'edit', k: key, mask: 16 } }); assert.equal(wall.mask, 0);
  f.data(f.b, { t: 'act', a: { type: 'damage', k: key, dmg: 1e9 } }); assert.equal(wall.hp, 86);
});
test('edited windows and open doors keep the same bullet openings as the client', () => {
  const g = createGeometry(), wall = { t: 'w', i: 0, j: 0, l: 0, ax: 0, mat: 0, mask: 0 };
  g.pieces.set(g.keyOf(wall), wall); g.refresh(wall); assert.ok(g.ray([2, 2, -4], [0, 0, 1], 8));
  wall.mask = 16; g.refresh(wall); assert.equal(g.ray([2, 2, -4], [0, 0, 1], 8), null);
  wall.mask = 18; wall.anim = 0; g.refresh(wall); assert.ok(g.ray([2, 1, -4], [0, 0, 1], 8));
  wall.anim = 1; g.refresh(wall); assert.equal(g.ray([2, 1, -4], [0, 0, 1], 8), null);
});
test('ammo, reload and healing duration are enforced by the server', async t => {
  const f = await duel(t);
  for (let i = 0; i < 30; i++) { f.advance(200); f.shot(f.a, { b: [[20, 2, -14]] }); }
  assert.equal(f.match.players[0].ammo.ar, 0); f.advance(200); f.shot(); assert.equal(f.match.players[1].sh, 100);
  f.data(f.a, { t: 'reload', s: 'ar' }); f.advance(1999); assert.equal(f.match.players[0].ammo.ar, 0); f.advance(1); assert.equal(f.match.players[0].ammo.ar, 30);
  f.shot(); assert.equal(f.match.players[1].sh, 55);
  f.data(f.b, { t: 'st', s: { x: 2, y: 0, z: 18, yaw: Math.PI, pitch: 0, slot: 'pot' } }); f.data(f.b, { t: 'heal', s: 'pot' });
  f.advance(1999); assert.equal(f.match.players[1].sh, 55); f.advance(1); assert.equal(f.match.players[1].sh, 100);
});
test('bounded lag compensation uses past positions while preserving current walls', async t => {
  const f = await duel(t); f.a.pingMs = 120; f.advance(200);
  f.data(f.b, { t: 'st', s: { x: 4, y: 0, z: 18, yaw: Math.PI, pitch: 0, slot: 'ar' } });
  f.shot(f.a, { b: [[2, 1, 18]] }); assert.equal(f.match.players[1].sh, 70);
});
test('leaving before readiness costs no PTS, leaving a live match loses, shutdown voids', async t => {
  const f = fixture(t), a = await f.enqueue('a'), b = await f.enqueue('b'); a.close(); assert.equal(f.store.rating('a').games, 0); assert.equal(f.store.rating('b').games, 0);
  const c = await f.enqueue('c'), d = await f.enqueue('d'); f.ranked.handle(c, { t: 'ranked_ready' }); f.ranked.handle(d, { t: 'ranked_ready' }); f.advance(11); c.close(); assert.equal(f.store.rating('c').losses, 1); assert.equal(f.store.rating('d').wins, 1);
  const e = await f.enqueue('e'), z = await f.enqueue('z'); f.ranked.handle(e, { t: 'ranked_ready' }); f.ranked.handle(z, { t: 'ranked_ready' }); f.advance(11); f.ranked.close(); assert.equal(f.store.rating('e').games, 0); assert.equal(f.store.rating('z').games, 0);
});

test('actual queue adapter pairs two authenticated WebSockets, reports server ping, and receives result', async t => {
  const origin = 'http://localhost:3100', app = createApp({ store: new Store(':memory:'), origins: [origin], verify: async token => { if (!['a', 'b'].includes(token)) throw new Error('bad'); return { uid: token }; }, ranked: { timings: { countdown: 5 } } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const context = { window: {}, location: new URL(base), WebSocket: class extends WebSocket { constructor(url) { super(url, { origin }); } } };
  vm.runInNewContext(readFileSync(new URL('../client/online.js', import.meta.url), 'utf8'), context);
  const waiting = [];
  function connect(uid) {
    let c, resolvePlay, resolveResult, resolvePing;
    const playing = new Promise(r => resolvePlay = r), result = new Promise(r => resolveResult = r), ping = new Promise(r => resolvePing = r);
    const handle = context.window.YosypOnline.queue({ getToken: async () => uid, queued() {}, matched(conn) { c = conn; c.on('data', m => { if (m.t === 'serverpong') resolvePing(m); }); c.ready(); }, state(m) { if (m.phase === 'playing') resolvePlay(m); }, result: resolveResult, hit() {}, correction() {}, error: message => waiting.push(message) });
    t.after(() => handle.destroy()); return { handle, playing, result, ping, connection: () => c };
  }
  const a = connect('a'), b = connect('b'); await Promise.all([a.playing, b.playing]);
  a.connection().send({ t: 'ping', k: 123 }); assert.equal((await a.ping).k, 123);
  a.handle.forfeit(); const [ra, rb] = await Promise.all([a.result, b.result]);
  assert.equal(ra.outcome, 'loss'); assert.equal(rb.outcome, 'win'); assert.equal(rb.rating.pts, 1016); assert.deepEqual(waiting, []);
});
