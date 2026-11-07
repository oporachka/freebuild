import { createGeometry, rayBox } from './ranked-geometry.mjs';

export const RANKED_VERSION = 41;
export const SPAWNS = [[2, 0, -14, 0], [2, 0, 18, Math.PI]];
export const WEAPONS = {
  ar: { dmg: 30, build: 14, rate: 5.5, mag: 30, reload: 2000, pellets: 1, range: 250, head: 1.5 },
  sg: { dmg: 11, build: 4, rate: 1.1, mag: 5, reload: 2600, pellets: 10, range: 45, head: 2 },
  pick: { dmg: 20, build: 80, rate: 1.7, pellets: 1, range: 4.5, head: 1 }
};
const MATERIAL_HP = [100, 200, 320];
const finite = n => Number.isFinite(n) && Math.abs(n) < 100000;
const vec = a => Array.isArray(a) && a.length === 3 && a.every(finite);
const integer = (n, a, b) => Number.isInteger(n) && n >= a && n <= b;
const clamp = (n, a, b) => Math.max(a, Math.min(b, Number(n) || 0));
const cleanNick = s => String(s || 'Игрок').replace(/[<>\p{C}]/gu, '').trim().slice(0, 16) || 'Игрок';
export const searchRange = seconds => Math.min(600, 100 + Math.floor(Math.max(0, seconds) / 15) * 50);

export class Ranked {
  constructor({ store, verify, send, now = Date.now, autoTick = true, timings = {} }) {
    Object.assign(this, { store, verify, send, now });
    this.timings = { ready: 45000, countdown: 3000, between: 4000, round: 180000, match: 1800000, ...timings };
    this.queue = new Map(); this.accounts = new Map(); this.matches = new Map(); this.stopping = false;
    store.abortUnfinishedRanked();
    if (autoTick) { this.timer = setInterval(() => this.tick(), 100); this.timer.unref(); }
  }
  handle(ws, m) {
    if (m.t === 'ranked_queue') { void this.enqueue(ws, m); return true; }
    if (m.t === 'ranked_cancel') { this.leave(ws); ws.close(1000, 'Cancelled'); return true; }
    const match = ws.rankedMatch;
    if (!match) return !!(ws.rankedQueue || ws.rankAuth);
    if (m.t === 'ranked_ready' && match.phase === 'preparing') {
      match.players[ws.rankIndex].ready = true;
      if (match.players.every(p => p.ready)) this.newRound(match);
      else this.state(match);
    } else if (m.t === 'data') this.data(ws, m);
    return true;
  }
  async enqueue(ws, m) {
    if (ws.rankAuth || ws.rankedQueue || ws.rankedMatch) return;
    if (ws.room || m.ver !== RANKED_VERSION || typeof m.token !== 'string' || m.token.length > 8192) {
      this.send(ws, { t: 'error', message: 'Для рейтинга открой 4.1 и войди в аккаунт.' }); return;
    }
    const attempt = ws.rankAuth = Symbol(); let verified = false;
    try {
      const user = await this.verify(m.token);
      if (ws.rankAuth !== attempt || ws.readyState !== 1 || this.stopping) return;
      verified = true;
      if (this.accounts.has(user.uid)) throw new Error('Этот аккаунт уже ищет соперника или участвует в дуэли.');
      if (this.queue.size >= 200) throw new Error('Очередь заполнена. Попробуй немного позже.');
      const profile = this.store.get(user.uid, user.nick);
      const entry = { ws, uid: user.uid, pts: profile.ranked.pts, profile, nick: cleanNick(profile.nick), since: this.now(), lastNotice: 0 };
      ws.rankedQueue = entry;
      this.queue.set(user.uid, entry); this.accounts.set(user.uid, entry);
      this.queueNotice(entry); this.pair(); ws.rankAuth = null;
    } catch (e) {
      if (ws.rankAuth !== attempt || ws.readyState !== 1) return;
      this.leave(ws);
      this.send(ws, { t: 'error', message: e.message?.startsWith('Этот аккаунт') || e.message?.startsWith('Очередь') ? e.message : verified ? 'Не удалось начать поиск. Попробуй ещё раз.' : 'Войди в аккаунт с подтверждённой почтой, чтобы играть на ПТС.' });
      ws.close(1008, 'Ranked login required');
    }
  }
  queueNotice(entry) {
    const seconds = Math.floor((this.now() - entry.since) / 1000);
    entry.lastNotice = this.now();
    this.send(entry.ws, { t: 'ranked_queued', pts: entry.pts, seconds, range: searchRange(seconds) });
  }
  pair() {
    const now = this.now();
    for (const a of [...this.queue.values()].sort((a, b) => a.since - b.since)) {
      if (!this.queue.has(a.uid) || a.ws.readyState !== 1) continue;
      const candidates = [...this.queue.values()].filter(b => b.uid !== a.uid && b.ws.readyState === 1 && Math.abs(a.pts - b.pts) <= Math.min(searchRange((now - a.since) / 1000), searchRange((now - b.since) / 1000)));
      candidates.sort((x, y) => Math.abs(a.pts - x.pts) - Math.abs(a.pts - y.pts) || x.since - y.since);
      const b = candidates[0]; if (!b) continue;
      const entries = [a, b], id = this.store.beginRanked(a.uid, b.uid, now);
      const match = { id, players: entries.map(e => ({ ...e, ready: false })), phase: 'preparing', score: [0, 0], round: 0, created: now, until: now + this.timings.ready, lastState: 0, geometry: createGeometry(), finished: false };
      this.matches.set(id, match);
      entries.forEach((entry, i) => {
        this.queue.delete(entry.uid); entry.ws.rankedQueue = null; entry.ws.rankedMatch = match; entry.ws.rankIndex = i;
        this.accounts.set(entry.uid, match);
        this.send(entry.ws, { t: 'ranked_matched', id, host: i === 0, opponent: { nick: entries[1 - i].nick, pts: entries[1 - i].pts }, pts: entry.pts, target: 5 });
      });
      this.state(match);
    }
  }
  newRound(match) {
    const now = this.now();
    match.round++; match.phase = 'countdown'; match.until = now + this.timings.countdown; match.roundWinner = null; match.geometry.pieces.clear();
    match.players.forEach((p, i) => Object.assign(p, {
      x: SPAWNS[i][0], y: 0, z: SPAWNS[i][2], yaw: SPAWNS[i][3], pitch: 0, cr: 0, slot: 'ar', hp: 100, sh: 100,
      ammo: { ar: 30, sg: 5 }, nextShot: 0, reload: null, heal: null, lastMove: now, moveBudget: 2, verticalBudget: 5, lastBuild: 0,
      history: [{ t: now, x: SPAWNS[i][0], y: 0, z: SPAWNS[i][2], cr: 0 }]
    }));
    this.state(match);
  }
  state(match) {
    const now = this.now(); match.lastState = now;
    match.players.forEach((p, i) => this.send(p.ws, {
      t: 'ranked_state', id: match.id, round: match.round, phase: match.phase, score: [match.score[i], match.score[1 - i]],
      ready: [p.ready, match.players[1 - i].ready], remaining: Math.max(0, match.until - now), target: 5,
      roundResult: match.roundWinner == null ? null : (match.roundWinner === i ? 'win' : 'loss'),
      health: { hp: p.hp ?? 100, sh: p.sh ?? 100 }, opponentHealth: { hp: match.players[1 - i].hp ?? 100, sh: match.players[1 - i].sh ?? 100 }
    }));
  }
  snapshot(p) {
    return { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, cr: p.cr, slot: p.slot, hp: p.hp, sh: p.sh, dead: p.hp <= 0,
      skin: p.profile.skin, pick: p.profile.pick, walk: p.walk || 0, bob: p.bob || 0, onGround: p.onGround, play: true, cast: 0, swing: 0, kick: 0, emote: null, emoteT: 0 };
  }
  data(ws, m) {
    const match = ws.rankedMatch, i = ws.rankIndex, p = match.players[i], other = match.players[1 - i], msg = m.payload;
    if (!msg || match.finished) return;
    if (msg.t === 'bye') { this.leave(ws); return; }
    if (msg.t === 'ping') { this.send(ws, { t: 'data', payload: { t: 'pong', k: msg.k } }); return; }
    if (m.round !== match.round || match.phase !== 'playing') return;
    if (msg.t === 'st') this.move(match, i, msg.s);
    else if (msg.t === 'shot') this.shoot(match, i, msg);
    else if (msg.t === 'act') this.build(match, i, msg.a);
    else if (msg.t === 'reload' && ['ar', 'sg'].includes(msg.s) && p.slot === msg.s && p.ammo[msg.s] < WEAPONS[msg.s].mag && !p.reload) {
      p.reload = { slot: msg.s, until: this.now() + WEAPONS[msg.s].reload }; p.heal = null;
    } else if (msg.t === 'heal' && ['med', 'pot'].includes(msg.s) && p.slot === msg.s && !p.heal) {
      const stat = msg.s === 'med' ? 'hp' : 'sh';
      if (p[stat] < 100) p.heal = { stat, slot: msg.s, until: this.now() + (stat === 'hp' ? 2500 : 2000) };
    }
    // Client hit/death, HP, score and result claims never change the authoritative match.
  }
  move(match, i, state) {
    if (!state || !['x', 'y', 'z', 'yaw', 'pitch'].every(k => finite(state[k]))) return;
    const p = match.players[i], now = this.now(), elapsed = Math.max(0, Math.min(1000, now - p.lastMove)) / 1000;
    p.moveBudget = Math.min(3, p.moveBudget + elapsed * 9); p.verticalBudget = Math.min(6, p.verticalBudget + elapsed * 20); p.lastMove = now;
    const distance = Math.hypot(state.x - p.x, state.z - p.z), up = Math.max(0, state.y - p.y);
    if (Math.abs(state.x) > 96 || Math.abs(state.z) > 96 || state.y < -.2 || state.y > 104 || distance > p.moveBudget + .05 || up > p.verticalBudget + .05) {
      this.send(p.ws, { t: 'ranked_correction', round: match.round, position: [p.x, p.y, p.z] }); return;
    }
    p.moveBudget = Math.max(0, p.moveBudget - distance); p.verticalBudget = Math.max(0, p.verticalBudget - up);
    p.x = state.x; p.y = state.y; p.z = state.z; p.yaw = state.yaw; p.pitch = clamp(state.pitch, -1.5, 1.5); p.cr = clamp(state.cr, 0, 1);
    if (['ar', 'sg', 'pick', 'med', 'pot', 'w', 'f', 'r', 'k'].includes(state.slot) && p.slot !== state.slot) { p.slot = state.slot; p.reload = p.heal = null; p.nextShot = Math.max(p.nextShot, now + 100); }
    p.walk = clamp(state.walk, 0, 1); p.bob = clamp(state.bob, 0, 1e6); p.onGround = !!state.onGround;
    p.history.push({ t: now, x: p.x, y: p.y, z: p.z, cr: p.cr });
    while (p.history.length > 32 || (p.history.length > 2 && p.history[1].t < now - 600)) p.history.shift();
    this.send(match.players[1 - i].ws, { t: 'data', payload: { t: 'st', s: this.snapshot(p) } });
  }
  shoot(match, i, shot) {
    const p = match.players[i], victim = match.players[1 - i], w = WEAPONS[shot.s], now = this.now();
    if (!w || p.slot !== shot.s || !vec(shot.a) || !Array.isArray(shot.b) || shot.b.length !== w.pellets || !shot.b.every(vec) || p.hp <= 0 || now + 30 < p.nextShot || p.reload || (w.mag && p.ammo[shot.s] <= 0)) return;
    const eye = [p.x, p.y + 2 - .55 * p.cr, p.z], offset = shot.a.map((n, k) => n - eye[k]), distance = Math.hypot(...offset);
    if (distance > 1.15 || (distance > .02 && match.geometry.ray(eye, offset.map(n => n / distance), distance - .02))) return;
    p.nextShot = Math.max(now, p.nextShot) + 1000 / w.rate; p.heal = null;
    if (w.mag) p.ammo[shot.s]--;
    let damage = 0, head = false; const pieceHits = new Map();
    // Rewind only the target pose, by a measured and bounded interval. Current walls still block the ray.
    const target = this.targetAt(victim, now - Math.min(250, Math.max(0, p.ws.pingMs || 0) + 60));
    const crouch = .45 * target.cr;
    const boxes = [[target.x - .40, target.y, target.z - .40, target.x + .40, target.y + 1.78 - crouch, target.z + .40], [target.x - .27, target.y + 1.78 - crouch, target.z - .27, target.x + .27, target.y + 2.37 - crouch, target.z + .27]];
    for (const end of shot.b) {
      const v = end.map((n, k) => n - shot.a[k]), length = Math.hypot(...v); if (length < .001 || length > w.range + 1) continue;
      const direction = v.map(n => n / length), limit = Math.min(w.range, length + .4), wall = match.geometry.ray(shot.a, direction, limit);
      let nearest = wall?.t ?? limit, hit = -1;
      boxes.forEach((box, k) => { const t = rayBox(shot.a, direction, box); if (t >= 0 && t < nearest) { nearest = t; hit = k; } });
      if (hit >= 0) { damage += w.dmg * (hit === 1 ? w.head : 1); head ||= hit === 1; }
      else if (wall) pieceHits.set(wall.key, (pieceHits.get(wall.key) || 0) + w.build);
    }
    for (const [key, amount] of pieceHits) this.damagePiece(match, key, amount);
    this.send(victim.ws, { t: 'data', payload: { t: 'shot', s: shot.s, a: shot.a, b: shot.b } });
    if (damage > 0) {
      const shield = Math.min(victim.sh, damage); victim.sh -= shield; victim.hp = Math.max(0, victim.hp - (damage - shield));
      this.send(p.ws, { t: 'ranked_hit', amount: Math.round(damage), head });
      if (victim.hp <= 0) this.endRound(match, i); else this.state(match);
    }
  }
  targetAt(player, when) {
    const history = player.history; if (!history?.length) return player;
    if (when <= history[0].t) return history[0];
    for (let i = 1; i < history.length; i++) if (history[i].t >= when) {
      const a = history[i - 1], b = history[i], k = (when - a.t) / Math.max(1, b.t - a.t);
      return Object.fromEntries(['x', 'y', 'z', 'cr'].map(key => [key, a[key] + (b[key] - a[key]) * k]));
    }
    return history.at(-1);
  }
  build(match, i, a) {
    if (!a || typeof a !== 'object') return;
    const player = match.players[i], geometry = match.geometry, pieces = geometry.pieces, now = this.now();
    const near = p => Math.hypot((p.i + .5) * 4 - player.x, p.l * 4 - player.y, (p.j + .5) * 4 - player.z) <= 14;
    if (a.type === 'build') {
      const p = a.p;
      if (!p || !['w', 'f', 'r', 'k'].includes(p.t) || !integer(p.i, -24, 23) || !integer(p.j, -24, 23) || !integer(p.l, 0, 24) || !integer(p.mat, 0, 2) || !near(p) || now - player.lastBuild < 45 || pieces.size >= 600) return;
      if ((p.t === 'w' && !integer(p.ax, 0, 1)) || (p.t === 'r' && !integer(p.d, 0, 3))) return;
      const clean = { t: p.t, i: p.i, j: p.j, l: p.l, mat: p.mat, ax: p.ax ?? 0, d: p.d ?? 0, hs: -1, mask: 0, own: i === 0 ? 'h' : 'g', hp: MATERIAL_HP[p.mat], maxhp: MATERIAL_HP[p.mat], bt: 1 };
      const key = geometry.keyOf(clean); if (pieces.has(key) || !geometry.canPlace(clean)) return;
      pieces.set(key, clean); geometry.refresh(clean); player.lastBuild = now;
      this.action(match, { type: 'build', p: this.piece(clean) }); return;
    }
    const p = pieces.get(a.k); if (!p || !near(p)) return;
    if (a.type === 'use' && p.pat?.type === 'door') { p.open = !p.open; p.anim = p.open ? 1 : 0; geometry.refresh(p); this.action(match, { type: 'use', k: a.k }); return; }
    if (p.own !== (i === 0 ? 'h' : 'g')) return;
    if (a.type === 'remove') { this.damagePiece(match, a.k, p.hp + 1); return; }
    if (a.type !== 'edit') return;
    if (p.t === 'r') { if (!integer(a.d, 0, 3) || !integer(a.hs ?? -1, -1, 1)) return; p.d = a.d; p.hs = a.hs ?? -1; }
    else { if (!integer(a.mask, 0, p.t === 'w' ? 511 : 15) || !geometry.validEdit(p.t, a.mask)) return; p.mask = a.mask; p.open = false; p.anim = 0; }
    geometry.refresh(p); this.action(match, { type: 'edit', k: a.k, d: p.d, hs: p.hs, mask: p.mask });
    const removed = geometry.collapse(); if (removed.length) this.world(match);
  }
  piece(p) { const { t, i, j, l, mat, ax, d, hs, mask, own, hp, maxhp, bt, open } = p; return { t, i, j, l, mat, ax, d, hs, mask, own, hp, maxhp, bt, open }; }
  action(match, a) { for (const p of match.players) this.send(p.ws, { t: 'data', payload: { t: 'act', a } }); }
  world(match) { for (const p of match.players) this.send(p.ws, { t: 'data', payload: { t: 'world', p: [...match.geometry.pieces.values()].map(p => this.piece(p)) } }); }
  damagePiece(match, key, damage) {
    const p = match.geometry.pieces.get(key); if (!p) return;
    p.hp -= damage; this.action(match, { type: 'damage', k: key, dmg: damage });
    if (p.hp <= 0) { match.geometry.pieces.delete(key); match.geometry.collapse(); this.world(match); }
  }
  endRound(match, winner) {
    if (match.phase !== 'playing' || match.finished) return;
    if (winner !== null) match.score[winner]++;
    if (winner !== null && match.score[winner] === 5) { this.complete(match, winner, 'win'); return; }
    match.phase = 'between'; match.roundWinner = winner; match.until = this.now() + this.timings.between; this.state(match);
  }
  complete(match, winner, reason) {
    if (match.finished) return;
    const result = this.store.finishRanked(match.id, winner, match.score, reason, this.now());
    match.finished = true; this.matches.delete(match.id);
    match.players.forEach((p, i) => {
      this.accounts.delete(p.uid); p.ws.rankedMatch = null;
      this.send(p.ws, { t: 'ranked_result', id: match.id, outcome: winner === null ? 'void' : winner === i ? 'win' : 'loss', score: [match.score[i], match.score[1 - i]], reason, before: result.before[i], delta: result.delta[i], rating: result.ratings[i] });
      p.ws.close(1000, 'Ranked match ended');
    });
  }
  leave(ws) {
    ws.rankAuth = null;
    const entry = ws.rankedQueue;
    if (entry) { this.queue.delete(entry.uid); this.accounts.delete(entry.uid); ws.rankedQueue = null; }
    const match = ws.rankedMatch;
    if (match && !match.finished && !this.stopping) this.complete(match, match.phase === 'preparing' ? null : 1 - ws.rankIndex, match.phase === 'preparing' ? 'cancelled' : 'forfeit');
  }
  tick() {
    if (this.stopping) return;
    const now = this.now();
    for (const entry of this.queue.values()) {
      if (entry.ws.readyState !== 1) { this.leave(entry.ws); continue; }
      if (now - entry.since > 600000) { this.send(entry.ws, { t: 'error', message: 'Пока нет соперника с близким ПТС. Попробуй поиск ещё раз.' }); this.leave(entry.ws); entry.ws.close(1000); }
      else if (now - entry.lastNotice >= 1000) this.queueNotice(entry);
    }
    this.pair();
    for (const match of this.matches.values()) {
      if (now - match.created > this.timings.match) { this.complete(match, null, 'timeout'); continue; }
      if (now >= match.until) {
        if (match.phase === 'preparing') { this.complete(match, null, 'cancelled'); continue; }
        if (match.phase === 'countdown') { match.phase = 'playing'; match.until = now + this.timings.round; this.state(match); }
        else if (match.phase === 'between') this.newRound(match);
        else if (match.phase === 'playing') { const hp = match.players.map(p => p.hp + p.sh); this.endRound(match, hp[0] === hp[1] ? null : hp[0] > hp[1] ? 0 : 1); }
      }
      if (match.phase === 'playing') for (const p of match.players) {
        if (p.reload && now >= p.reload.until) { p.ammo[p.reload.slot] = WEAPONS[p.reload.slot].mag; p.reload = null; }
        if (p.heal && now >= p.heal.until) { p[p.heal.stat] = Math.min(100, p[p.heal.stat] + 50); p.heal = null; this.state(match); }
      }
      if (!match.finished && now - match.lastState >= 1000) this.state(match);
    }
  }
  close() {
    this.stopping = true; clearInterval(this.timer);
    for (const match of [...this.matches.values()]) this.complete(match, null, 'server_restart');
    this.queue.clear(); this.accounts.clear();
  }
}
