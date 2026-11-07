import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Real client geometry and physics; audio, camera and input devices are stubbed.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function span(first, next) {
  const a = html.indexOf(first), b = html.indexOf(next, a + first.length);
  assert.ok(a >= 0 && b > a, 'Missing source: ' + first); return html.slice(a, b);
}
const source = [
  html.split('\n').find(line => line.startsWith('const S=4,H=4,')),
  span('const boxC=', 'const animating='),
  span('function supportAt(', 'const eye='),
  span('function update(dt)', 'function drawChar(')
].join('\n');
function fixture() {
  const s = {
    me: { x: 2, y: 0, z: 0, yaw: 0, pitch: 0, vy: 0, onGround: true, cr: false, crT: 0, stam: 100, stamCd: 0, emoteT: 0 },
    held: {}, inputHeld: a => !!s.held[a], settings: { sens: 1 }, Net: { ranked: false },
    pendX: 0, pendY: 0, touchController: null, camInfo: {}, computeCam: () => ({}), CFN: { aim() {} },
    mode: 'play', slot: 'ar', mat: 0, castT: 0, reloadT: 0, cd: 0, switchT: 0, vmKick: 0, swing: 0,
    bob: 0, stepN: 0, liftT: 0, firePressed: false, editP: null, W: { ar: {} }, ammo: { ar: 30 },
    SFX: { play() {} }, isBuild: () => false, damagePlayer() {}
  };
  vm.createContext(s); vm.runInContext(source, s);
  const physics = vm.runInContext('({pieces,finalize,keyOf,ceilingAt,collideWalls,supportAt,bodyHit,update,HEAD,R})', s);
  const add = spec => { const p = { mask: 0, mat: 0, ...spec }; physics.pieces.set(physics.keyOf(p), p); physics.finalize(p); return p; };
  return { s, ...physics, add };
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-7, actual + ' != ' + expected); }

for (const ax of [0, 1]) {
  test('jump stops at the underside of an upper wall, axis ' + ax, () => {
    const f = fixture(); f.add({ t: 'w', i: 0, j: 0, l: 1, ax });
    const x = ax ? 0 : 2, z = ax ? 2 : 0;
    near(f.ceilingAt(x, z, 3.8, 4.3), 4);
    // The edge of the player's body must also hit, not only its center line.
    near(f.ceilingAt(ax ? .4 : x, ax ? z : .4, 3.8, 4.3), 4);
  });
}

test('actual jump cannot enter a wall from the ramp underneath', () => {
  const f = fixture(); f.add({ t: 'w', i: 0, j: 0, l: 1, ax: 0 }); f.add({ t: 'r', i: 0, j: 0, l: 0, d: 1 });
  Object.assign(f.s.me, { x: 1.2, y: 1.3, z: 0 });
  f.s.held.jump = true;
  for (let frame = 0; frame < 45; frame++) {
    f.update(1 / 60); f.s.held.jump = false;
    assert.ok(f.s.me.y + f.HEAD <= 4.000001, 'Head entered wall at frame ' + frame);
  }
  near(f.s.me.y, 1.3);
});

test('walking below a wall with enough headroom and jumping next to it remain allowed', () => {
  const f = fixture(); f.add({ t: 'w', i: 0, j: 0, l: 1, ax: 0 });
  const next = f.collideWalls(2, .2, 2, -.1, 0);
  near(next[1], .2); assert.equal(f.ceilingAt(2, 0, 2.3, 3.6), Infinity);
  assert.equal(f.ceilingAt(2, .6, 3.8, 4.3), Infinity);
  assert.equal(f.ceilingAt(4.6, 0, 3.8, 4.3), Infinity);
});

test('walking up a ramp cannot push the head through an overhead wall', () => {
  const f = fixture(); f.add({ t: 'w', i: 0, j: 0, l: 1, ax: 0 }); f.add({ t: 'r', i: 0, j: 0, l: 0, d: 1 });
  Object.assign(f.s.me, { x: 1.2, y: 1.3, z: .1, yaw: Math.PI / 2 }); f.s.held.forward = true;
  for (let frame = 0; frame < 30; frame++) {
    f.update(1 / 60); assert.ok(f.s.me.y + f.HEAD <= 4.000001, 'Ramp pushed head through wall');
    near(f.s.me.y, f.supportAt(f.s.me.x, f.s.me.z, f.s.me.y, .05).h);
  }
});

test('a newly built ramp cannot lift the player through a wall overhead', () => {
  const f = fixture(); f.add({ t: 'w', i: 0, j: 0, l: 1, ax: 0 }); f.add({ t: 'r', i: 0, j: 0, l: 0, d: 1 });
  Object.assign(f.s.me, { x: 1.8, y: .4, z: .1 }); f.s.liftT = .15;
  f.update(1 / 60); assert.ok(f.s.me.y + f.HEAD <= 4.000001, 'Build lift pushed head through wall');
});

test('an open door stays passable but its lintel blocks a jump', () => {
  const f = fixture(); f.add({ t: 'w', i: 0, j: 0, l: 0, ax: 0, mask: 18, open: true, anim: 1 });
  near(f.collideWalls(2, .2, 2, -.2, 0)[1], .2);
  const ceiling = f.ceilingAt(2, 0, 2.3, 2.8);
  assert.ok(ceiling > 2.3 && ceiling < 2.8, 'Door lintel must remain solid');
});

test('a diagonal wall edit preserves its opening and solid bottom edge', () => {
  const f = fixture(); f.add({ t: 'w', i: 0, j: 0, l: 1, ax: 0, mask: 11 });
  near(f.ceilingAt(.5, 0, 3.9, 4.3), 4.1);
  assert.equal(f.ceilingAt(.5, 0, 5.2, 5.5), Infinity);
  near(f.collideWalls(.5, .2, .5, -.2, 5.2)[1], .2);
});

test('floor and ramp undersides still stop upward motion', () => {
  const f = fixture(); f.add({ t: 'f', i: 0, j: 0, l: 1 });
  near(f.ceilingAt(2, 2, 3.7, 4.2), 3.85);
  f.pieces.clear(); f.add({ t: 'r', i: 0, j: 0, l: 1, d: 0 });
  near(f.ceilingAt(2, 2, 5.2, 6.2), 5.4);
});

for (const d of [0, 1, 2, 3]) {
  test('jumping beneath a ramp never lands on it, direction ' + d, () => {
    for (const height of [1.2, 1.6, 2, 2.4, 2.8, 3.2]) for (const dt of [1 / 60, 1 / 30, .05]) {
      const f = fixture(); f.add({ t: 'r', i: 0, j: 0, l: 0, d });
      const x = d === 1 ? height : d === 3 ? 4 - height : 2;
      const z = d === 0 ? height : d === 2 ? 4 - height : 2;
      Object.assign(f.s.me, { x, z });
      for (let frame = 0; frame < 45; frame++) {
        f.s.held.jump = frame === 0; f.update(dt);
        assert.ok(f.s.me.y < height - .15, 'Player rose through ramp: ' + JSON.stringify({ d, height, dt, frame, y: f.s.me.y }));
      }
    }
  });
}

test('a freshly built ramp cannot lift a player from below onto its top', () => {
  const f = fixture(); f.add({ t: 'r', i: 0, j: 0, l: 0, d: 0 });
  Object.assign(f.s.me, { x: 2, z: 1.6 }); f.s.liftT = .15;
  for (let frame = 0; frame < 15; frame++) { f.update(1 / 60); assert.ok(f.s.me.y < 1.45); }
});

test('moving and holding jump beneath a ramp cannot cross to its top', () => {
  for (const d of [0, 1, 2, 3]) for (const height of [1.2, 2, 2.8, 3.2])
    for (const turn of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) for (const dt of [1 / 60, .05]) {
      const f = fixture(); f.add({ t: 'r', i: 0, j: 0, l: 0, d });
      Object.assign(f.s.me, {
        x: d === 1 ? height : d === 3 ? 4 - height : 2,
        z: d === 0 ? height : d === 2 ? 4 - height : 2,
        yaw: d * Math.PI / 2 + turn
      });
      f.s.held.forward = f.s.held.jump = f.s.held.sprint = true;
      for (let frame = 0; frame < 45; frame++) {
        f.update(dt);
        const { x, y, z } = f.s.me;
        // Once the player leaves this ramp, a free jump outside it is valid.
        if (x <= 0 || x >= 4 || z <= 0 || z >= 4) break;
        const top = (d === 0 ? z : d === 1 ? x : d === 2 ? 4 - z : 4 - x) + .1;
        assert.ok(y < top - .05, 'Moving player crossed ramp: ' + JSON.stringify({ d, height, turn, dt, frame, x, y, z }));
      }
    }
});

test('ramp edge above the shoulder blocks jumping even with the center outside', () => {
  const f = fixture(); f.add({ t: 'r', i: 0, j: 0, l: 0, d: 0 });
  Object.assign(f.s.me, { x: -.2, z: 2.8 });
  for (let frame = 0; frame < 45; frame++) { f.s.held.jump = frame === 0; f.update(1 / 60); assert.ok(f.s.me.y <= .051); }
});

test('jumping on top, walking uphill and landing from above still work', () => {
  const f = fixture(); f.add({ t: 'r', i: 0, j: 0, l: 0, d: 0 });
  Object.assign(f.s.me, { x: 2, y: 1.6, z: 1.5 });
  f.s.held.jump = true; f.update(1 / 60); assert.ok(f.s.me.y > 1.6);
  f.s.held.jump = false;
  for (let frame = 0; frame < 75; frame++) f.update(1 / 60);
  near(f.s.me.y, 1.6);
  f.s.held.forward = true;
  for (let frame = 0; frame < 10; frame++) f.update(1 / 60);
  assert.ok(f.s.me.y > 2.4); near(f.s.me.y, f.s.me.z + .1);
});

test('the missing half of an edited ramp remains open', () => {
  const f = fixture(); f.add({ t: 'r', i: 0, j: 0, l: 0, d: 0, hs: 0 });
  Object.assign(f.s.me, { x: 3, z: 1.6 });
  let highest = 0;
  for (let frame = 0; frame < 45; frame++) { f.s.held.jump = frame === 0; f.update(1 / 60); highest = Math.max(highest, f.s.me.y); }
  assert.ok(highest > 1); near(f.s.me.y, 0);
});

for (const d of [0, 1, 2, 3]) {
  test('entering a ramp from ground or a floor reaches its upper slope, direction ' + d, () => {
    for (const floor of [false, true]) for (const start of [-.83, -.02, 0])
      for (const dt of [1 / 60, .05]) for (const sprint of [false, true]) {
        const f = fixture(); f.add({ t: 'r', i: 0, j: 0, l: 0, d });
        if (floor) {
          f.add({ t: 'f', i: 0, j: 0, l: 0 });
          const [i, j] = [[0, -1], [-1, 0], [0, 1], [1, 0]][d];
          f.add({ t: 'f', i, j, l: 0 });
        }
        Object.assign(f.s.me, {
          x: d === 1 ? start : d === 3 ? 4 - start : 2,
          z: d === 0 ? start : d === 2 ? 4 - start : 2,
          y: floor ? .1 : 0, yaw: d * Math.PI / 2
        });
        f.s.held.forward = true; f.s.held.sprint = sprint;
        let reached = false;
        for (let frame = 0; frame < Math.ceil(2 / dt); frame++) {
          f.update(dt);
          const { x, y, z } = f.s.me;
          const along = d === 0 ? z : d === 1 ? x : d === 2 ? 4 - z : 4 - x;
          if (along > 3) { near(y, along + .1); assert.ok(f.s.me.onGround); reached = true; break; }
        }
        assert.ok(reached, 'Blocked at ramp entrance: ' + JSON.stringify({ d, floor, start, dt, sprint, x: f.s.me.x, y: f.s.me.y, z: f.s.me.z }));
      }
  });
}

test('a valid ground step cannot push the player through another ramp overhead', () => {
  const f = fixture();
  f.add({ t: 'r', i: 0, j: 0, l: 0, d: 0 });
  f.add({ t: 'r', i: 0, j: 0, l: 1, d: 2 });
  Object.assign(f.s.me, { x: 2, z: -.02 }); f.s.held.forward = true;
  for (let frame = 0; frame < 90; frame++) {
    f.update(1 / 60);
    assert.ok(f.s.me.y + f.HEAD <= 8 - (f.s.me.z + f.R) - .15 + 1e-6, 'Ground step crossed the overhead ramp');
  }
  assert.ok(f.s.me.z > 2 && f.s.me.z < 3, 'Player must climb until reaching the ceiling');
  assert.ok(f.s.me.onGround);
});

test('touch movement climbs two connected half ramps and steps onto the upper floor', () => {
  const f = fixture();
  f.add({ t: 'r', i: -1, j: -1, l: 0, d: 0, hs: 0 });
  f.add({ t: 'f', i: -1, j: 0, l: 1 });
  f.add({ t: 'r', i: -1, j: 0, l: 1, d: 0, hs: 0 });
  f.add({ t: 'f', i: -1, j: 1, l: 2 });
  Object.assign(f.s.me, { x: -3, z: -4.02 });
  f.s.touchController = { enabled: true, moveX: 0, moveY: -1, sprinting: true, afterUpdate() {} };
  for (let frame = 0; frame < 90 && f.s.me.z < 4.5; frame++) f.update(1 / 60);
  assert.ok(f.s.me.z >= 4.5, 'Touch movement got stuck at a ramp/floor connection');
  near(f.s.me.y, 8.1); assert.ok(f.s.me.onGround);
});
