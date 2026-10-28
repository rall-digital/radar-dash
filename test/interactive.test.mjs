// interactive: off by default, and only false, true or 'buttons'. The Leaflet wiring itself needs a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WallRadarCard } from '../dist/wall-radar-card.js';
import { configure } from './helpers.mjs';

test('interactive is off by default and in the card picker stub', () => {
  assert.equal(configure({}).interactive, false);
  assert.equal(WallRadarCard.getStubConfig().interactive, false);
});

test('interactive takes false, true or "buttons"', () => {
  for (const v of [false, true, 'buttons']) assert.equal(configure({ interactive: v }).interactive, v);
  for (const v of ['yes', 1, 'pan']) assert.throws(() => configure({ interactive: v }), /interactive must be/);
});

test('with interactive absent every Leaflet gesture handler is off and no zoom control is added', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../dist/wall-radar-card.js', import.meta.url), 'utf8');
  assert.equal(configure({}).interactive, false);
  // gestures follow `interactive === true` only; the zoom control sits behind `if (c.interactive)`
  assert.match(src, /const gestures = c\.interactive === true;/);
  for (const h of ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom']) assert.match(src, new RegExp(`${h}: gestures,`));
  assert.match(src, /zoomControl: false,/);
  assert.equal((src.match(/L\.control\.zoom\(/g) || []).length, 1);
  assert.match(src, /if \(c\.interactive\) \{[^}]*?L\.control\.zoom\(/s);
  // 'buttons' turns no gesture on
  assert.equal(configure({ interactive: 'buttons' }).interactive === true, false);
});

test('echo tiles are keyed by zoom, and the unload key matches the record key', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../dist/wall-radar-card.js', import.meta.url), 'utf8');
  assert.match(src, /scan\.tiles\.set\(`\$\{z\}\/\$\{x\}\/\$\{y\}`/);
  assert.match(src, /scan\.tiles\?\.delete\(`\$\{z\}\/\$\{e\.coords\.x\}\/\$\{e\.coords\.y\}`\)/);
});
