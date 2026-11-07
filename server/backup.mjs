import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync, chmodSync } from 'node:fs';
import path from 'node:path';
const data = process.env.DATA_DIR || '/var/lib/yosypnite';
const dir = path.join(data, 'backups');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, 'game-' + new Date().toISOString().replace(/[:.]/g, '-') + '.sqlite');
const db = new DatabaseSync(path.join(data, 'game.sqlite'));
db.prepare('VACUUM INTO ?').run(file); db.close(); chmodSync(file, 0o600);
for (const name of readdirSync(dir)) if (/^game-[\dTZ-]+\.sqlite$/.test(name)) {
  const target = path.join(dir, name);
  if (Date.now() - statSync(target).mtimeMs > 14 * 86400000) unlinkSync(target);
}
console.log('Database backup completed.');
