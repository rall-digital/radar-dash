import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { insideGeometry, homeWarnings } from '../dist/wall-radar-card.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/sbw-20260923T1850Z.geojson', import.meta.url)));
const AT = Date.parse('2026-09-23T18:50:00Z'); // the fixture's valid_at

test('a flash flood warning over home is reported with its own expiry', () => {
  assert.deepEqual(homeWarnings(fixture.features, -80.92, 38.81, AT), [{ phenomena: 'FF', expire_utc: '2026-09-23T20:15:00Z' }]);
});

test('nothing is reported for a point outside every polygon', () => {
  assert.deepEqual(homeWarnings(fixture.features, -81.6, 38.4, AT), []);
});

test('types the card does not draw are ignored even when they cover home', () => {
  // (42.25, -87.97) sits inside a Flood Warning (FL.W) and nothing else.
  assert.equal(fixture.features.some((f) => f.properties.phenomena === 'FL' && insideGeometry(f.geometry, -87.97, 42.25)), true);
  assert.deepEqual(homeWarnings(fixture.features, -87.97, 42.25, AT), []);
});

test('an expired warning is dropped', () => {
  assert.deepEqual(homeWarnings(fixture.features, -80.92, 38.81, Date.parse('2026-09-23T20:15:00Z')), []);
});

test('order by severity, no duplicates, holes, watches and the plain expire field', () => {
  const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const poly = { type: 'Polygon', coordinates: [square(0, 0, 10, 10)] };
  const holed = { type: 'Polygon', coordinates: [square(0, 0, 10, 10), square(4, 4, 6, 6)] };
  const f = (phenomena, expire_utc, geometry, significance = 'W') => ({ properties: { phenomena, significance, expire_utc }, geometry });
  const features = [
    f('FF', '2026-09-23T22:00:00Z', poly),
    f('TO', '2026-09-23T21:30:00Z', poly),
    f('TO', '2026-09-23T21:30:00Z', poly), // a second polygon of the same warning
    f('SV', '2026-09-23T21:00:00Z', holed), // home is in the hole
    f('SV', '2026-09-23T21:00:00Z', poly, 'A'), // a watch
    { properties: { phenomena: 'MA', significance: 'W', expire: '2026-09-23T23:00:00Z' }, geometry: { type: 'MultiPolygon', coordinates: [[square(20, 20, 30, 30)], [square(0, 0, 10, 10)]] } },
  ];
  assert.deepEqual(homeWarnings(features, 5, 5, AT), [
    { phenomena: 'TO', expire_utc: '2026-09-23T21:30:00Z' },
    { phenomena: 'FF', expire_utc: '2026-09-23T22:00:00Z' },
    { phenomena: 'MA', expire_utc: '2026-09-23T23:00:00Z' },
  ]);
  assert.equal(insideGeometry({ type: 'Point', coordinates: [5, 5] }, 5, 5), false);
  assert.equal(insideGeometry(null, 5, 5), false);
});
