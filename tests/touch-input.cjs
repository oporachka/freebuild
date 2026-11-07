'use strict';

// Unit tests for the real touch controller, using a deliberately small DOM/event
// model. This does not launch a browser or validate visual layout.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type, properties = {}) {
    const event = {
      type, target: this, cancelable: true, button: 0, detail: 1,
      clientX: 0, clientY: 0, prevented: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() {},
      ...properties,
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }
}

class Classes {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const add = force === undefined ? !this.values.has(value) : force;
    if (add) this.values.add(value); else this.values.delete(value);
    return add;
  }
}

class Element extends Events {
  constructor(tag = 'div', id = '') {
    super();
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.dataset = {};
    this.style = {};
    this.classList = new Classes();
    this.children = [];
    this.attributes = {};
    this.captures = new Set();
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
    this.rect = { left: 0, top: 0, width: 200, height: 200 };
  }
  append(child) { child.parentElement = this; this.children.push(child); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attribute = selector.match(/^\[data-([a-z-]+)(?:="([^"]*)")?\]$/);
    if (attribute) {
      const key = attribute[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return key in this.dataset && (attribute[2] === undefined || this.dataset[key] === attribute[2]);
    }
    return this.tagName.toLowerCase() === selector;
  }
  closest(selector) {
    for (let current = this; current; current = current.parentElement) {
      if (selector.split(',').some(s => current.matches(s.trim()))) return current;
    }
    return null;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

function fixture(options = {}) {
  const windowEvents = new Events();
  const document = new Events();
  const nodes = new Map();
  const make = (id, tag = 'div', parent) => {
    const el = new Element(tag, id);
    nodes.set(id, el);
    if (parent) parent.append(el);
    return el;
  };
  const root = make('touchControls');
  const joy = make('touchJoystick', 'div', root);
  make('touchStick', 'div', joy);
  const actions = {};
  for (const [id, action] of [
    ['touchFire', 'fire'], ['touchJump', 'jump'], ['touchEdit', 'edit'],
    ['touchAlt', 'alt'], ['touchReload', 'reload'], ['touchCrouch', 'crouch'],
    ['touchUse', 'use'],
  ]) {
    const button = make(id, 'button', root);
    button.dataset.touchAction = action;
    const label = new Element('span');
    label.classList.add('touch-label');
    button.append(label);
    actions[action] = button;
  }
  const commands = {};
  for (const [id, command] of [
    ['touchPause', 'pause'], ['touchEmotes', 'emotes'],
    ['touchChat', 'chat'], ['touchCancelEdit', 'cancelEdit'],
  ]) {
    const button = make(id, 'button', root);
    button.dataset.touchCommand = command;
    commands[command] = button;
  }
  make('touchMode', 'select');
  make('touchSens', 'input');
  const cv = make('c', 'canvas');
  const radial = make('radialWheel');
  const tabs = new Element('nav');
  tabs.classList.add('radial-tabs');
  radial.append(tabs);
  radial.append(new Element('p'));
  const footer = make('footer');
  footer.classList.add('lobby-footer');
  const bar = make('bar');
  const slots = [];
  for (const slot of ['ar', 'sg', 'pick', 'med', 'pot', 'w', 'f', 'r', 'k', 'mat']) {
    const el = make(slot === 'mat' ? 'matSlot' : 'slot-' + slot, 'div', bar);
    el.classList.add('slot');
    if (slot !== 'mat') el.dataset.s = slot;
    const title = new Element('b');
    title.textContent = slot;
    el.append(title);
    slots.push(el);
  }
  document.body = new Element('body');
  document.hidden = false;
  document.pointerLockElement = null;
  document.createElement = tag => new Element(tag);
  document.querySelectorAll = selector => selector === '#bar .slot' ? slots : [];
  document.querySelector = selector => selector === '.lobby-footer' ? footer : null;
  document.exitPointerLock = () => { document.pointerLockElement = null; };
  const calls = { press: [], release: [], confirm: 0, cancelledEdit: 0, sounds: 0, radial: [] };
  const media = new Events();
  media.matches = options.coarse ?? true;
  const sandbox = {
    $, document, cv, radial,
    matchMedia: () => media,
    navigator: { maxTouchPoints: options.maxTouchPoints ?? 5 },
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    innerWidth: 900, innerHeight: 600,
    mode: 'play', radialKind: null, radialIndex: -1, CFN: { ui: null },
    held: {}, firePressed: false, editPaint: null, pendX: 0, pendY: 0,
    me: { emoteT: 0, cr: false }, editP: null, slot: 'ar', mat: 0,
    MATS: [{ n: 'Дерево' }], EMOTE_BREAK: ['forward', 'back', 'left', 'right', 'jump'],
    settings: {
      touchMode: options.touchMode ?? 'on', touchSens: 1, sens: 1,
      editOnRelease: true, editRelease: true,
      binds: { fire: 'KeyP', jump: 'KeyJ', edit: 'KeyO', reload: 'Mouse4' },
    },
    SFX: { init() { calls.sounds++; } },
    onPress(action) {
      calls.press.push(action);
      if (action === 'fire') sandbox.firePressed = true;
      if (action === 'edit') sandbox.editP = sandbox.editP ? null : {};
      if (action === 'crouch') sandbox.me.cr = !sandbox.me.cr;
    },
    onRelease(action) {
      calls.release.push(action);
      if (action === 'fire') sandbox.editPaint = null;
      if (sandbox.editP && (action === 'fire' || action === 'edit')) calls.confirm++;
    },
    setMode(mode) {
      sandbox.mode = mode;
      for (const key in sandbox.held) sandbox.held[key] = false;
      sandbox.controller?.reset();
      sandbox.controller?.sync();
    },
    openRadial(kind) {
      sandbox.controller?.reset();
      sandbox.radialKind = kind;
      calls.radial.push({ kind });
    },
    closeRadial(commit) {
      calls.radial.push({ commit, index: sandbox.radialIndex });
      sandbox.radialKind = null;
    },
    radialItems: () => ['Wave', 'Dance'],
    cancelEdit() { calls.cancelledEdit++; sandbox.editP = null; },
    cancelEmote() { sandbox.me.emoteT = 0; },
    isBuild: slot => ['w', 'f', 'r', 'k'].includes(slot),
    setSlot(slot) { sandbox.slot = slot; },
    save() {}, refreshLabels() {}, syncSettings() {},
  };
  function $(id) {
    assert.ok(nodes.has(id), 'Fixture missing element #' + id);
    return nodes.get(id);
  }
  vm.createContext(sandbox);
  const game = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const source = game.slice(game.indexOf('function createTouchController(){'), game.indexOf('// ================= Цикл ================='));
  assert(source.startsWith('function createTouchController(){'), 'Touch controller is present in the released game');
  vm.runInContext(source + '\ncontroller = createTouchController(); controller.configure();', sandbox, { filename: 'mobile-input.js' });
  const c = sandbox.controller;
  const down = (target, id, x = 100, y = 100) =>
    (target === cv ? cv : root).emit('pointerdown', { target, pointerId: id, clientX: x, clientY: y, pointerType: 'touch' });
  const move = (id, x, y) => windowEvents.emit('pointermove', { pointerId: id, clientX: x, clientY: y });
  const up = id => windowEvents.emit('pointerup', { pointerId: id });
  const cancel = id => windowEvents.emit('pointercancel', { pointerId: id });
  return { c, sandbox, calls, root, joy, cv, actions, commands, radial, windowEvents, document, media, down, move, up, cancel, nodes };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });
const drain = f => {
  assert.equal(typeof f.c.afterUpdate, 'function', 'Controller API needs afterUpdate() for short taps');
  f.sandbox.firePressed = false; // The game consumes edge-triggered fire in update().
  f.c.afterUpdate();
};

test('three pointers: stick + look + fire stay independent', () => {
  const f = fixture();
  f.down(f.joy, 11, 100, 30);
  f.down(f.cv, 22, 500, 300);
  f.down(f.actions.fire, 33, 750, 400);
  f.move(22, 540, 315);
  assert.ok(f.c.moveY < -0.95);
  assert.equal(f.c.sprinting, true);
  assert.equal(f.c.held('fire'), true);
  assert.ok(f.sandbox.pendX > 0 && f.sandbox.pendY > 0);
  f.up(11);
  assert.equal(f.c.moveY, 0);
  assert.equal(f.c.held('fire'), true);
  const oldLook = f.sandbox.pendX;
  f.move(22, 560, 315);
  assert.ok(f.sandbox.pendX > oldLook);
  f.up(22);
  assert.equal(f.c.held('fire'), true);
  f.up(33);
  drain(f);
  assert.equal(f.c.held('fire'), false);
  assert.deepEqual(f.calls.press, ['fire']);
  assert.deepEqual(f.calls.release, ['fire']);
});

test('look pointer can start after fire was already held', () => {
  const f = fixture();
  f.down(f.joy, 11, 100, 30);
  f.down(f.actions.fire, 33, 750, 400);
  f.down(f.cv, 22, 500, 300);
  f.move(22, 540, 315);
  assert.ok(f.c.moveY < -0.95);
  assert.equal(f.c.held('fire'), true);
  assert.ok(f.sandbox.pendX > 0 && f.sandbox.pendY > 0,
    'holding fire first must not make the separate look area unresponsive');
});

test('two owners of fire release only the last owner', () => {
  const f = fixture();
  f.down(f.actions.fire, 1);
  f.down(f.actions.fire, 2);
  assert.deepEqual(f.calls.press, ['fire']);
  f.up(1);
  drain(f);
  assert.equal(f.c.held('fire'), true);
  assert.equal(f.calls.release.length, 0);
  f.up(2);
  drain(f);
  assert.equal(f.c.held('fire'), false);
  assert.deepEqual(f.calls.release, ['fire']);
});

test('cancelling fire preserves another joystick owner and never confirms edit', () => {
  const f = fixture();
  f.sandbox.editP = {};
  f.down(f.joy, 1, 155, 100);
  f.down(f.actions.fire, 2);
  f.cancel(2);
  assert.equal(f.c.held('fire'), false);
  assert.equal(f.sandbox.firePressed, false);
  assert.ok(f.c.moveX > 0.5);
  assert.equal(f.calls.confirm, 0);
  assert.equal(f.calls.release.length, 0);
});

for (const interruption of ['reset', 'blur', 'visibilitychange', 'resize']) {
  test(interruption + ' clears pointers and pending input without confirming edit', () => {
    const f = fixture();
    f.sandbox.editP = {};
    f.down(f.joy, 1, 100, 20);
    f.down(f.cv, 2, 400, 300);
    f.move(2, 450, 350);
    f.down(f.actions.fire, 3);
    f.sandbox.editPaint = 1;
    if (interruption === 'reset') f.c.reset();
    else if (interruption === 'visibilitychange') {
      f.document.hidden = true;
      f.document.emit('visibilitychange');
    } else f.windowEvents.emit(interruption);
    assert.equal(f.c.moveX, 0);
    assert.equal(f.c.moveY, 0);
    assert.equal(f.c.held('fire'), false);
    assert.equal(f.sandbox.firePressed, false);
    assert.equal(f.sandbox.pendX, 0);
    assert.equal(f.sandbox.pendY, 0);
    assert.equal(f.sandbox.editPaint, null);
    assert.equal(f.calls.confirm, 0);
    assert.equal(f.calls.release.length, 0);
    if (['blur', 'visibilitychange'].includes(interruption)) assert.equal(f.sandbox.mode, 'pause');
    f.up(1); f.up(2); f.up(3);
    assert.equal(f.calls.confirm, 0, 'late pointerup must not confirm after interruption');
  });
}

test('lost pointer capture cancels input without confirming edit', () => {
  const f = fixture();
  f.sandbox.editP = {};
  f.down(f.actions.fire, 1);
  f.document.emit('lostpointercapture', { pointerId: 1 });
  assert.equal(f.c.held('fire'), false);
  assert.equal(f.calls.confirm, 0);
  assert.equal(f.calls.release.length, 0);
});

test('fast fire tap survives until a game frame and releases once afterward', () => {
  const f = fixture();
  f.sandbox.editP = {};
  f.down(f.actions.fire, 1);
  f.up(1);
  assert.equal(f.c.held('fire') || f.sandbox.firePressed, true, 'auto weapons and edit painting need a fire signal on the next update');
  assert.equal(f.sandbox.firePressed, true, 'semi-auto weapons need the edge on the next update');
  assert.equal(f.calls.confirm, 0, 'edit release must follow processing of the final paint frame');
  drain(f);
  assert.equal(f.c.held('fire'), false);
  assert.equal(f.calls.confirm, 1);
  drain(f);
  assert.equal(f.calls.confirm, 1);
});

test('cancel after a rapid fire re-press clears the queued release', () => {
  const f = fixture();
  f.sandbox.editP = {};
  f.down(f.actions.fire, 1);
  f.up(1); // Queues release until the next update.
  f.down(f.actions.fire, 2);
  f.cancel(2); // The active edit gesture is now cancelled before the update.
  drain(f);
  assert.equal(f.sandbox.firePressed, false);
  assert.equal(f.c.held('fire'), false);
  assert.equal(f.calls.confirm, 0, 'a stale queued release must not confirm a cancelled edit');
});

test('fast jump tap survives one frame and reset clears a queued jump', () => {
  const f = fixture();
  f.down(f.actions.jump, 1);
  f.up(1);
  assert.equal(f.c.held('jump'), true);
  drain(f);
  assert.equal(f.c.held('jump'), false);
  f.down(f.actions.jump, 2);
  f.up(2);
  f.c.reset();
  assert.equal(f.c.held('jump'), false);
});

test('touch actions are semantic and independent of remapped keyboard/mouse binds', () => {
  const f = fixture();
  f.down(f.actions.reload, 1);
  f.up(1);
  f.down(f.actions.jump, 2);
  f.up(2);
  f.down(f.actions.fire, 3);
  f.up(3);
  assert.deepEqual(f.calls.press, ['reload', 'jump', 'fire']);
  assert.equal(f.sandbox.held.KeyP, undefined);
  assert.equal(f.sandbox.held.Mouse0, undefined);
  assert.equal(f.sandbox.held.KeyJ, undefined);
  assert.equal(f.c.held('jump'), true);
  assert.equal(f.c.held('fire') || f.sandbox.firePressed, true);
});

test('pause command cancels a running gesture; resume accepts fresh pointer IDs', () => {
  const f = fixture();
  f.sandbox.editP = {};
  f.down(f.actions.fire, 1);
  f.down(f.commands.pause, 2);
  assert.equal(f.sandbox.mode, 'pause');
  assert.equal(f.c.held('fire'), false);
  assert.equal(f.calls.confirm, 0);
  f.up(1);
  f.sandbox.setMode('play');
  f.down(f.joy, 3, 160, 100);
  assert.ok(f.c.moveX > 0.5);
});

test('opening chat cancels controls and tapping a sector commits that sector', () => {
  const f = fixture();
  f.down(f.joy, 1, 100, 20);
  f.down(f.actions.fire, 2);
  f.down(f.commands.chat, 3);
  assert.equal(f.sandbox.radialKind, 'chat');
  assert.equal(f.c.moveY, 0);
  assert.equal(f.c.held('fire'), false);
  f.down(f.actions.fire, 4);
  assert.equal(f.c.held('fire'), false, 'gameplay controls must stay inactive under a radial');
  const sector = new Element('path');
  sector.dataset.sector = '1';
  f.radial.append(sector);
  f.radial.emit('pointerdown', { target: sector, pointerId: 5, pointerType: 'touch' });
  assert.equal(f.sandbox.radialKind, null);
  assert.deepEqual(f.calls.radial.at(-1), { commit: true, index: 1 });
});

for (const [name, touchMode, coarse, maxTouchPoints, expected] of [
  ['auto detects a coarse pointer alone', 'auto', true, 0, true],
  ['auto detects touch points with a fine pointer', 'auto', false, 5, true],
  ['auto stays disabled on a mouse-only device', 'auto', false, 0, false],
  ['explicit off overrides both hardware signals', 'off', true, 5, false],
  ['explicit on works without touch hardware', 'on', false, 0, true],
]) {
  test(name, () => {
    const f = fixture({ touchMode, coarse, maxTouchPoints });
    assert.equal(f.c.enabled, expected);
    assert.equal(f.document.body.classList.contains('touch-ui'), expected);
    assert.equal(f.root.attributes['aria-hidden'], String(!expected));
    f.down(f.actions.fire, 1);
    assert.equal(f.c.held('fire'), expected);
    assert.equal(f.calls.press.length, expected ? 1 : 0);
  });
}

test('automatic detection reacts to coarse pointer changes and clears active input', () => {
  const f = fixture({ touchMode: 'auto', coarse: false, maxTouchPoints: 0 });
  assert.equal(f.c.enabled, false);
  f.media.matches = true;
  f.media.emit('change');
  assert.equal(f.c.enabled, true);
  f.down(f.joy, 1, 100, 20);
  f.down(f.actions.fire, 2);
  assert.equal(f.c.held('fire'), true);
  f.media.matches = false;
  f.media.emit('change');
  assert.equal(f.c.enabled, false);
  assert.equal(f.c.moveY, 0);
  assert.equal(f.c.held('fire'), false);
  assert.equal(f.sandbox.firePressed, false);
  assert.equal(f.calls.release.length, 0);
});

test('mode setting change to off clears queued taps and refuses new touches', () => {
  const f = fixture();
  f.sandbox.editP = {};
  f.down(f.actions.fire, 1);
  f.up(1);
  f.down(f.actions.jump, 2);
  f.up(2);
  f.nodes.get('touchMode').onchange({ target: { value: 'off' } });
  assert.equal(f.sandbox.settings.touchMode, 'off');
  assert.equal(f.c.enabled, false);
  assert.equal(f.c.held('jump'), false);
  assert.equal(f.sandbox.firePressed, false);
  drain(f);
  assert.equal(f.calls.confirm, 0);
  const oldPresses = f.calls.press.length;
  f.down(f.actions.fire, 3);
  f.down(f.joy, 4, 100, 20);
  assert.equal(f.calls.press.length, oldPresses);
  assert.equal(f.c.moveY, 0);
});

let failed = 0;
for (const { name, run } of tests) {
  try { run(); process.stdout.write('PASS ' + name + '\n'); }
  catch (error) {
    failed++;
    process.stdout.write('FAIL ' + name + '\n' + error.stack + '\n');
  }
}
process.stdout.write(`\n${tests.length - failed}/${tests.length} tests passed\n`);
process.exitCode = failed ? 1 : 0;
