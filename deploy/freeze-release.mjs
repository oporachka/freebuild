import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let html = readFileSync(path.join(root, 'index.html'), 'utf8');
const version = /name="version" content="([0-9]+\.[0-9]+[a-z]?)"/.exec(html)?.[1];
if (!version) throw new Error('Version metadata missing');
for (const name of ['account', 'ranked']) html = html.replace(`<link rel="stylesheet" href="client/${name}.css">`, () => '<style>' + readFileSync(path.join(root, `client/${name}.css`), 'utf8') + '</style>');
for (const name of ['online', 'ranked']) html = html.replace(`<script src="client/${name}.js"></script>`, () => '<script>' + readFileSync(path.join(root, `client/${name}.js`), 'utf8') + '</script>');
html = html.replace('<script type="module" src="client/account.js"></script>', () => '<script type="module">' + readFileSync(path.join(root, 'client/account.js'), 'utf8') + '</script>');
html = html.replace('href="privacy.html"', 'href="../privacy.html"');
// An archived or downloaded HTML must still open the public release catalog.
html = html.replace(`href="versions/?v=${version}"`, `href="https://oporachka.github.io/freebuild/versions/?v=${version}"`);
const target = path.join(root, 'versions', `v${version}.html`);
if (existsSync(target)) {
  if (readFileSync(target, 'utf8') !== html) throw new Error('Archived version already exists. Increase the release version before freezing.');
} else writeFileSync(target, html, { flag: 'wx' });
console.log(`Frozen release ${version}`);
