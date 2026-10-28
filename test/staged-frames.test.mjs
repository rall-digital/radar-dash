// A poll that lands while the first set of frames is still loading: frames that already finished sit in
// _staged, not in _frames or _pending. The REAL _sync and _addFrame run here on a bare card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WallRadarCard } from '../dist/wall-radar-card.js';

const layer = () => ({ removed: false, remove() { this.removed = true; } });

function card() {
  const c = Object.create(WallRadarCard.prototype);
  Object.assign(c, { _config: { frame_count: 8 }, _frames: [], _pending: new Map(), _staged: [], _mode: 'hybrid', _index: 0 });
  c.preloaded = [];
  c._preload = (scan) => c.preloaded.push(scan.key);
  return c;
}

test('S1 a poll during the first load does not fetch a staged frame again', () => {
  const c = card();
  c._staged.push({ key: 'a', time: 1, layer: layer() });
  c._pending.set('b', layer());
  c._sync([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  assert.deepEqual(c.preloaded, ['c']);
});

test('S2 a frame whose scan is already staged or looping is dropped, not added twice', async () => {
  const c = card();
  c._staged.push({ key: 'a', time: 1, layer: layer() });
  const again = { key: 'a', time: 1, layer: layer() };
  c._addFrame(again);
  assert.equal(c._staged.length, 1);
  await Promise.resolve();
  assert.ok(again.layer.removed);

  c._staged = null;
  c._frames.push({ key: 'b', time: 2, layer: layer() });
  c._addFrame({ key: 'b', time: 2, layer: layer() });
  assert.equal(c._frames.length, 1);
});

test('S3 CONTROL: new scans still join', () => {
  const c = card();
  c._staged = null;
  c._addFrame({ key: 'a', time: 1, layer: layer() });
  c._addFrame({ key: 'b', time: 2, layer: layer() });
  assert.deepEqual(c._frames.map((f) => f.key), ['a', 'b']);
});

test('S4 a scan that is looping still joins the staged replacement set (hybrid a,b,c,d -> fallback -> b,c,d,e)', () => {
  const c = card();
  for (const [i, k] of ['a', 'b', 'c', 'd'].entries()) c._frames.push({ key: k, time: i, layer: layer() });
  c._staged = []; // a composite fallback started and has not finished
  const e = { key: 'e', time: 4, layer: layer() };
  for (const [k, t] of [['b', 1], ['c', 2], ['d', 3]]) c._addFrame({ key: k, time: t, layer: layer() });
  c._addFrame(e);
  assert.deepEqual(c._staged.map((f) => f.key), ['b', 'c', 'd', 'e']);
  assert.equal(e.layer.removed, false);
});

test('S5 a forecast frame is a dupe only against the forecast list it joins', async () => {
  const c = card();
  c._staged = null;
  c._fcStaged = [{ key: 'f1', time: 9, forecast: true, layer: layer() }];
  c._frames.push({ key: 'f2', time: 10, forecast: true, layer: layer() });
  c._addFrame({ key: 'f2', time: 10, forecast: true, layer: layer() });
  assert.deepEqual(c._fcStaged.map((f) => f.key), ['f1', 'f2']);
  const again = { key: 'f1', time: 9, forecast: true, layer: layer() };
  c._addFrame(again);
  await Promise.resolve();
  assert.ok(again.layer.removed);
});

test('S6 _syncForecast does not fetch a staged forecast frame again', () => {
  const c = card();
  c._staged = null;
  c._fcStaged = [{ key: 'f1', time: Date.now() + 6e5, forecast: true, layer: layer() }];
  c._updateSummaries = () => {};
  const src = (key) => ({ key, time: Date.now() + 6e5, forecast: true, sources: [{ url: 'u' }] });
  c._syncForecast([src('f1'), src('f2')]);
  assert.deepEqual(c.preloaded, ['f2']);
});
