import test from 'node:test';
import assert from 'node:assert/strict';
import { wantedBasemap, inkLut, toneInk } from '../dist/wall-radar-card.js';
import { configure } from './helpers.mjs';

test('basemap takes ink, night and auto; day_basemap defaults to ink', () => {
  for (const basemap of ['hillshade_dark_coast', 'hillshade_dark', 'satellite', 'ink', 'night', 'auto']) assert.equal(configure({ basemap }).basemap, basemap);
  assert.equal(configure({}).day_basemap, 'ink');
  assert.throws(() => configure({ basemap: 'dark' }), /basemap must be one of hillshade_dark, hillshade_dark_coast, satellite, ink, night, auto/);
  assert.throws(() => configure({ basemap: 'auto', day_basemap: 'auto' }), /day_basemap must be one of hillshade_dark, hillshade_dark_coast, satellite, ink, night$/);
});

test('auto follows sun.sun and falls back to day_basemap', () => {
  const c = { basemap: 'auto', day_basemap: 'ink' };
  assert.equal(wantedBasemap(c, 'above_horizon'), 'ink');
  assert.equal(wantedBasemap(c, 'below_horizon'), 'night');
  assert.equal(wantedBasemap(c, undefined), 'ink'); // no sun.sun entity
  assert.equal(wantedBasemap(c, 'unavailable'), 'ink');
  assert.equal(wantedBasemap({ ...c, day_basemap: 'hillshade_dark_coast' }, 'above_horizon'), 'hillshade_dark_coast');
  assert.equal(wantedBasemap({ basemap: 'satellite', day_basemap: 'ink' }, 'below_horizon'), 'satellite');
});

test('night_basemap: defaults to night, validated like day_basemap, and chosen after sunset', () => {
  assert.equal(configure({}).night_basemap, 'night');
  assert.equal(configure({ basemap: 'auto', night_basemap: 'ink' }).night_basemap, 'ink');
  assert.throws(() => configure({ basemap: 'auto', night_basemap: 'auto' }), /night_basemap must be one of hillshade_dark, hillshade_dark_coast, satellite, ink, night$/);
  assert.throws(() => configure({ night_basemap: 'dark' }), /night_basemap must be one of/);
  const horizon = configure({ basemap: 'auto', day_basemap: 'satellite', night_basemap: 'ink' });
  assert.equal(wantedBasemap(horizon, 'below_horizon'), 'ink');
  assert.equal(wantedBasemap(horizon, 'above_horizon'), 'satellite');
  assert.equal(wantedBasemap(horizon, undefined), 'satellite'); // an unknown sun still counts as day
  assert.equal(wantedBasemap(configure({ basemap: 'auto' }), 'below_horizon'), 'night'); // the default is unchanged
  assert.equal(wantedBasemap(configure({ basemap: 'satellite', night_basemap: 'ink' }), 'below_horizon'), 'satellite'); // only auto follows the sun
});

test('ink maps luma onto the navy ramp, clamps at both ends and keeps alpha', () => {
  const lut = inkLut();
  assert.deepEqual([...lut.slice(0, 3)], [10, 17, 35]);
  assert.deepEqual([...lut.slice(39 * 3, 39 * 3 + 3)], [10, 17, 35]);
  assert.deepEqual([...lut.slice(121 * 3, 121 * 3 + 3)], [174, 190, 225]);
  assert.deepEqual([...lut.slice(255 * 3)], [174, 190, 225]);
  for (let l = 1; l < 256; l++) assert.ok(lut[l * 3 + 2] >= lut[(l - 1) * 3 + 2], `monotonic at ${l}`);
  const px = Uint8ClampedArray.of(0, 0, 0, 255, 255, 255, 255, 128, 80, 80, 80, 255, 200, 40, 40, 7);
  toneInk(px);
  assert.deepEqual([...px], [10, 17, 35, 255, 174, 190, 225, 128, 92, 104, 130, 255, 108, 120, 149, 7]);
});

test('satellite_fade_dbz: 8 by default, a narrower later fade only while satellite shows', async () => {
  const { fadeFor } = await import('../dist/wall-radar-card.js');
  const c = configure({});
  assert.equal(c.satellite_fade_dbz, 8);
  assert.deepEqual(fadeFor(c, 'satellite'), { min_dbz: 8, fade_dbz: 12 });
  for (const b of ['ink', 'night', 'hillshade_dark_coast', 'hillshade_dark', undefined]) assert.deepEqual(fadeFor(c, b), { min_dbz: 5, fade_dbz: 15 }, String(b));
  // The v1 look's hard cut at 10 is above 8: untouched on satellite.
  assert.deepEqual(fadeFor(configure({ min_dbz: 10, fade_dbz: 10 }), 'satellite'), { min_dbz: 10, fade_dbz: 10 });
  assert.deepEqual(fadeFor(configure({ satellite_fade_dbz: false }), 'satellite'), { min_dbz: 5, fade_dbz: 15 });
  assert.deepEqual(fadeFor(configure({ satellite_fade_dbz: 12 }), 'satellite'), { min_dbz: 12, fade_dbz: 16 });
  assert.throws(() => configure({ satellite_fade_dbz: 'x' }), /satellite_fade_dbz must be a number/);
});
