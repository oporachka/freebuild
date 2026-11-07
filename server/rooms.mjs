import { randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Ranked } from './ranked.mjs';

const HOST_ONLY = new Set(['world', 'zstate', 'zattack', 'zreward']);
const TYPES = new Set(['hello', 'world', 'act', 'st', 'hit', 'died', 'zhit', 'zreward', 'zstate', 'zattack', 'emote', 'shot', 'ping', 'pong', 'bye']);
const int = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const finite = (n, max = 100000) => Number.isFinite(n) && Math.abs(n) <= max;
function piece(p) {
  return p && ['w', 'f', 'r', 'k'].includes(p.t) && int(p.i, -1000, 1000) && int(p.j, -1000, 1000) && int(p.l, 0, 100) && int(p.mat, 0, 2)
    && (p.ax == null || int(p.ax, 0, 1)) && (p.d == null || int(p.d, 0, 3)) && (p.mask == null || int(p.mask, 0, 511)) && (p.hs == null || int(p.hs, -1, 3));
}
function validPayload(p) {
  if (p.t === 'world') return Array.isArray(p.p) && p.p.length <= 2500 && p.p.every(piece);
  if (p.t === 'st') return p.s && ['x', 'y', 'z', 'yaw', 'pitch', 'hp', 'sh'].every(k => finite(p.s[k]));
  if (p.t === 'act') {
    const a = p.a;
    if (!a) return false;
    if (a.type === 'build') return piece(a.p);
    if (!['edit', 'use', 'damage'].includes(a.type) || typeof a.k !== 'string' || !/^[wfrk]-?\d+,-?\d+,\d+/.test(a.k)) return false;
    if (a.type === 'damage') return Number.isFinite(a.dmg) && a.dmg >= 0 && a.dmg <= 1e9;
    if (a.type === 'edit') return (a.d == null || int(a.d, 0, 3)) && (a.mask == null || int(a.mask, 0, 511)) && (a.hs == null || int(a.hs, -1, 3));
  }
  if (p.t === 'zstate') return int(p.queue, 0, 10000) && int(p.wave, 0, 100000) && int(p.kills, 0, 1e9) && finite(p.next) && Array.isArray(p.z) && p.z.length <= 100 && p.z.every(z => z && ['normal', 'fat'].includes(z.kind) && int(z.id, 1, 1e9) && ['x', 'y', 'z', 'yaw', 'hp', 'maxhp', 'walk', 'flash'].every(k => finite(z[k])));
  if (p.t === 'shot') return Array.isArray(p.a) && p.a.length === 3 && p.a.every(v => finite(v)) && Array.isArray(p.b) && p.b.length <= 12 && p.b.every(v => Array.isArray(v) && v.length === 3 && v.every(n => finite(n)));
  return true;
}
function safe(value, depth = 0) {
  if (depth > 12) return false;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 1e12;
  if (typeof value === 'string') return value.length <= 200;
  if (value == null || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length <= 2500 && value.every(v => safe(v, depth + 1));
  return typeof value === 'object' && Object.keys(value).length <= 80 && Object.entries(value).every(([k, v]) => !['__proto__', 'constructor', 'prototype'].includes(k) && safe(v, depth + 1));
}
export function attachRooms(server, { origins, ipOf, store, verify, rankedOptions = {} }) {
  const rooms = new Map(), connections = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });
  const send = (ws, msg) => { if (ws.readyState === 1) { if (ws.bufferedAmount > 1024 * 1024) ws.close(1013, 'Slow connection'); else ws.send(JSON.stringify(msg)); } };
  const ranked = new Ranked({ store, verify, send, ...rankedOptions });
  function leave(ws) {
    const room = ws.room;
    if (!room || rooms.get(room.code) !== room) return;
    rooms.delete(room.code);
    for (const peer of [room.host, room.guest]) if (peer && peer !== ws) { peer.room = null; send(peer, { t: 'ended', message: 'Друг вышел из комнаты. Создай новую, чтобы продолжить.' }); peer.close(1000); }
    ws.room = null;
  }
  server.on('upgrade', (req, socket, head) => {
    const ip = ipOf(req);
    if (req.url !== '/ws' || !origins.has(req.headers.origin) || wss.clients.size >= 400 || (connections.get(ip) || 0) >= 6) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => { ws.ip = ip; connections.set(ip, (connections.get(ip) || 0) + 1); wss.emit('connection', ws); });
  });
  wss.on('connection', ws => {
    ws.alive = true; ws.count = 0; ws.window = Date.now(); ws.bytes = 0;
    ws.on('error', () => {});
    ws.on('pong', data => { ws.alive = true; if (data.toString() === String(ws.pingAt)) ws.pingMs = Date.now() - ws.pingAt; });
    ws.pingAt = Date.now(); ws.ping(String(ws.pingAt));
    const deadline = setTimeout(() => { if (!ws.room && !ws.rankedQueue && !ws.rankedMatch && !ws.rankAuth) ws.close(1008, 'Join timeout'); }, 10000);
    ws.on('close', () => { clearTimeout(deadline); ranked.leave(ws); leave(ws); const n = (connections.get(ws.ip) || 1) - 1; if (n) connections.set(ws.ip, n); else connections.delete(ws.ip); });
    ws.on('message', (data, binary) => {
      try {
        const now = Date.now();
        if (now - ws.window >= 1000) { ws.window = now; ws.count = 0; ws.bytes = 0; }
        ws.bytes += data.length;
        if (binary || ++ws.count > 120 || ws.bytes > 2 * 1024 * 1024) { ws.close(1008, 'Message limit'); return; }
        const m = JSON.parse(data);
        if (!m || typeof m !== 'object' || Array.isArray(m) || !safe(m.t === 'ranked_queue' ? { ...m, token: null } : m)) return ws.close(1008, 'Invalid message');
        if (m.t === 'server_ping' && finite(m.k, 1e12)) { send(ws, { t: 'server_pong', k: m.k }); return; }
        if (ranked.handle(ws, m)) return;
        if (!ws.room) {
          if (![40, 41].includes(m.ver) || !['create', 'join'].includes(m.t)) { send(ws, { t: 'error', message: 'Обнови игру до версии 4.1.' }); return; }
          ws.nick = typeof m.nick === 'string' ? m.nick.replace(/[<>\p{C}]/gu, '').slice(0, 16) : 'Игрок';
          if (m.t === 'create') {
            if (rooms.size >= 200) { send(ws, { t: 'error', message: 'Сервер заполнен. Попробуй позже.' }); return; }
            let code; do { code = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join(''); } while (rooms.has(code));
            const room = { code, host: ws, guest: null, game: m.game === 'zombies' ? 'zombies' : 'freebuild', created: now, version: m.ver };
            rooms.set(code, room); ws.room = room; send(ws, { t: 'created', code });
          } else {
            const room = rooms.get(String(m.code || '').toUpperCase());
            if (!room) return send(ws, { t: 'error', message: 'Комната не найдена. Проверь код.' });
            if (room.version !== m.ver) return send(ws, { t: 'error', message: 'У вас разные версии игры. Откройте одну сборку.' });
            if (room.guest) return send(ws, { t: 'error', message: 'В комнате уже два игрока.' });
            room.guest = ws; ws.room = room;
            send(room.host, { t: 'paired', host: true, game: room.game });
            send(ws, { t: 'paired', host: false, game: room.game });
          }
          return;
        }
        const room = ws.room, host = room.host === ws, peer = host ? room.guest : room.host;
        if (m.t !== 'data' || !TYPES.has(m.payload?.t) || !peer) return;
        const p = m.payload;
        if ((HOST_ONLY.has(p.t) && !host) || !validPayload(p)) return;
        if (p.t === 'hello') { p.nick = ws.nick; p.ver = room.version; p.game = room.game; }
        if (p.t === 'world' && (!Array.isArray(p.p) || p.p.length > 2500)) return;
        if (p.t === 'act' && (!p.a || !['build', 'edit', 'use', 'damage'].includes(p.a.type))) return;
        if (['hit', 'zhit', 'zattack'].includes(p.t)) p.dmg = Math.max(0, Math.min(p.t === 'zattack' ? 24 : 200, Number(p.dmg) || 0));
        send(peer, { t: 'data', payload: p });
      } catch { ws.close(1008, 'Invalid JSON'); }
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive || (ws.room && !ws.room.guest && Date.now() - ws.room.created > 900000)) ws.terminate(); else { ws.alive = false; ws.pingAt = Date.now(); ws.ping(String(ws.pingAt)); } }
  }, 20000);
  heartbeat.unref();
  return { rooms, ranked, close() { clearInterval(heartbeat); ranked.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); } };
}
