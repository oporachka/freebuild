import test from 'node:test';
import assert from 'node:assert/strict';

test('actual account client isolates guest saves and ignores replies after account changes', async t => {
  const old = Object.fromEntries(['window','document','localStorage','fetch'].map(k => [k, globalThis[k]]));
  t.after(() => { for (const [k, v] of Object.entries(old)) if (v === undefined) delete globalThis[k]; else globalThis[k] = v; });
  const elements = new Map(), data = new Map(), applied = [];
  const guest = { vbucks: 5555, owned: { skin: [0,1,4], pick: [0], emote: [0], phrase: [0] }, nick: 'Guest' };
  globalThis.document = { getElementById(id) { if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, querySelectorAll: () => [], showModal() {}, close() {} }); return elements.get(id); }, addEventListener() {} };
  globalThis.localStorage = { getItem: k => data.get(k) || null, setItem: (k,v) => data.set(k,v) };
  localStorage.setItem('fb_settings', JSON.stringify(guest));
  globalThis.window = { YosypAPI: 'https://game.example', GameAccountBridge: {
    pause() {}, notify() {}, playing: () => false, snapshot: () => structuredClone(guest),
    apply: p => applied.push(structuredClone(p)), deviceSettings: v => ({ sens: v.sens }), equipment: () => ({ skin: 0 })
  } };
  let pendingAlice, delayAlice = false;
  const profile = uid => ({ nick: uid, vbucks: 2000, owned: { skin: [0,1] }, skin: 0, revision: 1, migrated: false });
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/config')) return { json: async () => ({ firebase: {} }) };
    const uid = options.headers.Authorization.replace('Bearer ', '');
    if (delayAlice && uid === 'alice') return new Promise(resolve => { pendingAlice = () => resolve({ ok: true, status: 200, json: async () => profile(uid) }); });
    return { ok: true, status: 200, json: async () => profile(uid) };
  };
  const { signedIn } = await import('../client/account.js');
  const user = uid => ({ uid, email: uid+'@example.test', emailVerified: true, getIdToken: async () => uid });
  await signedIn(user('alice')); const cloud = window.YosypAccount;
  assert.equal(cloud.active, true); assert.equal(cloud.profile.nick, 'alice');
  assert.equal(cloud.saveLocal('fb_settings', { vbucks: 2000, owned: { skin: [0,1] }, sens: 2 }), true);
  const saved = JSON.parse(localStorage.getItem('fb_settings'));
  assert.equal(saved.vbucks, 5555); assert.deepEqual(saved.owned, guest.owned); assert.equal(saved.sens, 2);
  await signedIn(null); assert.equal(cloud.active, false); assert.equal(applied.at(-1).vbucks, 5555);
  delayAlice = true;
  const a = signedIn(user('alice')); await new Promise(r => setImmediate(r));
  await signedIn(user('bob')); pendingAlice(); await a;
  assert.equal(cloud.uid, 'bob'); assert.equal(cloud.profile.nick, 'bob'); assert.equal(applied.at(-1).nick, 'bob');
  assert.equal(document.getElementById('accountButton').textContent, 'АККАУНТ ✓');
  await signedIn(null);
});
