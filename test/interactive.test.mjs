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
