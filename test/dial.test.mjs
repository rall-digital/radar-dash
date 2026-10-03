// The thermostat dial's pure logic in wall-horizon-lib.js: arc geometry, snapping, the status line, colours and chips.
// Run: node --test test/dial.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIAL, FAN_CHIPS, MODE_CHIPS, arcPath, chipsFor, dialAngle, dialCentre, dialDrag, dialLive, dialPoint, dialRange, dialStatus,
  dialTap, fillPath, modeColor, pointAngle, tickPath,
} from '../dist/wall-horizon-lib.js';

const R = { min: 61, max: 88 };
const at = (angle, r = DIAL.r) => dialPoint(angle, r);
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('dialRange: the entity\'s min_temp and max_temp in whole degrees, else 61-88', () => {
  assert.deepEqual(dialRange({ min_temp: 61, max_temp: 88 }), R);
  assert.deepEqual(dialRange({ min_temp: 60.5, max_temp: 86.2 }), { min: 61, max: 86 });
  assert.deepEqual(dialRange({}), R);
  assert.deepEqual(dialRange(undefined), R);
  assert.deepEqual(dialRange({ min_temp: 80, max_temp: 70 }), R);
});

test('arc ends: 61 at -135, 88 at +135, 74.5 at the top centre, 10 degrees of arc per degree F', () => {
  assert.equal(dialAngle(61, R), -135);
  assert.equal(dialAngle(88, R), 135);
  assert.equal(dialAngle(74.5, R), 0);
  assert.equal(dialAngle(72, R) - dialAngle(71, R), 10);
  const top = at(0);
  assert.ok(near(top.x, 230) && near(top.y, 30), JSON.stringify(top));
});

test('round trip: every whole degree -> angle -> point -> degree, by tap and by drag', () => {
  for (let t = 61; t <= 88; t++) {
    const p = at(dialAngle(t, R));
    assert.ok(near(pointAngle(p.x, p.y), dialAngle(t, R)), `angle for ${t}`);
    assert.equal(dialTap(p.x, p.y, R), t, `tap on ${t}`);
    assert.equal(dialDrag(p.x, p.y, R, 74), t, `drag to ${t}`);
  }
});

test('the track is the mockup\'s arc; an empty arc is ""', () => {
  assert.equal(arcPath(-135, 135), 'M88.6 371.4 A200 200 0 1 1 371.4 371.4');
  assert.equal(arcPath(10, 10), '');
  assert.equal(arcPath(20, 10), '');
  assert.match(arcPath(-10, 10), / 0 0 1 /, 'a short arc uses the small-arc flag');
});

test('ticks: one per whole degree', () => {
  assert.equal(tickPath(R).match(/M/g).length, 28);
  assert.equal(tickPath({ min: 60, max: 90 }).match(/M/g).length, 31);
});

test('tap: just inside each end snaps to it; the gap and off the track do nothing', () => {
  assert.equal(dialTap(at(-134.6).x, at(-134.6).y, R), 61);
  assert.equal(dialTap(at(134.6).x, at(134.6).y, R), 88);
  assert.equal(dialTap(at(-136).x, at(-136).y, R), null, 'just past the 61 end');
  assert.equal(dialTap(at(136).x, at(136).y, R), null, 'just past the 88 end');
  assert.equal(dialTap(at(180).x, at(180).y, R), null, 'bottom centre');
  assert.equal(dialTap(at(0, DIAL.r - DIAL.band - 1).x, at(0, DIAL.r - DIAL.band - 1).y, R), null, 'inside the track band');
  assert.equal(dialTap(at(0, DIAL.r + DIAL.band - 1).x, at(0, DIAL.r + DIAL.band - 1).y, R), 75, 'on the band\'s outer edge');
  assert.equal(dialTap(230, 230, R), null, 'the centre');
});

test('drag: past either end clamps; in the gap it stays at the end it reached and never jumps across', () => {
  assert.equal(dialDrag(at(-150).x, at(-150).y, R, 62), 61, 'past 61 from 62');
  assert.equal(dialDrag(at(150).x, at(150).y, R, 87), 88, 'past 88 from 87');
  assert.equal(dialDrag(at(170).x, at(170).y, R, 61), 61, 'held at 61 while the finger crosses to the right half');
  assert.equal(dialDrag(at(-170).x, at(-170).y, R, 88), 88, 'held at 88 while the finger crosses to the left half');
  assert.equal(dialDrag(at(180).x, at(180).y, R, 61), 61, 'bottom centre keeps 61');
  assert.equal(dialDrag(at(90, 100).x, at(90, 100).y, R, 70), 84, 'any distance outside the centre dead zone');
});

test('fill: between the rounded current temperature and the target, either way; none when equal or unknown', () => {
  assert.equal(fillPath(75, 72, R), arcPath(dialAngle(72, R), dialAngle(75, R)));
  assert.equal(fillPath(68, 72, R), arcPath(dialAngle(68, R), dialAngle(72, R)));
  assert.equal(fillPath(74.6, 75, R), '', 'rounds the current temperature');
  assert.equal(fillPath(null, 72, R), '');
  assert.equal(fillPath('unavailable', 72, R), '');
  assert.equal(fillPath(75, null, R), '');
  assert.equal(fillPath(95, 80, R), arcPath(dialAngle(80, R), 135), 'clamped to the 88 end');
});

test('status: Cool', () => {
  assert.equal(dialStatus({ mode: 'cool', target: 72, current: 75 }), 'Cooling to 72° · now 75°');
  assert.equal(dialStatus({ mode: 'cool', target: 72, current: 72.4 }), 'Holding 72° · now 72°');
  assert.equal(dialStatus({ mode: 'cool', target: 72, current: 70 }), 'Holding 72° · now 70°');
});

test('status: Heat', () => {
  assert.equal(dialStatus({ mode: 'heat', target: 70, current: 66 }), 'Heating to 70° · now 66°');
  assert.equal(dialStatus({ mode: 'heat', target: 70, current: 70 }), 'Holding 70° · now 70°');
  assert.equal(dialStatus({ mode: 'heat', target: 70, current: 73 }), 'Holding 70° · now 73°');
});

test('status: Auto, Dry, Fan and Off', () => {
  assert.equal(dialStatus({ mode: 'heat_cool', target: 71, current: 75 }), 'Auto to 71° · now 75°');
  assert.equal(dialStatus({ mode: 'dry', target: null, current: 75 }), 'Drying · now 75°');
  assert.equal(dialStatus({ mode: 'fan_only', target: null, current: 75 }), 'Fan only · now 75°');
  assert.equal(dialStatus({ mode: 'off', target: 72, current: 73 }), 'Off · now 73°');
});

test('status: unknown current, unknown target, unavailable', () => {
  assert.equal(dialStatus({ mode: 'cool', target: 72, current: null }), 'Cool to 72°');
  assert.equal(dialStatus({ mode: 'heat', target: 72, current: undefined }), 'Heat to 72°');
  assert.equal(dialStatus({ mode: 'heat_cool', target: 72, current: null }), 'Auto to 72°');
  assert.equal(dialStatus({ mode: 'off', target: 72, current: null }), 'Off');
  assert.equal(dialStatus({ mode: 'cool', target: null, current: 75 }), 'Cool · now 75°');
  assert.equal(dialStatus({ mode: 'cool', target: 72, current: 75, available: false }), 'Unavailable');
  assert.equal(dialStatus({ mode: 'unavailable', target: null, current: null }), 'Unavailable');
});

test('colours and chips: the spec\'s tables, filtered by the entity\'s lists', () => {
  assert.deepEqual([['heat'], ['cool'], ['heat_cool'], ['dry'], ['fan_only'], ['off']].map(([m]) => modeColor(m)), ['#ff9a4a', '#5aa9ff', '#7fd6b0', '#e6c86e', '#b9c3d6', '#9aa3b2']);
  assert.equal(modeColor('cool', false), '#9aa3b2');
  assert.equal(modeColor('unavailable'), '#9aa3b2');
  assert.deepEqual(MODE_CHIPS, [['off', 'Off'], ['heat_cool', 'Auto'], ['heat', 'Heat'], ['cool', 'Cool'], ['dry', 'Dry'], ['fan_only', 'Fan']]);
  assert.deepEqual(FAN_CHIPS, [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High']]);
  assert.deepEqual(chipsFor(FAN_CHIPS, ['auto', 'low', 'medium', 'high', 'ultra high']).map(([v]) => v), ['auto', 'low', 'medium', 'high'], 'no Ultra chip');
  const today = ['off', 'heat_cool', 'heat', 'dry', 'fan_only', 'cool'];
  assert.equal(chipsFor(MODE_CHIPS, today).length, 6);
  assert.deepEqual(chipsFor(MODE_CHIPS, ['off', 'cool']).map(([, l]) => l), ['Off', 'Cool']);
  assert.deepEqual(chipsFor(FAN_CHIPS, undefined), []);
});

test('dialLive: only Heat, Cool and Auto, available, with a target', () => {
  for (const m of ['heat', 'cool', 'heat_cool']) assert.equal(dialLive(m, true, 72), true, m);
  for (const m of ['off', 'dry', 'fan_only', 'unavailable']) assert.equal(dialLive(m, true, 72), false, m);
  assert.equal(dialLive('cool', false, 72), false);
  assert.equal(dialLive('cool', true, null), false);
});

test('drag: past 61, round the bottom and up the right side, stays at 61 (review: the cross-gap jump)', () => {
  let t = 62;
  const seen = [];
  for (const a of [-140, -160, -179, 180, 170, 150, 136, 134, 125]) {
    t = dialDrag(at(a).x, at(a).y, R, t);
    seen.push(`${a}:${t}`);
  }
  assert.deepEqual(seen.map((x) => x.split(':')[1]), Array(9).fill('61'), seen.join(' '));
  assert.equal(dialDrag(at(-100).x, at(-100).y, R, 61), 65, 'back in the near half it follows again');
  let u = 87;
  for (const a of [140, 170, -170, -136, -134, -125]) u = dialDrag(at(a).x, at(a).y, R, u);
  assert.equal(u, 88, 'the mirror: past 88 and round to the left side stays at 88');
});

test('drag: across the centre the value holds instead of flipping (review: the centre dead zone)', () => {
  const across = [[100, 230], [150, 230], [200, 230], [230, 229], [260, 230], [300, 232]];
  let t = 66;
  const seen = across.map(([x, y]) => (t = dialDrag(x, y, R, t)));
  assert.deepEqual(seen, [66, 66, 66, 66, 66, 66], 'no 61 or 79 while crossing the middle');
  const r = DIAL.r * 0.4;
  assert.equal(dialDrag(230 + r - 0.5, 230, R, 70), 70, 'just inside 0.4 r: holds');
  assert.equal(dialDrag(at(90, r + 0.5).x, at(90, r + 0.5).y, R, 70), 84, 'just outside: follows the angle');
});

test('arcPath: the large-arc flag flips at 180 degrees', () => {
  assert.ok(arcPath(-55, 55).includes(' 0 0 1 '), arcPath(-55, 55));
  assert.ok(arcPath(-95, 95).includes(' 1 1 '), arcPath(-95, 95));
});

test('dialCentre: the target; with no target in Off, Dry or Fan the room temperature, dimmed', () => {
  assert.deepEqual(dialCentre('cool', 72, 75), { text: '72°', room: false });
  assert.deepEqual(dialCentre('off', 72, 73), { text: '72°', room: false }, 'a reported target still wins');
  assert.deepEqual(dialCentre('off', null, 73), { text: '73°', room: true });
  assert.deepEqual(dialCentre('dry', null, 75.4), { text: '75°', room: true });
  assert.deepEqual(dialCentre('fan_only', null, 70), { text: '70°', room: true });
  assert.deepEqual(dialCentre('off', null, null), { text: '—', room: false }, 'both unknown');
  assert.deepEqual(dialCentre('cool', null, 75), { text: '—', room: false }, 'Cool waiting for its target keeps the dash');
  assert.deepEqual(dialCentre('unavailable', undefined, undefined), { text: '—', room: false });
});
