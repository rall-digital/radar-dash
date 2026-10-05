import test from 'node:test';
import assert from 'node:assert/strict';
import { paletteColor } from '../dist/wall-radar-card.js';
import { configure } from './helpers.mjs';

test('neon hits its stops, interpolates between them and clamps at both ends', () => {
  assert.deepEqual(paletteColor('neon', 15), [0xa2, 0x00, 0x9c, 255]);
  assert.deepEqual(paletteColor('neon', 45), [0xff, 0x8a, 0x3d, 255]);
  assert.deepEqual(paletteColor('neon', 70), [255, 255, 255, 255]);
  // 40 dBZ: halfway from pink (ff4f8b) to orange (ff8a3d).
  assert.deepEqual(paletteColor('neon', 40), [255, Math.round((0x4f + 0x8a) / 2), Math.round((0x8b + 0x3d) / 2), 255]);
  assert.deepEqual(paletteColor('neon', -20), [0x5a, 0x1a, 0x6e, 255]);
  assert.deepEqual(paletteColor('neon', 80), [255, 255, 255, 255]);
});

test('setConfig accepts palette: neon and still rejects an unknown palette', () => {
  assert.equal(configure({ palette: 'neon' }).palette, 'neon');
  assert.throws(() => configure({ palette: 'nope' }), /palette must be one of .*neon/);
});
