// Theater and readout state of wall-horizon-lib.js: the Xbox toggle, the screen buttons, toasts, rooms, music.
// Run: node --test test/controls.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  XBOX_TIMEOUT_MS, xboxInit, xboxStep, xboxView, screenStep, screenLabel, volumeToast, roomView, musicView, playerView, progressAt, clockText, volumeView, volumeSet,
} from '../dist/wall-horizon-lib.js';

// Runs events through xboxStep and returns the final state plus every call made.
function run(start, events) {
  let s = xboxInit(start);
  const calls = [];
  for (const ev of events) {
    const r = xboxStep(s, ev);
    s = r.state;
    if (r.call) calls.push(r.call);
  }
  return { s, calls };
}

test('the timeout is 30 seconds', () => {
  assert.equal(XBOX_TIMEOUT_MS, 30000);
});

test('xboxInit maps the switch state, anything else is unavailable', () => {
  assert.deepEqual(xboxInit('off'), { phase: 'off', confirmed: 'off', note: '' });
  assert.deepEqual(xboxInit('on'), { phase: 'on', confirmed: 'on', note: '' });
  for (const v of ['unavailable', 'unknown', undefined]) assert.equal(xboxInit(v).phase, 'unavailable');
});

test('tap while off: turn_on, Starting…, then on when the switch reports on', () => {
  const a = run('off', [{ type: 'tap' }]);
  assert.deepEqual(a.calls, ['turn_on']);
  assert.equal(xboxView(a.s).sub, 'Starting…');
  const b = run('off', [{ type: 'tap' }, { type: 'entity', value: 'off' }, { type: 'entity', value: 'on' }]);
  assert.equal(b.s.phase, 'on');
  assert.equal(xboxView(b.s, 'Forza Horizon 6').sub, 'Forza Horizon 6');
});

test('tap while on: turn_off, Turning off…, then off', () => {
  const a = run('on', [{ type: 'tap' }]);
  assert.deepEqual(a.calls, ['turn_off']);
  assert.equal(xboxView(a.s).sub, 'Turning off…');
  assert.equal(run('on', [{ type: 'tap' }, { type: 'entity', value: 'off' }]).s.phase, 'off');
});

test('no second call while a change is pending', () => {
  assert.deepEqual(run('off', [{ type: 'tap' }, { type: 'tap' }, { type: 'tap' }]).calls, ['turn_on']);
});

test('30 s without the switch reporting: back to the old state with a retry note', () => {
  const a = run('off', [{ type: 'tap' }, { type: 'timeout' }]);
  assert.equal(a.s.phase, 'off');
  assert.equal(xboxView(a.s).sub, "Didn't start. Tap to try again");
  const retry = xboxStep(a.s, { type: 'tap' });
  assert.equal(retry.call, 'turn_on');
  assert.equal(xboxView(retry.state).sub, 'Starting…');
  const b = run('on', [{ type: 'tap' }, { type: 'timeout' }]);
  assert.equal(b.s.phase, 'on');
  assert.equal(xboxView(b.s, 'Halo').sub, "Didn't turn off. Tap to try again");
});

test('the note clears when the switch changes by itself', () => {
  const a = run('off', [{ type: 'tap' }, { type: 'timeout' }, { type: 'entity', value: 'off' }]);
  assert.equal(xboxView(a.s).sub, "Didn't start. Tap to try again");
  const b = run('off', [{ type: 'tap' }, { type: 'timeout' }, { type: 'entity', value: 'on' }]);
  assert.equal(xboxView(b.s).sub, 'On');
});

test('a rejected call returns to the last confirmed state', () => {
  assert.equal(run('off', [{ type: 'tap' }, { type: 'error' }]).s.phase, 'off');
  assert.equal(run('on', [{ type: 'tap' }, { type: 'error' }]).s.phase, 'on');
  assert.equal(run('on', [{ type: 'error' }]).s.phase, 'on');
});

test('unavailable disables the pill at any point, and a tap does nothing', () => {
  const a = run('off', [{ type: 'tap' }, { type: 'entity', value: 'unavailable' }]);
  assert.deepEqual(xboxView(a.s), { phase: 'unavailable', sub: 'Unavailable', disabled: true, pressed: false });
  assert.deepEqual(run('unavailable', [{ type: 'tap' }]).calls, []);
  assert.equal(run('unavailable', [{ type: 'entity', value: 'off' }]).s.phase, 'off');
});

test('while on, the subtitle is the game, or "On" when the sensor has none', () => {
  const on = xboxInit('on');
  assert.deepEqual(xboxView(on, 'Forza Horizon 6'), { phase: 'on', sub: 'Forza Horizon 6', disabled: false, pressed: true });
  for (const v of ['unknown', 'unavailable', '', undefined]) assert.equal(xboxView(on, v).sub, 'On');
  assert.equal(xboxView(xboxInit('off'), 'Forza Horizon 6').sub, 'Off');
});

test('screen buttons: one run at a time, cleared when done or on error', () => {
  let r = screenStep({ dir: null, t0: 0 }, { type: 'tap', dir: 'down' }, 1000);
  assert.deepEqual(r, { state: { dir: 'down', t0: 1000 }, call: 'down' });
  const running = r.state;
  assert.deepEqual(screenStep(running, { type: 'tap', dir: 'up' }, 2000), { state: running, call: null });
  assert.deepEqual(screenStep(running, { type: 'tap', dir: 'down' }, 2000), { state: running, call: null });
  assert.deepEqual(screenStep(running, { type: 'done' }, 46000).state, { dir: null, t0: 0 });
  assert.deepEqual(screenStep(running, { type: 'error' }, 3000).state, { dir: null, t0: 0 });
  r = screenStep({ dir: null, t0: 0 }, { type: 'tap', dir: 'up' }, 5);
  assert.equal(r.call, 'up');
});

test('screen labels', () => {
  assert.equal(screenLabel('down', false), 'Screen down');
  assert.equal(screenLabel('down', true), 'Lowering…');
  assert.equal(screenLabel('up', false), 'Screen up');
  assert.equal(screenLabel('up', true), 'Raising…');
});

test('volume toast: the level as a percentage, or the direction', () => {
  assert.equal(volumeToast('TV', 'up', 0.3), 'TV volume 30%');
  assert.equal(volumeToast('Receiver', 'down', '0.18'), 'Receiver volume 18%');
  assert.equal(volumeToast('TV', 'up', undefined), 'Volume up');
  assert.equal(volumeToast('TV', 'down', null), 'Volume down');
});

test('roomView: rounded temperature and a dot only for cool and heat', () => {
  assert.deepEqual(roomView({ state: 'cool', attributes: { current_temperature: 74.6 } }), { temp: '75°', mode: 'cool' });
  assert.deepEqual(roomView({ state: 'heat', attributes: { current_temperature: 68 } }), { temp: '68°', mode: 'heat' });
  for (const mode of ['off', 'heat_cool', 'dry', 'fan_only']) assert.equal(roomView({ state: mode, attributes: { current_temperature: 73 } }).mode, '');
  assert.deepEqual(roomView({ state: 'unavailable', attributes: {} }), { temp: '—', mode: '' });
  assert.deepEqual(roomView(undefined), { temp: '—', mode: '' });
  assert.deepEqual(roomView({ state: 'off', attributes: { current_temperature: null } }), { temp: '—', mode: '' });
});

test('musicView only while playing', () => {
  const playing = { state: 'playing', attributes: { media_title: 'Song', media_artist: 'Band', entity_picture: '/api/media_player_proxy/x?token=t' } };
  assert.deepEqual(musicView(playing), { title: 'Song', artist: 'Band', picture: '/api/media_player_proxy/x?token=t' });
  assert.equal(musicView({ ...playing, state: 'paused' }), null);
  assert.equal(musicView(undefined), null);
});

test('a report of the old state does not end Starting…', () => {
  const a = run('off', [{ type: 'tap' }, { type: 'entity', value: 'off' }]);
  assert.equal(a.s.phase, 'starting');
  assert.equal(xboxView(a.s).sub, 'Starting…');
});

test('a report of the old state does not end Turning off…', () => {
  const a = run('on', [{ type: 'tap' }, { type: 'entity', value: 'on' }]);
  assert.equal(a.s.phase, 'stopping');
  assert.equal(xboxView(a.s).sub, 'Turning off…');
});

test('playerView covers playing and paused, nothing else', () => {
  const a = { media_title: 'Song', media_artist: 'Band', media_album_name: 'LP', entity_picture: '/p', media_duration: 200, media_position: 50, media_position_updated_at: '2026-01-01T00:00:00Z' };
  const v = playerView({ state: 'playing', attributes: a });
  assert.deepEqual({ ...v, updatedAt: undefined }, { playing: true, title: 'Song', artist: 'Band', album: 'LP', picture: '/p', duration: 200, position: 50, updatedAt: undefined });
  assert.equal(playerView({ state: 'paused', attributes: a }).playing, false);
  for (const state of ['idle', 'off', 'unavailable', 'standby']) assert.equal(playerView({ state, attributes: a }), null);
  assert.equal(playerView(undefined), null);
});

test('progressAt advances while playing, holds while paused, and clamps', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const base = { playing: true, duration: 200, position: 50, updatedAt: t0 };
  assert.equal(progressAt(base, t0 + 10000).pos, 60);
  assert.equal(progressAt({ ...base, playing: false }, t0 + 10000).pos, 50);
  assert.equal(progressAt(base, t0 + 999000).pos, 200);
  assert.equal(progressAt(base, t0 - 5000).pos, 50);
  assert.equal(progressAt({ ...base, duration: null }, t0), null);
  assert.equal(progressAt({ ...base, position: null }, t0), null);
  assert.equal(progressAt(null, t0), null);
});

test('clockText', () => {
  assert.equal(clockText(0), '0:00');
  assert.equal(clockText(65.9), '1:05');
  assert.equal(clockText(3725), '1:02:05');
  assert.equal(clockText(null), '0:00');
});

test('volumeView and volumeSet', () => {
  assert.deepEqual(volumeView({ state: 'on', attributes: { volume_level: 0.4, is_volume_muted: true } }), { available: true, off: false, level: 0.4, muted: true });
  assert.deepEqual(volumeView({ state: 'off', attributes: { volume_level: 0.4 } }), { available: false, off: true, level: null, muted: false });
  assert.equal(volumeView({ state: 'unavailable', attributes: {} }).available, false);
  assert.equal(volumeView(undefined).available, false);
  assert.equal(volumeSet(0.4349), 0.43);
  assert.equal(volumeSet(-1), 0);
  assert.equal(volumeSet(2), 1);
  assert.equal(volumeSet(0.9, 0.6), 0.6);
  assert.equal(volumeSet('x'), 0);
});
