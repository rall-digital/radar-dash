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
