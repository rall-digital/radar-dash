// The thermostat's send state machine in wall-horizon-lib.js: debounce, confirmation, snap-back and stale results.
// Time is the caller's: every event carries its own now (ms). Run: node --test test/climate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIMATE_DEBOUNCE_MS, CLIMATE_TIMEOUT_MS, SHEET_IDLE_MS, climateDue, climateInit, climateStep, climateToast } from '../dist/wall-horizon-lib.js';

// Runs [now, event] pairs through climateStep; returns the final state, every send (with its time) and every toast time.
function run(s, steps) {
  const sends = [];
  const toasts = [];
  for (const [now, ev] of steps) {
    const r = climateStep(s, ev, now);
    s = r.state;
    if (r.send) sends.push({ at: now, ...r.send });
    if (r.toast) toasts.push(now);
  }
  return { s, sends, toasts };
}
const setpoint = (v = 70) => climateInit(v, CLIMATE_DEBOUNCE_MS);
const input = (value) => ({ type: 'input', value });
const entity = (value) => ({ type: 'entity', value });
const tick = { type: 'tick' };

test('constants: 1 s debounce, 10 s confirmation, 30 s idle; the toast names the room', () => {
  assert.deepEqual([CLIMATE_DEBOUNCE_MS, CLIMATE_TIMEOUT_MS, SHEET_IDLE_MS], [1000, 10000, 30000]);
  assert.equal(climateToast('Living room'), "Living room didn't respond");
});

test('a drag from 70 to 74 sends once, with 74, 1 s after release, and nothing while the finger is down', () => {
  const r = run(setpoint(70), [
    [0, { type: 'down' }], [100, input(71)], [300, input(72)], [900, input(73)], [2500, input(74)],
    [3000, tick], [4000, tick], [5000, { type: 'up' }], [5999, tick], [6000, tick], [7000, tick],
  ]);
  assert.deepEqual(r.sends, [{ at: 6000, value: 74, run: 1 }]);
  assert.equal(r.s.shown, 74);
  assert.deepEqual(r.s.pending, { value: 74, run: 1, until: 16000 });
});

test('each input restarts the debounce: two quick + taps send once', () => {
  const r = run(setpoint(72), [[0, input(73)], [600, input(74)], [1500, tick], [1600, tick]]);
  assert.deepEqual(r.sends, [{ at: 1600, value: 74, run: 1 }]);
  assert.equal(climateDue(run(setpoint(72), [[0, input(73)], [600, input(74)]]).s), 1600);
});

test('the matching entity update confirms: nothing pending, the value stays', () => {
  const r = run(setpoint(72), [[0, input(74)], [1000, tick], [3000, entity(74)], [20000, tick]]);
  assert.equal(r.s.pending, null);
  assert.deepEqual([r.s.shown, r.s.confirmed], [74, 74]);
  assert.deepEqual(r.toasts, []);
});

test('no confirmation within 10 s: back to the last confirmed value, with the toast', () => {
  const r = run(setpoint(72), [[0, input(74)], [1000, tick], [10999, tick]]);
  assert.equal(r.s.shown, 74, 'still sending at 9.999 s');
  const late = run(r.s, [[11000, tick]]);
  assert.deepEqual([late.s.shown, late.s.pending, late.toasts], [72, null, [11000]]);
});

test('a rejected call snaps back at once, with the toast', () => {
  const r = run(setpoint(72), [[0, input(74)], [1000, tick], [1050, { type: 'error', run: 1 }]]);
  assert.deepEqual([r.s.shown, r.s.pending, r.toasts], [72, null, [1050]]);
});

test('stale: a late confirmation of a superseded send keeps the newer one pending', () => {
  const r = run(setpoint(72), [[0, input(74)], [1000, tick], [2000, input(76)], [3000, tick], [3500, entity(74)]]);
  assert.deepEqual(r.sends.map((x) => x.value), [74, 76]);
  assert.deepEqual(r.s.pending, { value: 76, run: 2, until: 13000 });
  assert.deepEqual([r.s.shown, r.s.confirmed], [76, 74]);
});

test('stale: a late rejection of a superseded send changes nothing', () => {
  const before = run(setpoint(72), [[0, input(74)], [1000, tick], [2000, input(76)], [3000, tick]]).s;
  const r = run(before, [[3100, { type: 'error', run: 1 }]]);
  assert.deepEqual(r.s, before);
  assert.deepEqual(r.toasts, []);
});

test('stale: the superseded send\'s timeout changes nothing', () => {
  const r = run(setpoint(72), [[0, input(74)], [1000, tick], [5000, input(76)], [6000, tick], [11000, tick]]);
  assert.deepEqual([r.s.shown, r.toasts], [76, []]);
  assert.equal(climateDue(r.s), 16000, 'only the newer send\'s timeout is due');
});

test('a newer input before its send: the older send\'s rejection is dropped quietly and its timeout never snaps the draft back', () => {
  const s = run(setpoint(72), [[0, input(74)], [1000, tick], [1500, { type: 'down' }], [1600, input(78)]]).s;
  const rejected = run(s, [[1700, { type: 'error', run: 1 }]]);
  assert.deepEqual([rejected.s.shown, rejected.s.pending, rejected.toasts], [78, null, []]);
  const held = run(s, [[11500, tick], [30000, tick]]);
  assert.deepEqual([held.s.shown, held.toasts, held.sends], [78, [], []], 'a finger held down for 30 s');
  const late = run(setpoint(72), [[0, input(74)], [1000, tick], [10500, input(78)], [11000, tick], [11500, tick]]);
  assert.deepEqual([late.toasts, late.sends.map((x) => x.value)], [[], [74, 78]], 'the timeout falls inside the debounce');
});

test('external changes apply when nothing is pending or under a finger, and wait otherwise', () => {
  assert.equal(run(setpoint(72), [[0, entity(68)]]).s.shown, 68, 'idle: applied live');
  assert.equal(run(setpoint(72), [[0, { type: 'down' }], [10, entity(68)]]).s.shown, 72, 'under a finger');
  assert.equal(run(setpoint(72), [[0, input(74)], [10, entity(68)]]).s.shown, 74, 'waiting out the debounce');
  const pending = run(setpoint(72), [[0, input(74)], [1000, tick], [2000, entity(68)]]).s;
  assert.deepEqual([pending.shown, pending.confirmed, pending.pending.value], [74, 68, 74], 'pending: shown kept, confirmed moves');
  const snapped = run(pending, [[11000, tick]]).s;
  assert.equal(snapped.shown, 68, 'the snap-back goes to the newest confirmed value');
});

test('mode and fan send at once; the selected chip again sends nothing; back to it while another is in flight sends', () => {
  const mode = climateInit('cool', 0);
  assert.deepEqual(run(mode, [[0, input('heat')]]).sends, [{ at: 0, value: 'heat', run: 1 }]);
  assert.deepEqual(run(mode, [[0, input('cool')]]).sends, [], 'already cool');
  const back = run(mode, [[0, input('heat')], [500, input('cool')]]);
  assert.deepEqual(back.sends.map((x) => x.value), ['heat', 'cool'], 'cool again supersedes the heat in flight');
  assert.equal(back.s.pending.run, 2);
});

test('the setpoint back to its confirmed value with nothing in flight sends nothing', () => {
  const r = run(setpoint(72), [[0, input(73)], [200, input(72)], [1200, tick]]);
  assert.deepEqual([r.sends, r.s.draft, r.s.pending], [[], false, null]);
  const inFlight = run(setpoint(72), [[0, input(74)], [1000, tick], [2000, input(72)], [3000, tick]]);
  assert.deepEqual(inFlight.sends.map((x) => x.value), [74, 72], '72 must still go: 74 is on its way to the unit');
});

test('flush sends a waiting setpoint at once, and nothing when nothing waits', () => {
  const r = run(setpoint(72), [[0, { type: 'down' }], [10, input(75)], [20, { type: 'flush' }]]);
  assert.deepEqual(r.sends, [{ at: 20, value: 75, run: 1 }]);
  assert.equal(r.s.down, false);
  assert.deepEqual(run(setpoint(72), [[0, { type: 'flush' }]]).sends, []);
});

test('climateDue: the debounce end, else the pending timeout; nothing while a finger is down', () => {
  assert.equal(climateDue(setpoint(72)), null);
  assert.equal(climateDue(run(setpoint(72), [[0, input(74)]]).s), 1000);
  assert.equal(climateDue(run(setpoint(72), [[0, input(74)], [1000, tick]]).s), 11000);
  assert.equal(climateDue(run(setpoint(72), [[0, input(74)], [1000, tick], [1200, { type: 'down' }]]).s), null);
});

test('a rejection while a finger rests without moving snaps back with the toast (review: no silent desync)', () => {
  const r = run(setpoint(72), [
    [0, input(74)], [1000, tick], [1500, { type: 'down' }], [1600, { type: 'error', run: 1 }], [1700, { type: 'up' }],
    [5000, tick], [20000, tick],
  ]);
  assert.deepEqual([r.s.shown, r.s.confirmed, r.s.pending, r.toasts.length], [72, 72, null, 1]);
  assert.deepEqual(r.sends.map((x) => x.value), [74], 'nothing re-sent');
});

test('flush with a send pending and no draft sends nothing and keeps the pending run', () => {
  const before = run(setpoint(72), [[0, input(74)], [1000, tick]]).s;
  const r = run(before, [[1500, { type: 'flush' }]]);
  assert.deepEqual(r.sends, []);
  assert.deepEqual(r.s.pending, { value: 74, run: 1, until: 11000 });
});
