import test from 'node:test';
import assert from 'node:assert/strict';
import { echoIndex, sourcePixel, tileNumbers, frameNumbers, summarize } from '../dist/wall-radar-card.js';
import { configure } from './helpers.mjs';

test('echo_dbz defaults to 20 and is coerced like the other numbers', () => {
  assert.equal(configure({}).echo_dbz, 20);
  assert.equal(configure({ echo_dbz: '25' }).echo_dbz, 25);
  assert.throws(() => configure({ echo_dbz: 'wet' }), /echo_dbz must be a number/);
});

test('echoIndex: first n0q index at or above the threshold, never 0 (no data)', () => {
  assert.equal(echoIndex(20), 104); // 104 / 2 - 32 = 20
  assert.equal(echoIndex(20.3), 105);
  assert.equal(echoIndex(-40), 1);
});

test('sourcePixel is Web Mercator at 256 px per tile', () => {
  const o = sourcePixel(0, 0, 0);
  assert.deepEqual([o.x, o.y], [128, 128]);
  // Oklahoma City at the z9 tiles v2 requests (zoom 8 + detail 1); expected values from the Web Mercator formula.
  const p = sourcePixel(35.47, -97.52, 9);
  assert.deepEqual([Math.floor(p.x / 256), Math.floor(p.y / 256)], [117, 201]);
  assert.deepEqual([Math.floor(p.x) % 256, Math.floor(p.y) % 256], [78, 251]);
});

test('tileNumbers counts echoes inside the view only and reads the dBZ at home', () => {
  const idx = new Uint8Array(256 * 256).fill(134); // 35 dBZ everywhere
  const x = 10;
  const y = 20;
  const home = { x: x * 256 + 5.7, y: y * 256 + 3.2 };
  const all = { minX: 0, minY: 0, maxX: 1e9, maxY: 1e9 };
  assert.deepEqual(tileNumbers(idx, x, y, all, home, 104), { echoes: 65536, home: 35 });
  // A view that covers only the right half of the tile.
  const right = { minX: x * 256 + 128, minY: 0, maxX: 1e9, maxY: 1e9 };
  assert.equal(tileNumbers(idx, x, y, right, home, 104).echoes, 128 * 256);
  // A view that misses the tile entirely.
  assert.equal(tileNumbers(idx, x, y, { minX: 0, minY: 0, maxX: x * 256, maxY: 1e9 }, home, 104).echoes, 0);
  // Home in another tile.
  assert.equal(tileNumbers(idx, x, y, all, { x: 0, y: 0 }, 104).home, undefined);
  // No data at home reads -32 (below any threshold); pixels under the threshold do not count.
  idx[3 * 256 + 5] = 0;
  idx[0] = 103; // 19.5 dBZ
  assert.deepEqual(tileNumbers(idx, x, y, all, home, 104), { echoes: 65534, home: -32 });
  // A smoothed field is fractional and rounds the way the colouring does; no data blurs to 44 (-10 dBZ).
  const blurred = new Float32Array(256 * 256).fill(44);
  blurred[0] = 103.6; // drawn as 104 = 20 dBZ: counts
  blurred[1] = 103.4; // drawn as 103 = 19.5 dBZ: does not
  assert.deepEqual(tileNumbers(blurred, x, y, all, home, 104), { echoes: 1, home: -10 });
  blurred[3 * 256 + 5] = 134.2;
  assert.deepEqual(tileNumbers(blurred, x, y, all, home, 104), { echoes: 2, home: 35 });
});

test('frameNumbers sums echoes and takes home from the tile that holds it', () => {
  assert.deepEqual(frameNumbers(undefined), { echoes: undefined, home: undefined });
  assert.deepEqual(frameNumbers(new Map()), { echoes: undefined, home: undefined });
  const tiles = new Map([['1/1', { echoes: 5, home: undefined }], ['1/2', { echoes: 7, home: 27.5 }]]);
  assert.deepEqual(frameNumbers(tiles), { echoes: 12, home: 27.5 });
});

test('summarize: newest observed at home, first forecast at or above echo_dbz, forecast peak', () => {
  const t = (m) => Date.parse('2026-09-23T20:00:00Z') + m * 60000;
  const frames = [
    { time: t(-10), forecast: false, home: 40 },
    { time: t(-5), forecast: false, home: 22.5 },
    { time: t(15), forecast: true, home: -32 },
    { time: t(30), forecast: true, home: 25 },
    { time: t(45), forecast: true, home: 47.5 },
  ];
  assert.deepEqual(summarize(frames, 20), { nowDbz: '22.5', rainAt: '2026-09-23T20:30:00.000Z', rainPeakDbz: '47.5' });
  assert.deepEqual(summarize(frames, 30), { nowDbz: '22.5', rainAt: '2026-09-23T20:45:00.000Z', rainPeakDbz: '47.5' });
  assert.deepEqual(summarize(frames.slice(0, 3), 20), { nowDbz: '22.5', rainAt: '', rainPeakDbz: '-32' });
  assert.deepEqual(summarize(frames.slice(0, 2), 20), { nowDbz: '22.5', rainAt: '', rainPeakDbz: '' });
  assert.deepEqual(summarize([], 20), { nowDbz: '', rainAt: '', rainPeakDbz: '' });
  // A frame whose home tile never rendered is unknown, never "dry".
  const unknown = [{ time: t(-5), forecast: false, home: undefined }, { time: t(15), forecast: true, home: undefined }];
  assert.deepEqual(summarize(unknown, 20), { nowDbz: '', rainAt: '', rainPeakDbz: '' });
});
