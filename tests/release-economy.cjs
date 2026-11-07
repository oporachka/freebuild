'use strict';

// Executes the actual release functions extracted from index.html. Only their
// browser/network boundaries are stubbed; no copied economy implementation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const htmlPath = path.resolve(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// These selected units contain strings/comments, but no template expressions or
// regex literals containing braces. Fail loudly if a source unit is not found.
function bracedUnit(marker) {
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, 'Missing actual source unit: ' + marker);
  const open = html.indexOf('{', start);
  let depth = 0, quote = '', escaped = false, comment = '';
  for (let i = open; i < html.length; i++) {
    const c = html[i], next = html[i + 1];
    if (comment === '//') { if (c === '\n') comment = ''; continue; }
    if (comment === '/*') { if (c === '*' && next === '/') { comment = ''; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && (next === '/' || next === '*')) { comment = c + next; i++; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error('Unclosed actual source unit: ' + marker);
}

const source = [
  bracedUnit('const Net=') + ';',
  ...[
    'setupConn', 'startMatch', 'netHandle', 'zombieHit', 'applyZombieHit',
    'addVbucks', 'isOwned', 'radialItems', 'closeRadial',
  ].map(name => bracedUnit('function ' + name + '(')),
  'globalThis.Net = Net;',
].join('\n');
new vm.Script(source, { filename: htmlPath + ':selected-release-functions' });

class Connection extends EventEmitter {
  constructor() { super(); this.open = true; this.sent = []; this.closes = 0; }
  send(message) { this.sent.push(JSON.parse(JSON.stringify(message))); }
  close() { this.closes++; this.open = false; }
}

function fixture(role = 'guest') {
  const calls = { saved: [], synced: 0, feeds: [], intervals: 0, cleared: [], bursts: 0, emotes: [], respawns: 0 };
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {} },
    });
    return elements.get(id);
  };
  let now = 10_000;
  const sandbox = {
    window: {},
    document: { getElementById: element },
    $: element,
    settings: { vbucks: 0, phrase: 1, owned: { phrase: [0, 1], emote: [0, 1] } },
    Z: { list: [], kills: 0 },
    currentMap: 'zombies', mode: 'play', onlineGame: 'zombies', NET_VER: 30,
    rp: { vis: true, dead: false, st: null, tgt: null, nick: '', el: { style: {} } },
    SFX: { play() {} },
    performance: { now: () => now },
    setInterval() { return ++calls.intervals; },
    clearInterval(id) { calls.cleared.push(id); },
    clearTimeout() {},
    save(key, value) { calls.saved.push({ key, value: JSON.parse(JSON.stringify(value)) }); },
    syncVbucks() { calls.synced++; },
    feed(message) { calls.feeds.push(message); },
    burst() { calls.bursts++; },
    hitMarker() {}, dmgNum() {}, updScore() {},
    peerErr: e => String(e),
    editP: null,
    cancelEdit() { sandbox.editP = null; },
    respawn() { calls.respawns++; },
    setMode(mode) { sandbox.mode = mode; },
    radialKind: null, radialIndex: -1, emoteOpen: false,
    radial: { classList: { add() {} } },
    chatNext: 0,
    EMOTIONS: [{ action: 'wave' }, { action: 'dance' }, { action: 'spin' }, { action: 'flex' }],
    playEmote(action) { calls.emotes.push(action); },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: htmlPath + ':selected-release-functions' });
  const conn = new Connection();
  sandbox.Net.online = role !== 'solo';
  sandbox.Net.host = role === 'host';
  sandbox.Net.conn = conn;
  sandbox.Net.me = role === 'host' ? 'h' : 'g';
  const spawn = (kind = 'normal', id = 1, hp = 10) => {
    const z = { id, kind, hp, x: 0, y: 0, z: 0, flash: 0 };
    sandbox.Z.list.push(z);
    return z;
  };
  const receive = packet => sandbox.netHandle(packet);
  const reward = (id, kind = 'normal', extra = {}) => receive({ t: 'zreward', id, kind, ...extra });
  const selectPhrase = (index, commit = true) => {
    sandbox.radialKind = 'chat';
    sandbox.radialIndex = index;
    sandbox.emoteOpen = true;
    sandbox.closeRadial(commit);
  };
  return { s: sandbox, net: sandbox.Net, conn, calls, spawn, receive, reward, selectPhrase, advance: ms => { now += ms; } };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });

for (const [kind, amount] of [['normal', 25], ['fat', 60]]) {
  test('solo ' + kind + ': exactly one local reward and no network packet', () => {
    const f = fixture('solo');
    const z = f.spawn(kind);
    f.s.zombieHit(z, 10, false, [0, 0, 0]);
    assert.equal(f.s.settings.vbucks, amount);
    assert.equal(f.s.Z.kills, 1);
    assert.equal(f.s.Z.list.length, 0);
    assert.equal(f.conn.sent.length, 0);
    f.s.applyZombieHit(z.id, 200);
    assert.equal(f.s.settings.vbucks, amount);
    assert.equal(f.calls.saved.length, 1);
  });

  test('host ' + kind + ': both participants receive the same reward once', () => {
    const host = fixture('host'), guest = fixture('guest');
    const z = host.spawn(kind, 7);
    host.s.zombieHit(z, 10, false, [0, 0, 0]);
    assert.equal(host.s.settings.vbucks, amount);
    assert.deepEqual(host.conn.sent, [{ t: 'zreward', id: 7, kind }]);
    guest.receive(host.conn.sent[0]);
    assert.equal(guest.s.settings.vbucks, amount);
    assert.equal(guest.net.zRewarded.size, 1);
    assert.equal(guest.conn.sent.length, 0);
  });

  test('guest ' + kind + ' final hit goes through the host; neither side is paid twice', () => {
    const host = fixture('host'), guest = fixture('guest');
    host.spawn(kind, 12);
    const remoteZombie = guest.spawn(kind, 12);
    guest.s.zombieHit(remoteZombie, 10, false, [0, 0, 0]);
    assert.equal(guest.s.settings.vbucks, 0, 'guest must wait for host confirmation');
    assert.deepEqual(guest.conn.sent, [{ t: 'zhit', id: 12, dmg: 10 }]);
    host.receive(guest.conn.sent[0]);
    assert.equal(host.s.settings.vbucks, amount);
    assert.deepEqual(host.conn.sent, [{ t: 'zreward', id: 12, kind }]);
    guest.receive(host.conn.sent[0]);
    assert.equal(guest.s.settings.vbucks, amount);
    host.receive(guest.conn.sent[0]);
    guest.receive(host.conn.sent[0]);
    assert.equal(host.s.settings.vbucks, amount);
    assert.equal(guest.s.settings.vbucks, amount);
    assert.equal(host.conn.sent.length, 1);
  });
}

test('nonlethal hit neither awards currency nor sends reward', () => {
  const f = fixture('host');
  const z = f.spawn('fat', 1, 350);
  f.s.applyZombieHit(1, 100);
  assert.equal(z.hp, 250);
  assert.equal(f.s.settings.vbucks, 0);
  assert.equal(f.conn.sent.length, 0);
  assert.equal(f.s.Z.kills, 0);
});

test('duplicate id, including a changed kind, never awards twice', () => {
  const f = fixture();
  f.reward(4, 'normal');
  f.reward(4, 'normal');
  f.reward(4, 'fat');
  assert.equal(f.s.settings.vbucks, 25);
  assert.equal(f.calls.saved.length, 1);
  assert.equal(f.net.zRewarded.size, 1);
});

test('distinct zombie ids arriving out of order each award once', () => {
  const f = fixture();
  f.reward(9, 'normal');
  f.reward(2, 'fat');
  f.reward(7, 'normal');
  f.reward(2, 'normal');
  assert.equal(f.s.settings.vbucks, 110);
  assert.equal(f.net.zRewarded.size, 3);
  assert.equal(f.calls.saved.length, 3);
});

test('invalid ids are rejected without consuming reward ids', () => {
  const f = fixture();
  for (const id of [undefined, null, 0, -1, 1.5, '1', NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, {}, []]) f.reward(id);
  assert.equal(f.s.settings.vbucks, 0);
  assert.equal(f.net.zRewarded.size, 0);
  assert.equal(f.calls.saved.length, 0);
  f.reward(1);
  assert.equal(f.s.settings.vbucks, 25);
});

test('only normal/fat kinds are accepted and sender amount is ignored', () => {
  const f = fixture();
  for (const kind of [undefined, null, '', 'zombie', 'regular', 'NORMAL', {}, 25]) f.receive({ t: 'zreward', id: 1, kind });
  assert.equal(f.s.settings.vbucks, 0);
  assert.equal(f.net.zRewarded.size, 0);
  f.reward(1, 'normal', { amount: 999999 });
  assert.equal(f.s.settings.vbucks, 25);
});

for (const [name, mutate] of [
  ['host', f => { f.net.host = true; }],
  ['offline', f => { f.net.online = false; }],
  ['menu', f => { f.s.mode = 'menu'; }],
  ['freebuild', f => { f.s.currentMap = 'freebuild'; }],
  ['training', f => { f.s.currentMap = 'training'; }],
  ['closed channel', f => { f.conn.open = false; }],
  ['missing channel', f => { f.net.conn = null; }],
]) {
  test('zreward is ignored for ' + name, () => {
    const f = fixture();
    mutate(f);
    f.reward(1, 'fat');
    assert.equal(f.s.settings.vbucks, 0);
    assert.equal(f.net.zRewarded.size, 0);
    assert.equal(f.calls.saved.length, 0);
  });
}

for (const mode of ['pause', 'dead']) {
  test('guest ' + mode + ' still belongs to the active cooperative session', () => {
    const f = fixture();
    f.s.mode = mode;
    f.reward(1);
    f.reward(1);
    assert.equal(f.s.settings.vbucks, 25);
  });
}

test('reward does not require the zombie to be present in a guest snapshot', () => {
  const f = fixture();
  assert.equal(f.s.Z.list.length, 0);
  f.reward(42, 'fat');
  assert.equal(f.s.settings.vbucks, 60);
});

test('zhit is ignored outside an active host zombie session', () => {
  for (const mutate of [
    f => { f.net.host = false; },
    f => { f.net.online = false; },
    f => { f.net.conn = null; },
    f => { f.conn.open = false; },
    f => { f.s.currentMap = 'freebuild'; },
    f => { f.s.mode = 'menu'; },
  ]) {
    const f = fixture('host');
    const z = f.spawn();
    mutate(f);
    f.receive({ t: 'zhit', id: 1, dmg: 10 });
    assert.equal(z.hp, 10);
    assert.equal(f.s.settings.vbucks, 0);
    assert.equal(f.conn.sent.length, 0);
  }
});

test('old connection data is ignored after a new connection is installed', () => {
  const f = fixture();
  const old = new Connection(), current = new Connection();
  f.s.setupConn(old, false);
  old.emit('open');
  f.s.setupConn(current, false);
  current.emit('open');
  f.net.lastRx = 123;
  old.emit('data', { t: 'zreward', id: 1, kind: 'fat' });
  assert.equal(f.s.settings.vbucks, 0);
  assert.equal(f.net.lastRx, 123, 'stale data must not refresh the live connection timeout');
  current.emit('data', { t: 'zreward', id: 1, kind: 'fat' });
  assert.equal(f.s.settings.vbucks, 60);
  assert.equal(f.net.lastRx, 10000);
  current.open = false;
  current.emit('data', { t: 'zreward', id: 2, kind: 'fat' });
  assert.equal(f.s.settings.vbucks, 60);
});

test('reset clears session reward ids; next match can reward id 1 again', () => {
  const f = fixture();
  f.reward(1);
  assert.equal(f.s.settings.vbucks, 25);
  f.net.reset();
  assert.equal(f.net.online, false);
  assert.equal(f.net.conn, null);
  assert.equal(f.net.zRewarded.size, 0);
  assert.equal(f.conn.closes, 1);
  f.reward(1);
  assert.equal(f.s.settings.vbucks, 25);
  f.net.conn = new Connection();
  f.net.host = false;
  f.net.zRewarded.add(99); // startMatch must also clear remnants.
  f.s.startMatch('Друг');
  assert.equal(f.net.online, true);
  assert.equal(f.net.zRewarded.size, 0);
  assert.equal(f.s.mode, 'pause');
  f.reward(1);
  f.reward(1);
  assert.equal(f.s.settings.vbucks, 50);
});

test('addVbucks persists and updates the balance without creating intervals', () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.s.addVbucks(25, 'мишень');
  assert.equal(f.s.settings.vbucks, 2500);
  assert.equal(f.calls.saved.length, 100);
  assert.equal(f.calls.synced, 100);
  assert.equal(f.calls.feeds.length, 100);
  assert.equal(f.calls.intervals, 0);
  assert.equal(f.calls.saved.at(-1).value.vbucks, 2500);
});

test('unowned paid phrases are absent and cannot be forced through selection', () => {
  const f = fixture();
  f.s.radialKind = 'chat';
  const items = f.s.radialItems();
  assert.ok(items[0]);
  assert.equal(items[1], null);
  assert.equal(items[2], null);
  f.selectPhrase(1);
  f.selectPhrase(2);
  assert.equal(f.calls.emotes.length, 0);
  assert.equal(f.s.chatNext, 0, 'denied selection must not consume chat cooldown');
});

for (const [ownedIndex, wheelIndex, action] of [[2, 1, 'endervasi'], [3, 2, 'tenant']]) {
  test('owned phrase ' + ownedIndex + ' is visible and can be played', () => {
    const f = fixture();
    f.s.settings.owned.phrase.push(ownedIndex);
    f.s.radialKind = 'chat';
    assert.ok(f.s.radialItems()[wheelIndex]);
    f.selectPhrase(wheelIndex);
    assert.deepEqual(f.calls.emotes, [action]);
  });
}

test('phrase ownership is checked again at commit, not only when opening the wheel', () => {
  const f = fixture();
  f.s.settings.owned.phrase.push(2);
  f.s.radialKind = 'chat';
  f.s.radialIndex = 1;
  assert.ok(f.s.radialItems()[1]);
  f.s.settings.owned.phrase = [0, 1];
  f.s.closeRadial(true);
  assert.equal(f.calls.emotes.length, 0);
});

test('cancelled, paused, and rate-limited phrase selection do not play an extra voice', () => {
  const f = fixture();
  f.s.settings.owned.phrase.push(2);
  f.selectPhrase(1, false);
  assert.equal(f.calls.emotes.length, 0);
  f.s.mode = 'pause';
  f.selectPhrase(1);
  assert.equal(f.calls.emotes.length, 0);
  f.s.mode = 'play';
  f.selectPhrase(1);
  f.selectPhrase(1);
  assert.deepEqual(f.calls.emotes, ['endervasi']);
  f.advance(2501);
  f.selectPhrase(1);
  assert.deepEqual(f.calls.emotes, ['endervasi', 'endervasi']);
});

test('an authenticated reward goes through the server without changing guest money', () => {
  const f = fixture(); const claims = [];
  f.s.window.YosypAccount = { active: true, reward: (amount, reason) => claims.push([amount, reason]) };
  f.s.addVbucks(60, 'толстяк');
  assert.deepEqual(claims, [[60, 'толстяк']]);
  assert.equal(f.s.settings.vbucks, 0);
  assert.equal(f.calls.saved.length, 0);
});

let failed = 0;
for (const { name, run } of tests) {
  try { run(); process.stdout.write('PASS ' + name + '\n'); }
  catch (error) { failed++; process.stdout.write('FAIL ' + name + '\n' + error.stack + '\n'); }
}
process.stdout.write(`\n${tests.length - failed}/${tests.length} release economy tests passed\n`);
process.exitCode = failed ? 1 : 0;
