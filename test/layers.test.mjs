// wall-radar-layers.js: which layers start on, and the pure helpers each layer draws from. The Leaflet layers
// themselves need a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_KEYS, initialLayers, ago, distMi, compass, cloudAlpha, windVector, boDecode,
  fireName, fireLabel, liveFire, parseFires, nearFires, quakeRadius, quakeTip, nearQuakes,
} from '../dist/wall-radar-layers.js';
import fs from 'node:fs';
import { configure } from './helpers.mjs';

const DAY = 864e5;
const NOW = Date.UTC(2026, 9, 5, 20, 0);
const OKC = [35.47, -97.52]; // Oklahoma City, as in the card's other tests

test('L1 config: layers off unless asked for; unknown names and smoke without hms_url are refused', () => {
  const c = configure({});
  assert.deepEqual([c.layers, c.show_layer_picker, c.hms_url], [[], false, '']);
  assert.deepEqual(configure({ layers: ['fires', 'quakes'] }).layers, ['fires', 'quakes']);
  assert.throws(() => configure({ layers: ['rain'] }), /layers must be a list of/);
  assert.throws(() => configure({ layers: 'fires' }), /layers must be a list of/);
  assert.throws(() => configure({ layers: ['smoke'] }), /smoke layer needs hms_url/);
  assert.equal(configure({ layers: ['smoke'], hms_url: '/local/hms' }).hms_url, '/local/hms');
});

test('L2 the card and the layers file agree on the layer names', () => {
  // every overlay the module offers passes the card's check, and nothing else does
  const overlays = LAYER_KEYS.filter((k) => k !== 'rain');
  assert.deepEqual(configure({ layers: overlays, hms_url: '/x' }).layers, overlays);
});

test('L3 initialLayers: rain plus the config; the picker\'s stored choice wins; no smoke without hms_url', () => {
  const on = initialLayers({ layers: ['fires'] }, null);
  assert.equal(on.rain, true);
  assert.equal(on.fires, true);
  assert.equal(on.wind, false);
  const picked = initialLayers({ layers: ['fires'], show_layer_picker: true, hms_url: '/x' }, { rain: false, fires: false, smoke: true, junk: true });
  assert.deepEqual([picked.rain, picked.fires, picked.smoke, 'junk' in picked], [false, false, true, false]);
  assert.equal(initialLayers({ layers: ['fires'] }, { fires: false }).fires, true, 'stored choice only with the picker');
  assert.equal(initialLayers({ show_layer_picker: true }, { smoke: true }).smoke, false);
});

test('L4 distance, direction and time ago', () => {
  assert.ok(Math.abs(distMi(...OKC, 36.15, -95.99) - 98) < 3, 'Oklahoma City to Tulsa is about 98 mi');
  assert.equal(compass(...OKC, 36.15, -95.99), 'NE');
  assert.equal(compass(...OKC, 34.5, -97.52), 'S');
  assert.deepEqual([ago(0.4), ago(40), ago(180), ago(3 * 1440)], ['just now', '40 min ago', '3 h ago', '3 days ago']);
});

test('L5 clouds: white and cold is cloud; bright desert (warm in infrared) and blue sea are not', () => {
  assert.ok(cloudAlpha(235, 235, 240, 140) > 0.9);
  assert.equal(cloudAlpha(225, 215, 200, 70), 0, 'hot ground');
  assert.equal(cloudAlpha(20, 60, 140, 140), 0, 'dark blue');
  const marine = cloudAlpha(200, 200, 205, 100);
  assert.ok(marine > 0.5 && marine < 1, 'the marine layer sits near the infrared edge');
});

test('L6 wind blows away from where it comes from (screen y points down)', () => {
  const [x, y] = windVector(0, 10); // from the north
  assert.ok(Math.abs(x) < 1e-9 && Math.abs(y - 10) < 1e-9);
  const [x2, y2] = windVector(270, 10); // from the west
  assert.ok(Math.abs(x2 - 10) < 1e-9 && Math.abs(y2) < 1e-9);
});

test('L7 Blitzortung messages unpack', () => {
  // the stream's LZW: a code over 255 is a dictionary word built as it goes
  const lzw = (s) => {
    const dict = new Map();
    let code = 256;
    let w = s[0];
    const out = [];
    for (const ch of s.slice(1)) {
      if (dict.has(w + ch) || (w + ch).length === 1) w += ch;
      else {
        out.push(w.length > 1 ? String.fromCharCode(dict.get(w)) : w);
        dict.set(w + ch, code++);
        w = ch;
      }
    }
    out.push(w.length > 1 ? String.fromCharCode(dict.get(w)) : w);
    return out.join('');
  };
  const msg = '{"time":1759694400000000000,"lat":35.12345,"lon":-97.54321,"alt":0,"pol":0,"mds":9999,"mcg":180}';
  const packed = lzw(msg);
  assert.ok(packed.length < msg.length);
  assert.equal(boDecode(packed), msg);
  assert.equal(JSON.parse(boDecode(packed)).lat, 35.12345);
});

test('L8 fire names, labels and which fires count', () => {
  assert.equal(fireName('MTZ/BDC/82B'), '82B');
  assert.equal(fireName('POWERLINE 2'), 'Powerline 2');
  assert.equal(fireName('BLOCK 9A'), 'Block 9A', 'a letter next to a digit is a code');
  assert.equal(fireLabel({ name: 'RIDGE', size: 6812, pct: 61 }), 'Ridge · 6.8k ac · 61% contained');
  assert.equal(fireLabel({ name: 'FORK', size: 59, pct: null }), 'Fork · 59 ac');
  const live = { type: 'WF', size: 59, pct: 10, out: null, found: NOW - 5 * DAY };
  assert.equal(liveFire(live, NOW), true);
  assert.equal(liveFire({ ...live, size: 0.01 }, NOW), false, 'a dispatch log');
  assert.equal(liveFire({ ...live, type: 'RX' }, NOW), false, 'a prescribed burn');
  assert.equal(liveFire({ ...live, pct: 100 }, NOW), false);
  assert.equal(liveFire({ ...live, out: NOW - DAY }, NOW), false);
  assert.equal(liveFire({ ...live, found: NOW - 61 * DAY }, NOW), false, 'months old');
});

test('L9 NIFC features to fires, and the ones near home for data-home-fires', () => {
  const feature = (name, lat, lon, size, pct) => ({
    properties: { IncidentName: name, IncidentTypeCategory: 'WF', IncidentSize: size, PercentContained: pct, FireDiscoveryDateTime: NOW - DAY, POOState: 'US-OK' },
    geometry: { coordinates: [lon, lat] },
  });
  const fires = parseFires({ features: [feature('NEAR', 35.6, -97.4, 120, 5), feature('FAR', 36.9, -99.0, 5000, 50), feature('TINY', 35.5, -97.5, 2, 0), { properties: {}, geometry: null }] }, NOW);
  assert.deepEqual(fires.map((f) => [f.name, f.state]), [['NEAR', 'OK'], ['FAR', 'OK']]);
  const near = nearFires(fires, OKC);
  assert.equal(near.length, 1);
  assert.deepEqual(Object.keys(near[0]), ['name', 'acres', 'contained', 'mi', 'dir']);
  assert.deepEqual([near[0].name, near[0].acres, near[0].contained, near[0].dir], ['Near', 120, 5, 'NE']);
});

test('L10 quakes: ring size, the hover card, and the ones near home for data-home-quakes', () => {
  assert.equal(quakeRadius(2.5), 4.5);
  assert.equal(quakeRadius(1), 4, 'never smaller than 4 px');
  const p = { mag: 3.62, place: '8 km E of Prague, Oklahoma', time: NOW - 30 * 60e3, felt: 1200, status: 'reviewed' };
  const tip = quakeTip(p, 10, NOW);
  assert.match(tip, /<b>M3\.6<\/b> · 8 km E of Prague, Oklahoma/);
  assert.match(tip, /30 min ago/);
  assert.match(tip, /6 mi deep · felt by 1,200/);
  assert.match(tip, /Reviewed by a seismologist/);
  assert.match(quakeTip({ ...p, place: '<script>' }, null, NOW), /&lt;script&gt;/);
  const q = (mag, lat, lon, t) => ({ properties: { mag, place: 'x', time: t }, geometry: { coordinates: [lon, lat, 5] } });
  const near = nearQuakes([q(2.6, 35.3, -97.7, NOW - 60e3), q(3.0, 35.7, -97.3, NOW - 30e3), q(4.0, 38.5, -100.0, NOW)], OKC);
  assert.deepEqual(near.map((n) => n.mag), [3.0, 2.6], 'within 100 mi, newest first');
});

test('L11 the same performance rules as the Horizon card: no backdrop-filter, keyframes move only opacity or transform', () => {
  const src = fs.readFileSync(new URL('../dist/wall-radar-layers.js', import.meta.url), 'utf8');
  assert.equal(/backdrop-filter/.test(src), false);
  for (const [, body] of src.matchAll(/@keyframes\s+[\w-]+\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)) {
    for (const [, prop] of body.matchAll(/([a-z-]+)\s*:/g)) assert.ok(prop === 'opacity' || prop === 'transform', prop);
  }
});
