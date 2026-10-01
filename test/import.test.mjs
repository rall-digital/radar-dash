import test from 'node:test';
import assert from 'node:assert/strict';
import { N0Q_PALETTE, LCREF_PALETTE } from '../dist/wall-radar-card.js';
import { configure } from './helpers.mjs';

test('the card imports in Node and its setConfig still validates', () => {
  assert.equal(N0Q_PALETTE.length, 256 * 6);
  assert.equal(LCREF_PALETTE.length, 256 * 6);
  assert.equal(configure({}).basemap, 'hillshade_dark_coast');
  assert.throws(() => configure({ source: 'nope' }), /source must be/);
});
