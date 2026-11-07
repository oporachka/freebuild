import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual game bridge, menu handlers and queue UI. Rendering, audio,
// pointer lock and transport are boundaries here; this is not a browser test.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../client/ranked.js', import.meta.url), 'utf8');
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
function span(first, next) {
  const a = html.indexOf(first), b = html.indexOf(next, a + first.length);
  assert.ok(a >= 0 && b > a, 'Missing game source: ' + first);
  return html.slice(a, b);
}
function line(marker) {
  const found = html.split('\n').find(s => s.includes(marker));
  assert.ok(found, 'Missing handler: ' + marker); return found;
}
const source = [
  span('const NET_VER=', 'const rp='),
  span('function netHandle(', 'function netTick('),
  span('async function hostRoom()', 'async function joinRoom('),
  span('async function joinRoom(', 'function setupConn('),
  span('function respawn()', 'function damageDummy('),
  span('function initWorld(which)', '// ================= Меню'),
  span('function setMode(m)', 'function lock()'),
  span('function update(dt)', 'function drawChar('),
  line('function setLobbyTab('), line('function showLobby('),
  line('function play()'), line("$('bResume').onclick="),
  line("$('bMenu').onclick="), line("getElementById('bOnBack').onclick="),
  span('window.GameRankedBridge=', 'window.GameAccountBridge=')
].join('\n');
const plain = value => JSON.parse(JSON.stringify(value));
function classes() {
  const values = new Set();
  return { add: v => values.add(v), remove: v => values.delete(v), contains: v => values.has(v),
    toggle(v, force) { const next = force ?? !values.has(v); if (next) values.add(v); else values.delete(v); return next; } };
}
function fixture(active = true) {
  const elements = new Map(), calls = { searches: [], notices: [], refreshes: 0, playSessions: 0, login: 0 };
  const $ = id => {
    assert.ok(ids.has(id), 'Missing HTML element: ' + id);
    if (!elements.has(id)) elements.set(id, { classList: classes(), style: {}, dataset: {}, open: false, textContent: '',
      showModal() { this.open = true; }, close() { this.open = false; }, setAttribute() {}, removeAttribute() {} });
    return elements.get(id);
  };
  const profile = { pts: 1000, wins: 0, losses: 0, games: 0 };
  const account = { active, uid: active ? 'alice' : null, profile: { ranked: profile },
    open() { calls.login++; }, getToken: async () => 'alice',
    refresh: async () => { calls.refreshes++; }, beginPlay() { calls.playSessions++; }, resumePlay() {} };
  const s = {
    window: { YosypAccount: account, YosypOnline: {
      queue(callbacks) { const handle = { destroyed: 0, forfeits: 0, destroy() { this.destroyed++; }, forfeit() { this.forfeits++; } }; calls.searches.push({ callbacks, handle }); return handle; },
      connect() { throw new Error('Ordinary room started during ranked search'); }
    } },
    document: { body: { classList: classes() }, getElementById: $, querySelectorAll: () => [], pointerLockElement: null },
    $, settings: { nick: 'Alice', binds: { resetCourse: 'KeyT' } },
    me: {}, rp: { el: { style: {} }, vis: false }, mode: 'menu', currentMap: 'freebuild', onlineGame: 'freebuild',
    ammo: {}, slot: 'ar', cd: 0, castT: 0, reloadT: 0, pendX: 0, pendY: 0,
    held: {}, firePressed: false, editP: null, emoteOpen: false, lockerEmote: '', dirty: false,
    pieces: new Map(), building: new Set(), animating: new Set(), frags: [], tracers: [],
    dynEl: { classList: classes() }, SFX: { init() {}, play() {} },
    touchController: { reset() {}, sync() {} }, keyName: v => v,
    performance: { now: () => 1000 }, clearTimeout() {}, clearInterval() {}, requestAnimationFrame: fn => fn(),
    setSlot: slot => { s.slot = slot; }, feed: text => calls.notices.push(text),
    resetZombies() {}, dispatch() {}, updateVitals() {}, updScore() {}, resetCourse() {}, clearShopPreview() {},
    cancelEdit() { s.editP = null; }, endEdit() { s.editP = null; }, lock() {}, hitMarker() {}, dmgNum() {}
  };
  vm.createContext(s); vm.runInContext(source, s);
  vm.runInContext(ui, s);
  const net = vm.runInContext('Net', s), controller = s.window.YosypRanked;
  function matched(host = true) {
    controller.start();
    const search = calls.searches.at(-1), connection = { open: true, readyCount: 0, handlers: {},
      on(name, fn) { this.handlers[name] = fn; }, ready() { this.readyCount++; }, close() { this.open = false; } };
    search.callbacks.matched(connection, { id: 'match-1', host, target: 5, opponent: { nick: 'Bob', pts: 1000 } });
    return { ...search, connection };
  }
  function state(extra = {}) {
    return { id: 'match-1', round: 1, phase: 'playing', health: { hp: 100, sh: 100 }, opponentHealth: { hp: 100, sh: 100 },
      ready: [true, true], score: [0, 0], remaining: 180000, ...extra };
  }
  return { s, net, $, calls, controller, account, matched, state };
}

test('guest is sent to login; search cancellation and lobby navigation release all room controls', async () => {
  const guest = fixture(false); guest.controller.start(); assert.equal(guest.calls.login, 1); assert.equal(guest.calls.searches.length, 0);
  const f = fixture(); f.controller.start(); const first = f.calls.searches[0];
  assert.equal(f.$('rankedFind').disabled, true); assert.equal(f.$('joinCode').disabled, true);
  first.callbacks.queued({ seconds: 76, range: 350 }); assert.match(f.$('rankedStatus').textContent, /1:16.*350/);
  await f.s.joinRoom('ABCDEF'); await f.s.hostRoom(); assert.equal(f.calls.searches.length, 1);
  f.$('rankedCancel').onclick(); assert.equal(first.handle.destroyed, 1); assert.equal(f.controller.busy, false);
  assert.equal(f.$('bHost').disabled, false); assert.equal(f.$('joinCode').disabled, false);
  f.controller.start(); const second = f.calls.searches[1]; f.s.showLobby();
  assert.equal(second.handle.destroyed, 1); assert.equal(f.$('online').classList.contains('hide'), true);
  f.controller.start(); f.$('bOnBack').onclick(); assert.equal(f.controller.busy, false);
});

test('matched game requires the ready button and freezes input during countdown', () => {
  const f = fixture(), match = f.matched();
  assert.equal(f.net.ranked, true); assert.equal(f.s.currentMap, 'ranked'); assert.equal(f.s.mode, 'pause');
  assert.equal(f.calls.playSessions, 0); assert.equal(f.$('bResume').textContent, 'ГОТОВ К ДУЭЛИ');
  f.$('bResume').onclick(); assert.equal(match.connection.readyCount, 1); assert.equal(f.s.mode, 'play');
  match.callbacks.state(f.state({ phase: 'countdown', remaining: 3000 }));
  assert.deepEqual([f.s.me.x, f.s.me.y, f.s.me.z], [2, 0, -14]);
  f.s.held.forward = true; f.s.firePressed = true; f.s.pendX = 50; f.s.update(.016);
  assert.equal(f.s.held.forward, false); assert.equal(f.s.firePressed, false); assert.equal(f.s.pendX, 0);
  assert.match(f.$('rankedStateLabel').textContent, /РАУНД 1 ЧЕРЕЗ 3/);
  match.callbacks.state(f.state()); assert.equal(f.net.rankPhase, 'playing');
});

test('server state applies HP and score; next round resets the arena and uses the correct spawn', () => {
  const f = fixture(), match = f.matched(false);
  match.callbacks.state(f.state()); assert.equal(f.s.me.z, 18);
  match.callbacks.state(f.state({ health: { hp: 70, sh: 0 }, score: [1, 2] }));
  assert.equal(f.s.me.hp, 70); assert.equal(f.s.me.sh, 0); assert.deepEqual(plain(f.net.score), { me: 1, op: 2 });
  f.s.pieces.set('wall', {}); f.s.held.forward = true; f.s.castT = 2; f.s.reloadT = 1;
  match.callbacks.state(f.state({ phase: 'between', roundResult: 'loss', remaining: 4000 }));
  match.callbacks.state(f.state({ phase: 'countdown', round: 2, remaining: 3000, score: [1, 3] }));
  assert.equal(f.s.pieces.size, 0); assert.equal(f.s.me.hp, 100); assert.equal(f.s.me.sh, 100);
  assert.equal(f.s.castT, 0); assert.equal(f.s.reloadT, 0); assert.equal(f.s.held.forward, false);
  assert.deepEqual(plain(f.net.score), { me: 1, op: 3 });
  match.callbacks.state(f.state({ id: 'old-match', health: { hp: 0, sh: 0 } })); assert.equal(f.s.me.hp, 100);
});

test('forfeit waits for the server result, restores the lobby and supports a fresh search', () => {
  const f = fixture(), match = f.matched(); match.callbacks.state(f.state());
  f.$('bMenu').onclick(); assert.equal(match.handle.forfeits, 1); assert.equal(f.net.ranked, true);
  match.callbacks.result({ outcome: 'loss', score: [2, 3], delta: -16, rating: { pts: 984, wins: 0, losses: 1 }, reason: 'forfeit' });
  assert.equal(f.net.ranked, false); assert.equal(f.s.mode, 'menu'); assert.equal(f.controller.busy, false);
  assert.equal(f.$('rankedResult').open, true); assert.equal(f.$('rankedResultPts').textContent, '-16 ПТС');
  assert.equal(f.$('rankedPts').textContent, '984'); assert.equal(f.$('rankedHud').classList.contains('hide'), true);
  assert.equal(f.$('bHost').disabled, false); assert.equal(f.calls.refreshes, 1);
  f.$('rankedAgain').onclick(); assert.equal(f.$('rankedResult').open, false); assert.equal(f.calls.searches.length, 2);
});

test('network failure and switching accounts cannot leave a match or result attached to the next user', () => {
  const f = fixture(), match = f.matched(); match.callbacks.error('Нет связи');
  assert.equal(f.net.ranked, false); assert.equal(f.controller.busy, false); assert.equal(match.handle.destroyed, 1);
  assert.equal(f.$('rankedStatus').textContent, 'Нет связи');
  const next = f.matched(); f.account.uid = 'bob'; f.controller.accountChanged('bob');
  assert.equal(next.handle.destroyed, 1); assert.equal(f.net.ranked, false); assert.equal(f.$('rankedPts').textContent, '—');
  f.$('rankedResult').showModal(); f.controller.accountChanged(null); assert.equal(f.$('rankedResult').open, false);
});
