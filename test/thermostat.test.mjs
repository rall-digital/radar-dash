// wall-thermostat-card: the pure logic it adds to wall-horizon-lib.js, and what can be checked of the card file
// without a browser. The browser behaviour (drag, taps, no call without a gesture) is checked in a browser, outside these tests.
// Run: node --test test/thermostat.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  dialAngle, dialCentre, dialStatus, dialTap, dialPoint, fromUnits, thermostatCall, thermostatRange, thermostatStep, thermostatView, toUnits,
} from '../dist/wall-horizon-lib.js';

const F = '°F';
const C = '°C';
const entity = (state, attributes = {}) => ({ state, attributes: { min_temp: 45, max_temp: 95, hvac_modes: ['off', 'heat', 'cool', 'heat_cool'], ...attributes } });

test('dialStatus and dialCentre: the new digits argument defaults to whole degrees, exactly as before', () => {
  assert.equal(dialStatus({ mode: 'cool', target: 72, current: 72.4 }), 'Holding 72° · now 72°');
  assert.equal(dialStatus({ mode: 'cool', target: 72, current: 72.4, digits: 0 }), 'Holding 72° · now 72°');
  assert.deepEqual(dialCentre('cool', 72.4, 70), { text: '72°', room: false });
  assert.equal(dialStatus({ mode: 'heat', target: 21.5, current: 20.2, digits: 1 }), 'Heating to 21.5° · now 20.2°');
  assert.equal(dialStatus({ mode: 'heat', target: 21.5, current: 21.5, digits: 1 }), 'Holding 21.5° · now 21.5°');
  assert.equal(dialStatus({ mode: 'cool', target: 21.5, current: 21.6, digits: 1 }), 'Cooling to 21.5° · now 21.6°');
  assert.deepEqual(dialCentre('heat', 21.5, 20, 1), { text: '21.5°', room: false });
  assert.deepEqual(dialCentre('off', null, 20.24, 1), { text: '20.2°', room: true });
});

test('step and range come from the entity; the fallbacks follow the unit', () => {
  assert.deepEqual(thermostatStep({ target_temp_step: 0.5 }, F), { step: 0.5, digits: 1 });
  assert.deepEqual(thermostatStep({ target_temp_step: 1 }, C), { step: 1, digits: 0 });
  assert.deepEqual(thermostatStep({ target_temp_step: 0.1 }, C), { step: 0.1, digits: 1 });
  assert.deepEqual(thermostatStep({}, F), { step: 1, digits: 0 }, 'no step, °F: whole degrees');
  assert.deepEqual(thermostatStep({}, C), { step: 0.5, digits: 1 }, 'no step, °C: half degrees');
  assert.deepEqual(thermostatStep({ target_temp_step: 0 }, F), { step: 1, digits: 0 });
  // The range is in steps, so the shared dial (which works in whole units) lands on every step.
  assert.deepEqual(thermostatRange({ min_temp: 61, max_temp: 88 }, F, 1), { min: 61, max: 88 });
  assert.deepEqual(thermostatRange({ min_temp: 7, max_temp: 35 }, C, 0.5), { min: 14, max: 70 });
  assert.deepEqual(thermostatRange({ min_temp: 16.5, max_temp: 30 }, C, 0.5), { min: 33, max: 60 });
  assert.deepEqual(thermostatRange({}, F, 1), { min: 45, max: 95 }, 'no limits, °F');
  assert.deepEqual(thermostatRange({}, C, 0.5), { min: 14, max: 70 }, 'no limits, °C: 7 to 35');
  assert.deepEqual(thermostatRange({ min_temp: 30, max_temp: 20 }, C, 0.5), { min: 14, max: 70 }, 'inverted limits fall back');
  assert.equal(toUnits(21.5, 0.5), 43);
  assert.equal(fromUnits(43, 0.5, 1), 21.5);
  assert.equal(fromUnits(213, 0.1, 1), 21.3, 'no float dust');
  assert.equal(fromUnits(72, 1, 0), 72);
});

test('a °C entity with a 0.5 step: a tap on the track lands on a half degree', () => {
  const v = thermostatView(entity('heat', { min_temp: 7, max_temp: 35, target_temp_step: 0.5, temperature: 21.5, current_temperature: 20.2 }), C);
  assert.deepEqual([v.step, v.digits, v.range.min, v.range.max], [0.5, 1, 14, 70]);
  assert.equal(v.live, true);
  assert.equal(v.status, 'Heating to 21.5° · now 20.2°');
  assert.deepEqual(v.centre, { text: '21.5°', room: false });
  const p = dialPoint(dialAngle(toUnits(22.5, v.step), v.range));
  assert.equal(fromUnits(dialTap(p.x, p.y, v.range), v.step, v.digits), 22.5);
});

test('single setpoint in °F: live in heat, cool and both autos; whole degrees', () => {
  const v = thermostatView(entity('cool', { temperature: 72, current_temperature: 75, fan_mode: 'auto', fan_modes: ['auto', 'low', 'high'] }), F);
  assert.equal(v.available, true);
  assert.equal(v.live, true);
  assert.equal(v.dual, false);
  assert.equal(v.status, 'Cooling to 72° · now 75°');
  assert.deepEqual(v.centre, { text: '72°', room: false });
  assert.deepEqual(v.range, { min: 45, max: 95 });
  assert.deepEqual(v.modes, [['off', 'Off'], ['heat', 'Heat'], ['cool', 'Cool'], ['heat_cool', 'Auto']], 'the entity\'s own order');
  assert.deepEqual(v.fans, [['auto', 'Auto'], ['low', 'Low'], ['high', 'High']]);
  assert.equal(v.color, '#5aa9ff');
  // hvac mode "auto" (a schedule or the device's own choice) with one target behaves like heat_cool.
  const auto = thermostatView(entity('auto', { hvac_modes: ['off', 'auto', 'heat'], temperature: 70, current_temperature: 68 }), F);
  assert.equal(auto.live, true);
  assert.equal(auto.status, 'Auto to 70° · now 68°');
  assert.deepEqual(auto.modes, [['off', 'Off'], ['auto', 'Auto'], ['heat', 'Heat']]);
  const both = thermostatView(entity('heat', { hvac_modes: ['off', 'auto', 'heat_cool', 'heat'], temperature: 70 }), F);
  assert.deepEqual(both.modes, [['off', 'Off'], ['auto', 'Auto'], ['heat_cool', 'Heat/Cool'], ['heat', 'Heat']], 'two autos are told apart');
});

test('heat_cool with low and high targets: shown, read-only (the dial has one handle)', () => {
  const v = thermostatView(entity('heat_cool', { temperature: null, target_temp_low: 68, target_temp_high: 75, current_temperature: 71 }), F);
  assert.equal(v.dual, true);
  assert.equal(v.live, false, 'the dial takes no input');
  assert.equal(v.status, 'Auto 68° to 75° · now 71°');
  assert.deepEqual(v.centre, { text: '71°', room: true }, 'the room temperature, dimmed');
  assert.deepEqual([v.low, v.high, v.target], [68, 75, null]);
  const noCurrent = thermostatView(entity('heat_cool', { target_temp_low: 68, target_temp_high: 75 }), F);
  assert.equal(noCurrent.status, 'Auto 68° to 75°');
  assert.deepEqual(noCurrent.centre, { text: '—', room: false });
});

test('off, dry and fan_only: no input, the room temperature dimmed', () => {
  for (const [mode, status] of [['off', 'Off · now 70°'], ['dry', 'Drying · now 70°'], ['fan_only', 'Fan only · now 70°']]) {
    const v = thermostatView(entity(mode, { current_temperature: 70, hvac_modes: ['off', 'cool', 'dry', 'fan_only'] }), F);
    assert.equal(v.live, false, mode);
    assert.equal(v.status, status);
    assert.deepEqual(v.centre, { text: '70°', room: true });
    assert.deepEqual(v.modes.map(([m]) => m), ['off', 'cool', 'dry', 'fan_only']);
  }
  // Off with the last target still reported: shown, but not adjustable.
  const kept = thermostatView(entity('off', { temperature: 72, current_temperature: 70 }), F);
  assert.equal(kept.live, false);
  assert.deepEqual(kept.centre, { text: '72°', room: false });
});

test('unavailable, unknown or missing entity: nothing to tap', () => {
  for (const so of [undefined, entity('unavailable', { temperature: 72, fan_modes: ['auto'] }), entity('unknown')]) {
    const v = thermostatView(so, F);
    assert.equal(v.available, false);
    assert.equal(v.live, false);
    assert.equal(v.status, 'Unavailable');
    assert.deepEqual(v.modes, []);
    assert.deepEqual(v.fans, []);
    assert.deepEqual(v.centre, { text: '—', room: false });
    assert.equal(v.color, '#9aa3b2');
  }
});

test('fan modes are the entity\'s own list; none means no fan row', () => {
  assert.deepEqual(thermostatView(entity('heat', { temperature: 70 }), F).fans, []);
  const v = thermostatView(entity('cool', { temperature: 70, fan_modes: ['on', 'auto', 'ultra high', 'quiet_mode'] }), F);
  assert.deepEqual(v.fans, [['on', 'On'], ['auto', 'Auto'], ['ultra high', 'Ultra'], ['quiet_mode', 'Quiet mode']]);
});

test('service calls: only three climate services, only the configured entity', () => {
  assert.deepEqual(thermostatCall('climate.den', 'temp', 71), ['climate', 'set_temperature', { temperature: 71 }, { entity_id: 'climate.den' }]);
  assert.deepEqual(thermostatCall('climate.den', 'mode', 'cool'), ['climate', 'set_hvac_mode', { hvac_mode: 'cool' }, { entity_id: 'climate.den' }]);
  assert.deepEqual(thermostatCall('climate.den', 'fan', 'low'), ['climate', 'set_fan_mode', { fan_mode: 'low' }, { entity_id: 'climate.den' }]);
  assert.throws(() => thermostatCall('climate.den', 'preset', 'eco'), /unknown field/);
  assert.throws(() => thermostatCall('light.lamp', 'mode', 'off'), /climate entity/);
  assert.throws(() => thermostatCall('', 'mode', 'off'), /climate entity/);
});

test('the card file: imports without a DOM, validates its config, and has exactly one callService site', async () => {
  const { WallThermostatCard } = await import('../dist/wall-thermostat-card.js');
  const make = () => Object.assign(Object.create(WallThermostatCard.prototype), { isConnected: false });
  assert.throws(() => make().setConfig({}), /entity/);
  assert.throws(() => make().setConfig({ entity: 'sensor.temp' }), /climate/);
  assert.throws(() => make().setConfig({ entity: ['climate.a', 'climate.b'] }), /entity/);
  const card = make();
  card.setConfig({ entity: 'climate.den', name: 'Den' });
  assert.equal(card._config.entity, 'climate.den');
  assert.ok(card.getCardSize() >= 4);
  const stub = WallThermostatCard.getStubConfig({ states: { 'light.a': {}, 'climate.first': {}, 'climate.second': {} } });
  assert.deepEqual(stub, { entity: 'climate.first' });
  assert.match(WallThermostatCard.getStubConfig({ states: {} }).entity, /^climate\./);

  const src = fs.readFileSync(new URL('../dist/wall-thermostat-card.js', import.meta.url), 'utf8');
  assert.equal(src.split('callService(').length - 1, 1, 'one callService site');
  assert.match(src, /callService\(\.\.\.thermostatCall\(this\._config\.entity,/, 'and it goes through thermostatCall with the configured entity');
  assert.equal(/fetch\(|XMLHttpRequest|WebSocket|sendMessage|callWS|callApi/.test(src), false, 'no other way out');
  // The dial logic is the lib's: the card defines none of it.
  for (const name of ['dialTap', 'dialDrag', 'climateStep', 'arcPath', 'fillPath', 'tickPath']) {
    assert.equal(new RegExp(`function ${name}\\b`).test(src), false, `${name} is not redefined in the card`);
    assert.ok(src.includes(name), `${name} is used from the lib`);
  }
});
