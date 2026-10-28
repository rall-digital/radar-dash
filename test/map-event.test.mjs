// The wall-radar-map event and the public `map` getter. The Leaflet wiring needs a browser, so the event is
// checked at the source and the getter on a bare card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WallRadarCard } from '../dist/wall-radar-card.js';

test('the card fires wall-radar-map with detail { map, L }', () => {
  const src = readFileSync(new URL('../dist/wall-radar-card.js', import.meta.url), 'utf8');
  assert.match(src, /new CustomEvent\('wall-radar-map', \{ detail: \{ map, L \} \}\)/);
});

test('map is a read-only getter: null before build, the map once built', () => {
  const c = Object.create(WallRadarCard.prototype);
  assert.equal(c.map, null);
  c._map = { id: 'm' };
  assert.deepEqual(c.map, { id: 'm' });
  assert.throws(() => { 'use strict'; c.map = 1; }, TypeError);
  c._map = null;
  assert.equal(c.map, null);
});
