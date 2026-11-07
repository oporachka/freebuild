import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const defaults = { skin: [0, 1], pick: [0, 1, 2, 3], emote: [0, 1], phrase: [0, 1] };
export const prices = { skin: [0, 0, 800, 1200, 600, 1200], pick: [0, 0, 0, 0, 500, 800, 400], emote: [0, 0, 400, 600], phrase: [0, 0, 300, 500] };
const bundles = { cyber_pack: { price: 1000, items: [['skin', 2], ['pick', 4], ['emote', 2]] }, gold_pack: { price: 1600, items: [['skin', 3], ['pick', 5], ['emote', 3]] } };
export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function cleanOwned(input) {
  const owned = structuredClone(defaults);
  for (const key of Object.keys(prices)) for (const id of (Array.isArray(input?.[key]) ? input[key].slice(0, 30) : [])) {
    if (Number.isInteger(id) && id >= 0 && id < prices[key].length && !owned[key].includes(id)) owned[key].push(id);
  }
  return owned;
}
export class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS players(uid TEXT PRIMARY KEY, profile TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(uid TEXT, id TEXT, result TEXT NOT NULL, PRIMARY KEY(uid,id));
      CREATE TABLE IF NOT EXISTS migrations(installation TEXT PRIMARY KEY, uid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS play_sessions(uid TEXT PRIMARY KEY, id TEXT, started INTEGER, earned INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS hourly_rewards(uid TEXT, hour INTEGER, earned INTEGER, PRIMARY KEY(uid,hour));`);
  }
  get(uid, nick = 'Игрок') {
    let row = this.db.prepare('SELECT profile FROM players WHERE uid=?').get(uid);
    if (!row) {
      const p = { nick: String(nick).slice(0, 16), vbucks: 2000, owned: structuredClone(defaults), skin: 0, pick: 0, emote: 0, phrase: 0, migrated: false, revision: 1 };
      this.db.prepare('INSERT INTO players VALUES(?,?)').run(uid, JSON.stringify(p));
      row = { profile: JSON.stringify(p) };
    }
    return JSON.parse(row.profile);
  }
  save(uid, p) { p.revision++; this.db.prepare('UPDATE players SET profile=? WHERE uid=?').run(JSON.stringify(p), uid); return p; }
  operation(uid, id, fn) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{12,80}$/.test(id)) fail('Неверный идентификатор операции.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT result FROM operations WHERE uid=? AND id=?').get(uid, id);
      if (previous) { this.db.exec('COMMIT'); return this.get(uid); }
      const result = fn(this.get(uid));
      this.db.prepare('INSERT INTO operations VALUES(?,?,?)').run(uid, id, JSON.stringify({ revision: result.revision }));
      this.db.exec('COMMIT'); return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  migrate(uid, b) {
    return this.operation(uid, b.operationId, p => {
      if (p.migrated) return p;
      if (typeof b.installation !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(b.installation)) fail('Неверное сохранение.');
      const prior = this.db.prepare('SELECT uid FROM migrations WHERE installation=?').get(b.installation);
      if (prior && prior.uid !== uid) fail('Эти покупки уже перенесены в другой аккаунт.', 409);
      const old = cleanOwned(b.owned);
      for (const k of Object.keys(prices)) p.owned[k] = [...new Set([...p.owned[k], ...old[k]])];
      p.migrated = true; // Currency is deliberately never imported from the browser.
      this.db.prepare('INSERT OR IGNORE INTO migrations VALUES(?,?)').run(b.installation, uid);
      return this.save(uid, p);
    });
  }
  purchase(uid, b) {
    return this.operation(uid, b.operationId, p => {
      let items, cost;
      if (b.bundle && Object.hasOwn(bundles, b.bundle)) {
        const bundle = bundles[b.bundle];
        items = bundle.items;
        const missing = items.filter(([k, i]) => !p.owned[k].includes(i)).length;
        cost = missing ? Math.max(200, Math.round(bundle.price * missing / items.length)) : 0;
      } else if (Object.hasOwn(prices, b.key) && Number.isInteger(b.idx) && b.idx >= 0 && b.idx < prices[b.key].length) {
        items = [[b.key, b.idx]]; cost = p.owned[b.key].includes(b.idx) ? 0 : prices[b.key][b.idx];
      } else fail('Предмет не найден.');
      if (p.vbucks < cost) fail('Недостаточно Эндер-баксов.', 409);
      p.vbucks -= cost;
      for (const [k, i] of items) { if (!p.owned[k].includes(i)) p.owned[k].push(i); p[k] = i; }
      return this.save(uid, p);
    });
  }
  equip(uid, b) {
    const p = this.get(uid);
    for (const k of Object.keys(prices)) if (Object.hasOwn(b, k)) {
      if (!Number.isInteger(b[k]) || !p.owned[k].includes(b[k])) fail('Этот предмет не куплен.');
      p[k] = b[k];
    }
    if (typeof b.nick === 'string') p.nick = b.nick.replace(/[\p{C}<>]/gu, '').trim().slice(0, 16) || 'Игрок';
    return this.save(uid, p);
  }
  beginPlay(uid, now = Date.now()) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO play_sessions VALUES(?,?,?,0) ON CONFLICT(uid) DO UPDATE SET id=excluded.id,started=excluded.started,earned=0').run(uid, id, now);
    return { id };
  }
  reward(uid, b, now = Date.now()) {
    return this.operation(uid, b.operationId, p => {
      const session = this.db.prepare('SELECT * FROM play_sessions WHERE uid=? AND id=?').get(uid, b.session);
      if (!session || now - session.started > 3_600_000) fail('Запусти новый бой для получения наград.', 409);
      const amount = b.kind === 'normal' ? 25 : b.kind === 'fat' ? 60 : 0;
      if (!amount) fail('Неизвестная награда.');
      const hour = Math.floor(now / 3_600_000);
      const hourly = this.db.prepare('SELECT earned FROM hourly_rewards WHERE uid=? AND hour=?').get(uid, hour)?.earned || 0;
      // The 4.0 world is still client-simulated. These limits bound claims; they are not an anti-cheat simulation.
      if (session.earned + amount > (now - session.started) / 1000 * 30 || hourly + amount > 10000) fail('Лимит наград. Продолжай бой и попробуй позже.', 429);
      this.db.prepare('UPDATE play_sessions SET earned=earned+? WHERE uid=?').run(amount, uid);
      this.db.prepare('INSERT INTO hourly_rewards VALUES(?,?,?) ON CONFLICT(uid,hour) DO UPDATE SET earned=earned+excluded.earned').run(uid, hour, amount);
      p.vbucks += amount; return this.save(uid, p);
    });
  }
  close() { this.db.close(); }
}
