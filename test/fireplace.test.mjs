// The fireplace sheet's pure logic in wall-horizon-lib.js, plus what can be checked of the card file
// without a browser: the tab order, the short chip labels, the pending window, the status line and
// the one warm room icon. Run: node --test test/fireplace.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PENDING_MS, fireplaceStatus, optionChips, pendingHolds, roomHot, sheetZones, shortOptionLabel, timerChips,
} from '../dist/wall-horizon-lib.js';
import { WallHorizonCard } from '../dist/wall-horizon-card.js';

const src = fs.readFileSync(new URL('../dist/wall-horizon-card.js', import.meta.url), 'utf8');
const st = (state, attributes = {}) => ({ state, attributes });

// setConfig only validates and normalises, so a bare object stands in for the element (as in test/helpers.mjs).
function configure(config) {
  const el = Object.create(WallHorizonCard.prototype);
  Object.assign(el, { dataset: {}, isConnected: false, _built: false, style: { setProperty() {} }, _subscribe() {}, _unsubscribe() {} });
  el.setConfig(config);
  return el._config;
}

test('roomHot: only a present, on entity lights the icon', () => {
  assert.equal(roomHot(st('on')), true);
  assert.equal(roomHot(st('off')), false);
  assert.equal(roomHot(st('unavailable')), false);
  assert.equal(roomHot(st('unknown')), false);
  assert.equal(roomHot(undefined), false);
  assert.equal(roomHot(null), false);
});

test('sheetZones: the rooms in order, then the fireplace; unset leaves the rooms alone', () => {
  const rooms = [
    { entity: 'climate.junior_suite', icon: 'mdi:teddy-bear', name: 'Junior Suite' },
    { entity: 'climate.royal_suite', icon: 'mdi:bed-king', name: 'Royal Suite' },
    { entity: 'climate.great_room', icon: 'mdi:fireplace', name: 'Great Room', hot_when: 'binary_sensor.fireplace_status' },
  ];
  const zones = sheetZones({ rooms, fireplace: { entity: 'climate.fireplace_thermostat' } });
  assert.deepEqual(zones.map((z) => z.kind), ['room', 'room', 'room', 'fireplace']);
  assert.deepEqual(zones.slice(0, 3).map((z) => z.name), ['Junior Suite', 'Royal Suite', 'Great Room']);
  assert.equal(zones[3].entity, 'climate.fireplace_thermostat');
  assert.equal(zones[3].name, 'Fireplace', 'a name is always shown, even unset');
  assert.deepEqual(sheetZones({ rooms }).map((z) => z.kind), ['room', 'room', 'room'], 'unset: no fourth sheet');
  assert.deepEqual(sheetZones({}), []);
  assert.deepEqual(sheetZones({ rooms: rooms, fireplace: {} }).length, 3, 'no entity, no sheet');
  assert.equal(sheetZones({ fireplact: {} }).length, 0, 'a typo does not invent a sheet');
  assert.equal(sheetZones({ rooms, fireplace: { entity: 'climate.x', name: 'Hearth' } })[3].name, 'Hearth');
});

test('shortOptionLabel: level options read as their number, the rest as the entity spells them', () => {
  assert.equal(shortOptionLabel('Level 1'), '1');
  assert.equal(shortOptionLabel('level 4'), '4');
  assert.equal(shortOptionLabel('Off'), 'Off');
  assert.equal(shortOptionLabel('Low'), 'Low');
  assert.equal(shortOptionLabel(''), '');
});

test('optionChips: built from the entity, never from a hard-coded list', () => {
  assert.deepEqual(optionChips(st('Off', { options: ['Off', 'Level 1', 'Level 2'] })), [['Off', 'Off'], ['Level 1', '1'], ['Level 2', '2']]);
  assert.deepEqual(optionChips(st('on', {})), [], 'no options listed: no chips');
  assert.deepEqual(optionChips(undefined), []);
  assert.deepEqual(optionChips(st('Off', { options: 'Off' })), [], 'a malformed list draws nothing');
});

test('timerChips: presets inside the entity range, lowest value is Off', () => {
  assert.deepEqual(timerChips(st('0', { min: 0, max: 180 })), [[0, 'Off'], [30, '30'], [60, '60'], [120, '120'], [180, '180']]);
  assert.deepEqual(timerChips(st('0', { min: 15, max: 60 })), [[15, '15'], [30, '30'], [60, '60']], 'no zero: the minimum is the first chip');
  assert.deepEqual(timerChips(undefined), [[0, 'Off'], [30, '30'], [60, '60'], [120, '120'], [180, '180']], 'no attributes: the RC400 range');
  assert.deepEqual(timerChips(st('0', { min: 0, max: 5 })), [[0, 'Off']], 'a narrow range keeps only what fits');
});

test('pendingHolds: the same value, until the window closes; strings and numbers compare by text', () => {
  const p = { value: 30, until: 5000 };
  assert.equal(PENDING_MS, 10000);
  assert.equal(pendingHolds(p, 30, 0), true);
  assert.equal(pendingHolds(p, '30', 4999), true);
  assert.equal(pendingHolds(p, 30, 5000), false, 'expired');
  assert.equal(pendingHolds(p, 60, 0), false, 'another value');
  assert.equal(pendingHolds(undefined, 30, 0), false);
});

test('fireplaceStatus: burning, timer, fan and hot from the broadcasts; offline wins', () => {
  const burning = st('on');
  assert.equal(
    fireplaceStatus({ burning, fanRunning: st('on'), timerRemaining: st('42'), receiving: st('on') }),
    'Burning · 42 min left · Fan running',
  );
  assert.equal(fireplaceStatus({ burning: st('off'), receiving: st('on') }), 'Off');
  assert.equal(fireplaceStatus({ burning, receiving: st('off') }), 'Fireplace offline');
  assert.equal(fireplaceStatus({}), 'Off', 'nothing wired: still a line');
  assert.equal(fireplaceStatus({ burning, hot: st('on') }), 'Burning · Hot');
  assert.equal(fireplaceStatus({ burning, timerRemaining: st('0') }), 'Burning', 'zero minutes is not a timer');
});

test('config: the fireplace is optional, needs an entity, and never touches a plain room card', () => {
  assert.equal(configure({ rooms: [] }).fireplace, null, 'unset: no fireplace sheet');
  assert.throws(() => configure({ fireplace: {} }), /fireplace\.entity is required/);
  assert.throws(() => configure({ fireplace: { entity: 7 } }), /fireplace\.entity is required/);
  assert.throws(() => configure({ fireplace: 'climate.x' }), /fireplace must be a mapping/);
  assert.throws(() => configure({ fireplace: { entity: 'climate.x', flame: 5 } }), /fireplace\.flame must be a string/);
  const c = configure({ fireplace: { entity: 'climate.fireplace_thermostat' } });
  assert.equal(c.fireplace.name, 'Fireplace', 'a name is always drawn on the tab');
  assert.equal(configure({ fireplace: { entity: 'climate.x', name: 'Hearth' } }).fireplace.name, 'Hearth');
});

test('config: a room may name the entity that lights its icon; rooms stay capped at three', () => {
  const c = configure({ rooms: [{ entity: 'climate.great_room', hot_when: 'binary_sensor.fireplace_status' }] });
  assert.equal(c.rooms[0].hot_when, 'binary_sensor.fireplace_status');
  assert.throws(() => configure({ rooms: [{ entity: 'climate.great_room', hot_when: 1 }] }), /rooms must be/);
  assert.deepEqual(configure({ rooms: [{ entity: 'climate.a' }] }).rooms, [{ entity: 'climate.a' }], 'a room without hot_when is unchanged');
  assert.throws(() => configure({ rooms: [{ entity: 'climate.a' }, { entity: 'climate.b' }, { entity: 'climate.c' }, { entity: 'climate.d' }] }), /up to 3/);
});

test('the card draws the warm icon, and only when data-hot is set', () => {
  assert.match(src, /\.room\[data-hot\] ha-icon \{/);
  assert.match(src, /icon\(r\.icon \|\| 'mdi:thermostat'\)/, 'the room icon is still the room\'s own');
  assert.match(src, /roomHot\(/, 'the state comes from roomHot');
});

test('the fireplace sheet is its own block, hidden until it is the open sheet', () => {
  assert.match(src, /<div class="sh-fire" id="shFire" hidden><\/div>/);
  assert.match(src, /\.sh-fire \{/);
});

test('the fireplace CSS adds no filter and no animation', () => {
  const block = /\.sh-fire \{[^}]*\}/.exec(src);
  assert.ok(block);
  assert.equal(/filter|animation|transition/.test(block[0]), false);
});

// The sheet's own render, without a DOM: one stub element for the block and one for the status line.
function fireCard(states) {
  const el = () => ({ hidden: false, textContent: '', dataset: {}, style: { setProperty() {} }, classList: { toggle() {} },
    set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; } });
  const card = Object.create(WallHorizonCard.prototype);
  Object.assign(card, {
    _el: { shFire: el(), dStatus: el() }, _clim: {}, _pend: new Map(), _hass: { states },
    _call: () => Promise.resolve(true), _render() {},
    _config: { fireplace: {
      entity: 'climate.fireplace_thermostat', name: 'Fireplace', power: 'switch.fireplace_power',
      burning: 'binary_sensor.fireplace_status', flame: 'select.fireplace_flame_control',
    } },
  });
  return card;
}

test('render: a burning fireplace shows Fire pressed, and the status line comes from the broadcasts', () => {
  const card = fireCard({
    'climate.fireplace_thermostat': st('heat', { temperature: 72 }),
    'binary_sensor.fireplace_status': st('on'),
    'switch.fireplace_power': st('on'),
    'select.fireplace_flame_control': st('Level 3', { options: ['Off', 'Level 1', 'Level 2', 'Level 3'] }),
  });
  card._feedClimate('climate.fireplace_thermostat', card._hass.states['climate.fireplace_thermostat']);
  card._renderFire(card._config.fireplace);
  const html = card._el.shFire.innerHTML;
  assert.match(html, /data-act="fire"[^>]*aria-pressed="true"/, 'Fire is drawn pressed while burning');
  assert.match(html, /data-act="flame" data-v="Level 3"[^>]*aria-pressed="true"/, 'the current flame is pressed');
  assert.equal(card._el.dStatus.textContent, 'Burning');
});

test('render: an unavailable climate leaves the thermostat chip disabled, not falsely on', () => {
  const card = fireCard({ 'climate.fireplace_thermostat': st('unavailable'), 'binary_sensor.fireplace_status': st('off') });
  card._feedClimate('climate.fireplace_thermostat', card._hass.states['climate.fireplace_thermostat']);
  card._renderFire(card._config.fireplace);
  assert.match(card._el.shFire.innerHTML, /data-act="thermo"[^>]*aria-pressed="false"/);
  assert.match(card._el.shFire.innerHTML, /data-act="thermo"[^>]*disabled/);
});
