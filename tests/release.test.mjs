import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const main = read('index.html');
const versionOf = html => /name="version" content="([0-9]+\.[0-9]+[a-z]?)"/.exec(html)?.[1];
const version = versionOf(main);
const catalog = read('versions/index.html');
const frozen = read(`versions/v${version}.html`);
const menuOf = html => /<main class="lobby-column">([\s\S]*?)<\/main>/.exec(html)?.[1];
const archiveLink = html => /id="lobbyVersions" href="([^"]+)"/.exec(html)?.[1];

test('the exact patch is visible above the game modes and agrees with release metadata', () => {
  assert.ok(version);
  for (const html of [main, frozen]) {
    const menu = menuOf(html);
    assert.equal(versionOf(html), version);
    assert.match(html, new RegExp('<title>Йосыпнайт ' + version.replace('.', '\\.') + '</title>'));
    assert.equal(/id="lobbyVersion">([^<]+)/.exec(menu)?.[1], version);
    assert.ok(menu.indexOf('id="lobbyVersion"') < menu.indexOf('class="lobby-modes"'));
    assert.ok(menu.includes('ОБНОВЛЕНИЕ v' + version + '</span>'));
    assert.ok(html.includes('ВЕРСИЯ ' + version + '</div>'));
    assert.ok(html.includes('ЙОСЫПНАЙТ · ' + version + '</span>'));
  }
  const [, major, minor, letter] = /^(\d+)\.(\d+)([a-z]?)$/.exec(version);
  const semver = `${major}.${minor}.${letter ? letter.charCodeAt(0) - 96 : 0}`;
  assert.equal(JSON.parse(read('package.json')).version, semver);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, semver); assert.equal(lock.packages[''].version, semver);
  const apiVersions = [...read('server/index.mjs').matchAll(/version: '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(apiVersions, [version, version]);
});

test('the catalog includes every frozen build and marks only the latest one current', () => {
  const cards = [...catalog.matchAll(/<article[^>]+data-version="([^"]+)"[^>]*>[\s\S]*?<\/article>/g)];
  const files = readdirSync(new URL('../versions/', import.meta.url)).filter(file => /^v\d+(?:\.\d+)+[a-z]?\.html$/.test(file));
  assert.equal(cards[0][1], version);
  assert.equal(cards.length, files.length);
  assert.equal(new Set(cards.map(card => card[1])).size, cards.length);
  assert.equal((catalog.match(/class="current-label"/g) || []).length, 1);
  assert.ok(cards[0][0].includes('class="current-label"'));
  for (const [html, v] of cards) {
    assert.ok(files.includes(`v${v}.html`), 'Missing archived build ' + v);
    assert.ok(html.includes(`href="v${v}.html"`));
    assert.ok(html.includes(`download="yosypnite-v${v}.html"`));
  }
  assert.equal(Number(/class="count">(\d+)/.exec(catalog)?.[1]), cards.length);
  for (const [, generation, count] of catalog.matchAll(/data-generation="(all|\d+)" aria-pressed="(?:true|false)">[^<]*<small>(\d+)<\/small>/g)) {
    const expected = generation === 'all' ? cards.length : cards.filter(card => card[1].startsWith(generation + '.')).length;
    assert.equal(Number(count), expected, 'Incorrect generation count: ' + generation);
  }
  assert.equal(/class="big-number">([^<]+)/.exec(catalog)?.[1], version);
});

test('the frozen build contains current physics and client assets with a usable archive link', () => {
  const physics = html => {
    const start = html.indexOf('function supportAt('), end = html.indexOf('const eye=', start);
    assert.ok(start >= 0 && end > start); return html.slice(start, end);
  };
  const movement = html => {
    const start = html.indexOf('function update(dt)'), end = html.indexOf('function drawChar(', start);
    assert.ok(start >= 0 && end > start); return html.slice(start, end);
  };
  assert.equal(physics(frozen), physics(main)); assert.equal(movement(frozen), movement(main));
  for (const file of ['account.css', 'ranked.css', 'account.js', 'online.js', 'ranked.js']) {
    assert.ok(frozen.includes(read('client/' + file)), 'Outdated inline client asset: ' + file);
  }
  assert.doesNotMatch(frozen, /(?:src|href)="client\//);
  for (const base of ['https://oporachka.github.io/freebuild/', 'https://yosypnite.177-202-71-15.sslip.io/']) {
    assert.equal(new URL(archiveLink(main), base).href, base + 'versions/?v=' + version);
  }
  for (const base of ['https://oporachka.github.io/freebuild/versions/v' + version + '.html', 'file:///downloads/game.html']) {
    assert.equal(new URL(archiveLink(frozen), base).href, 'https://oporachka.github.io/freebuild/versions/?v=' + version);
  }
  for (const html of [main, frozen, catalog]) for (const [, attrs, source] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!attrs.includes('type="module"')) new vm.Script(source);
  }
});

test('refreshing the archive requests a new URL while keeping the selected release', () => {
  const start = catalog.indexOf("document.getElementById('refreshArchive')");
  const end = catalog.indexOf('const list =', start);
  assert.ok(start >= 0 && end > start);
  let click, assigned, prevented = false, now = 100;
  vm.runInNewContext(catalog.slice(start, end), {
    document: { getElementById(id) { assert.equal(id, 'refreshArchive'); return { addEventListener(event, fn) { assert.equal(event, 'click'); click = fn; } }; } },
    location: { href: 'https://oporachka.github.io/freebuild/versions/?v=' + version + '#release-' + version.replace('.', '-'), assign(url) { assigned = url; } },
    URL, Date: { now: () => ++now }
  });
  click({ preventDefault() { prevented = true; } });
  const first = new URL(assigned);
  assert.ok(prevented);
  assert.equal(first.searchParams.get('v'), version);
  assert.equal(first.searchParams.get('refresh'), '101');
  assert.equal(first.hash, '#release-' + version.replace('.', '-'));
  click({ preventDefault() {} });
  assert.notEqual(assigned, first.href);
});
