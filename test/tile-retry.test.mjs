// Tile holes: a radar tile whose every source failed is requested again on later polls,
// bounded, bypassing the HTTP cache, and drawn into its own canvas in place. The REAL _poll, _preload (finish,
// _addFrame, _settle), _sync, _renderTile, fetchTile, the hole code and _refade run here against a fake fetch and
// node:test fake timers (setTimeout, setInterval, Date). Node has no DOM or Leaflet, so the radar layer is a fake that
// loads a fixed grid of tiles through card._drawTile the way createTile does (that wiring itself is covered only by
// a headless-Chrome check, not in this repo); the canvas, createImageBitmap, _composeTile (pixels) and _start (the Leaflet
// boot) are stood in for.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { WallRadarCard } from '../dist/wall-radar-card.js';

const MIN = 60000;
const T0 = Date.UTC(2026, 8, 29, 18, 0); // on a 5-minute boundary: the next scan appears at the 18:02 poll
const iso = (t) => new Date(t).toISOString().slice(0, 19) + 'Z';
const stamp = (t) => new Date(t).toISOString().replace(/\D/g, '').slice(0, 12);
// Scan times the fake scan list serves at T0 (the newest 5 min before), and the MRMS frame each is paired with.
const scanAt = (k) => T0 - (5 + 5 * k) * MIN; // k = 0 is the newest
const mrmsFor = (t) => Math.floor(t / 120000) * 120000;
// Both sources of one frame's tile at (x, y).
const frameTile = (t, x, y) => (r) => r.x === x && r.y === y && ((r.src === 'site' && r.stamp === stamp(t)) || (r.src === 'mrms' && r.stamp === stamp(mrmsFor(t))));
const GRID = [0, 1, 2, 3].flatMap((x) => [0, 1].map((y) => ({ x, y, z: 9 }))); // 8 tiles per frame
const TILE_RE = /\/(ridge::[A-Z]+-N0B|mrms::lcref|hrrr::REFD-F\d{4})-(\d{12})\/(\d+)\/(\d+)\/(\d+)\.png/;

function env(t) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });
  const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap };
  const warn = console.warn;
  console.warn = () => {}; // failed tiles and polls warn; the assertions say what matters
  t.after(() => {
    mock.timers.reset();
    Object.assign(globalThis, saved);
    console.warn = warn;
  });
  const listeners = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = listeners;
  globalThis.document = { ...listeners, visibilityState: 'visible' };
  globalThis.createImageBitmap = async (blob) => ({ blob, close() {} });
  // tile(r) -> 200 | 503 | 'error' for a tile request r = { url, src, stamp, x, y, n (earlier requests of this URL) }
  const net = { json: 'ok', tile: () => 200, tiles: [], urls: [] };
  globalThis.fetch = (url, opts = {}) => {
    url = String(url);
    const m = url.match(TILE_RE);
    if (m) {
      const src = m[1].startsWith('ridge') ? 'site' : m[1].startsWith('mrms') ? 'mrms' : 'hrrr';
      const r = { url, src, stamp: m[2], x: +m[4], y: +m[5], cache: opts.cache, at: Date.now(), n: net.tiles.filter((u) => u.url === url).length };
      net.tiles.push(r);
      const status = net.tile(r);
      if (status === 'error') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({ ok: status === 200, status, blob: async () => ({ url }) });
    }
    net.urls.push(url);
    if (net.json === 'down') return Promise.reject(new TypeError('Failed to fetch'));
    const now = Date.now();
    let body;
    if (url.includes('/json/radar.py')) {
      const newest = Math.floor((now - 2 * MIN) / (5 * MIN)) * 5 * MIN;
      body = { scans: Array.from({ length: 12 }, (_, i) => ({ ts: new Date(newest - (11 - i) * 5 * MIN).toISOString().slice(0, 16) + 'Z' })) };
    } else if (url.includes('/mrms/lcref.json')) body = { meta: { start_valid: iso(Math.floor((now - 2 * MIN) / 120000) * 120000) } };
    else if (url.includes('NEXRAD.geojson')) body = { features: [{ id: 'TLX', properties: { sid: 'TLX' }, geometry: { type: 'Point', coordinates: [-97.2778, 35.3331] } }] };
    else body = { type: 'FeatureCollection', features: [] };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  };
  return { net };
}

const canvas = () => {
  const el = { tagName: 'CANVAS', width: 256, height: 256, draws: 0, classList: new Set() };
  el.getContext = () => ({ clearRect() {}, drawImage: () => el.draws++ });
  return el;
};

// Leaflet's radar layer, reduced to what _preload, _refade and the hole code touch. addTo loads every tile of GRID
// through card._drawTile (as createTile does); each one's done() marks it loaded, adds leaflet-tile-loaded on success,
// fires tileload or tileerror, and 'load' once none is left loading. remove() drops every tile and the map.
function fakeLayerClass(card) {
  return class FakeRadarLayer {
    constructor(url, options) {
      this.options = options;
      this._tiles = {};
      this._map = null;
      this._on = {};
    }
    on(type, fn) {
      (this._on[type] = this._on[type] || []).push(fn);
      return this;
    }
    once(type, fn) {
      const w = (e) => {
        this.off(type, w);
        fn(e);
      };
      w.fn = fn;
      return this.on(type, w);
    }
    off(type, fn) {
      this._on[type] = (this._on[type] || []).filter((h) => h !== fn && h.fn !== fn);
      return this;
    }
    fire(type, e = {}) {
      for (const h of [...(this._on[type] || [])]) h(e);
    }
    _getZoomForUrl() {
      return 9;
    }
    _tileCoordsToKey(c) {
      return `${c.x}:${c.y}:${c.z}`;
    }
    setOpacity() {}
    addTo(map) {
      this._map = map;
      let left = GRID.length;
      for (const coords of GRID) {
        const el = canvas();
        const tile = (this._tiles[this._tileCoordsToKey(coords)] = { el, coords, loaded: 0 });
        card._drawTile(this, coords, el).then(
          () => this._ready(tile, null, --left),
          (err) => this._ready(tile, err, --left),
        );
      }
      return this;
    }
    _ready(tile, err, left) {
      if (!this._map) return;
      tile.loaded = Date.now();
      if (!err) tile.el.classList.add('leaflet-tile-loaded');
      this.fire(err ? 'tileerror' : 'tileload', { coords: tile.coords });
      if (!left) this.fire('load');
    }
    remove() {
      this._map = null;
      this._tiles = {};
      return this;
    }
  };
}

const mapStub = () => ({ getPane: () => ({ style: { setProperty() {} } }), remove() {} });

function makeCard(e, config = {}) {
  const card = Object.create(WallRadarCard.prototype);
  Object.assign(card, { _frames: [], _pending: new Map(), _queue: [], _active: 0, _index: 0, _mode: null, _backoff: 0, _built: false, dataset: {}, isConnected: false });
  card.shadowRoot = { innerHTML: '', getElementById: () => null };
  card.calls = { teardown: 0 };
  // _start without Leaflet (as in watchdog.test.mjs): build flag, generation, a map stand-in, then the real _resume.
  card._start = function () {
    if (this._built) return this._resume();
    this._gen = (this._gen || 0) + 1;
    this._built = true;
    this._map = mapStub();
    this._resume();
  };
  const teardown = WallRadarCard.prototype._teardown;
  card._teardown = function () {
    this.calls.teardown++;
    return teardown.call(this);
  };
  // Pixels are not what is tested: a composed tile is a token that records which sources it was made from.
  card._composeTile = async (scan, imgs) => ({ sources: imgs.map((r) => r.status), close() {} });
  card._radarLayer = fakeLayerClass(card);
  // A neutral centre and its nearest site (Oklahoma City, TLX).
  card.setConfig({ center_latitude: 35.47, center_longitude: -97.52, site: 'TLX', warnings: false, forecast_hours: 0, frame_count: 4, watchdog: false, ...config });
  return card;
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};
async function advance(ms, step = 500) {
  for (let done = 0; done < ms; done += step) {
    mock.timers.tick(Math.min(step, ms - done));
    await flush();
  }
}
async function connect(card) {
  card.isConnected = true;
  card.connectedCallback();
  await advance(5000); // the first poll, every preload, and the 1.5-s retry inside a failed tile fetch
}
const holes = (card) =>
  Object.fromEntries(
    String(card.dataset.holes || '')
      .split(' ')
      .filter(Boolean)
      .map((kv) => kv.split('='))
      .map(([k, v]) => [k, Number(v)]),
  );
const frameAt = (card, t) => card._frames.find((f) => f.time === t);
const tileEl = (frame, x, y) => frame.layer._tiles[`${x}:${y}:9`]?.el;
const count = (e, pred) => e.net.tiles.filter(pred).length;
const shown = (el) => el.classList.has('leaflet-tile-loaded');

// ---- H1-H3: a hole is asked for again and filled in place --------------------------------------------------------

test('H1 both sources 503 for one tile of a kept frame: re-requested on the next poll and filled in place', async (t) => {
  const { net } = env(t);
  const card = makeCard({ net });
  const hole = frameTile(scanAt(0), 1, 0);
  let broken = true;
  net.tile = (r) => (broken && hole(r) ? 503 : 200);
  await connect(card);
  const frame = frameAt(card, scanAt(0));
  assert.ok(frame, 'the newest frame joined the loop (a frame with a hole is kept)');
  const el = tileEl(frame, 1, 0);
  assert.equal(el.draws, 0, 'the hole is blank');
  assert.equal(shown(el), false, 'and hidden (Leaflet shows a tile only with leaflet-tile-loaded)');
  assert.equal(tileEl(frame, 2, 0).draws, 1, 'CONTROL: its neighbour drew');
  const others = (r) => !hole(r) && (r.stamp === stamp(scanAt(0)) || r.stamp === stamp(mrmsFor(scanAt(0))));
  const othersBefore = count({ net }, others);
  const layer = frame.layer;
  broken = false;
  const before = count({ net }, hole);
  await advance(2 * MIN + 1000); // one poll
  assert.ok(count({ net }, hole) > before, 're-requested');
  assert.equal(el.draws, 1, 'drawn into the same canvas');
  assert.equal(shown(el), true, 'and shown');
  assert.equal(frameAt(card, scanAt(0))?.layer, layer, 'same layer: no frame rebuild');
  assert.equal(tileEl(frame, 1, 0), el, 'same canvas');
  assert.equal(count({ net }, others), othersBefore, 'no other tile of that frame requested again');
  assert.deepEqual([holes(card).open, holes(card).filled], [0, 1]);
});

test('H2 a 503 inside one tile fetch is retried once after 1.5 s, bypassing the HTTP cache; healed there, no hole', async (t) => {
  const { net } = env(t);
  const card = makeCard({ net });
  const tile = frameTile(scanAt(0), 1, 0);
  net.tile = (r) => (tile(r) && r.n === 0 ? 503 : 200);
  await connect(card);
  const site = net.tiles.filter((r) => tile(r) && r.src === 'site');
  assert.equal(site.length, 2, 'the site tile was asked for twice');
  assert.equal(site[0].cache, undefined, 'the first request uses the cache as usual');
  assert.equal(site[1].cache, 'reload', 'the retry skips the cache (IEM 503s are max-age=300)');
  assert.ok(site[1].at - site[0].at >= 1500, `after 1.5 s (${site[1].at - site[0].at} ms)`);
  const el = tileEl(frameAt(card, scanAt(0)), 1, 0);
  assert.equal(el.draws, 1, 'drawn');
  assert.equal(card.dataset.holes, undefined, 'no hole');
});

test('H3 every request of a hole retry bypasses the HTTP cache', async (t) => {
  const { net } = env(t);
  const card = makeCard({ net });
  const hole = frameTile(scanAt(0), 1, 0);
  net.tile = (r) => (hole(r) ? 503 : 200);
  await connect(card);
  const from = Date.now();
  await advance(2 * MIN + 1000);
  const retry = net.tiles.filter((r) => hole(r) && r.at >= from);
  assert.equal(retry.length, 4, 'one hole retry: two requests per source');
  assert.deepEqual([...new Set(retry.map((r) => r.cache))], ['reload']);
});

// ---- H4-H5: bounded ------------------------------------------------------------------------------------------

test('H4 a hole that never heals is re-requested 3 times, at least 60 s apart, then left', async (t) => {
  const { net } = env(t);
  const card = makeCard({ net }, { frame_count: 10 }); // the frame stays in the loop the whole time
  const hole = frameTile(scanAt(0), 1, 0);
  net.tile = (r) => (hole(r) ? 503 : 200);
  await connect(card);
  assert.equal(count({ net }, hole), 4, 'first load: two requests per source');
  await advance(30 * MIN, 1000);
  assert.ok(frameAt(card, scanAt(0)), 'still in the loop: it stopped because of the limit, not a rotation');
  assert.equal(count({ net }, hole), 4 + 3 * 4, 'then 3 retries of two requests per source, and no more');
  const starts = net.tiles.filter((r) => hole(r) && r.src === 'site' && r.cache === 'reload' && r.n % 2 === 0 && r.n > 0).map((r) => r.at);
  assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 60000, `attempts ${starts[i] - starts[i - 1]} ms apart`);
  assert.deepEqual(holes(card), { open: 0, filled: 0, gaveup: 1, retries: 3 });
});

test('H5 at most 8 holes are re-requested per poll: the least-tried first, then the newest frame', async (t) => {
  const { net } = env(t);
  const card = makeCard({ net }, { frame_count: 10 }); // holes in the 4 newest of 10 frames (none rotates out): 12
  const broken = [0, 1, 2, 3].flatMap((k) => [1, 2, 3].map((x) => frameTile(scanAt(k), x, 0)));
  net.tile = (r) => (broken.some((f) => f(r)) ? 503 : 200);
  await connect(card);
  assert.equal(holes(card).open, 12);
  const retried = (from) => {
    const reqs = net.tiles.filter((r) => r.at >= from && r.src === 'site' && r.cache === 'reload' && r.n > 0 && r.n % 2 === 0);
    return reqs.map((r) => `${r.stamp}/${r.x}`); // one per hole retried (the first site request of the attempt)
  };
  const byFrame = (list) => [0, 1, 2, 3].map((k) => list.filter((s) => s.startsWith(stamp(scanAt(k)))).length);
  let from = Date.now();
  await advance(2 * MIN + 1000);
  const p1 = retried(from);
  assert.equal(p1.length, 8, 'poll 1: 8 of the 12');
  assert.deepEqual(byFrame(p1), [3, 3, 2, 0], 'the newest frames first');
  from = Date.now();
  await advance(2 * MIN + 1000);
  const p2 = retried(from);
  assert.equal(p2.length, 8, 'poll 2: 8 again');
  assert.deepEqual(byFrame(p2).slice(2), [1, 3], 'including the 4 never tried');
  let before = holes(card).retries;
  for (let i = 0; i < 6; i++) {
    await advance(2 * MIN);
    assert.ok(holes(card).retries - before <= 8, `never more than 8 per poll (${holes(card).retries - before})`);
    before = holes(card).retries;
  }
});

// ---- H6-H8: what is not a hole, what stops being one --------------------------------------------------------------

for (const failing of ['site', 'mrms']) {
  test(`H6 one source failing (${failing}) draws from the other: not a hole, never retried`, async (t) => {
    const { net } = env(t);
    const card = makeCard({ net });
    const tile = frameTile(scanAt(0), 1, 0);
    net.tile = (r) => (tile(r) && r.src === failing ? 503 : 200);
    await connect(card);
    const el = tileEl(frameAt(card, scanAt(0)), 1, 0);
    assert.equal(el.draws, 1, 'drawn');
    assert.equal(shown(el), true);
    const n = count({ net }, tile);
    await advance(10 * MIN, 1000);
    assert.equal(count({ net }, tile), n, 'no request for it after the first load');
    assert.equal(card.dataset.holes, undefined, 'never a hole');
  });
}

test('H7 the hole of a frame that rotated out is dropped and never requested again', async (t) => {
  const { net } = env(t);
  const card = makeCard({ net }, { frame_count: 2 }); // 17:50 and 17:55 at first; 18:00 arrives at the 18:02 poll
  const hole = frameTile(scanAt(1), 1, 0);
  let broken = true;
  net.tile = (r) => (broken && hole(r) ? 503 : 200);
  await connect(card);
  assert.equal(holes(card).open, 1);
  await advance(2 * MIN + 5000); // one retry (fails), then the new scan rotates 17:50 out
  assert.equal(frameAt(card, scanAt(1)), undefined, 'rotated out');
  broken = false; // it would answer now
  const n = count({ net }, hole);
  await advance(10 * MIN, 1000);
  assert.equal(count({ net }, hole), n, 'never requested again');
  assert.equal(holes(card).open, 0, 'dropped');
  assert.equal(holes(card).gaveup, 0, 'dropped, not given up');
});

test('H8 teardown: a retry waiting out its 1.5 s makes no request, and no hole is requested after', async (t) => {
  const { net } = env(t);
  const card = makeCard({ net });
  const hole = frameTile(scanAt(0), 1, 0);
  net.tile = (r) => (hole(r) ? 503 : 200);
  await connect(card);
  await advance(2 * MIN - 10000); // just before the 2-min poll
  const n = count({ net }, hole);
  await advance(5500, 500); // the poll: the hole retry's first requests, then 0.5 s into the 1.5-s delay
  assert.equal(count({ net }, hole), n + 2, 'the retry started');
  card._teardown();
  const all = net.tiles.length;
  await advance(30 * MIN, 1000);
  assert.equal(net.tiles.length, all, 'no tile request after the teardown');
  assert.equal(holes(card).open, 0, 'holes forgotten');
});

// ---- H9: retries are not polls -------------------------------------------------------------------------------

test('H9 a hole filled while the scan list is down is not a successful poll: the re-init still comes at 20 min', async (t) => {
  const { net } = env(t);
  const card = makeCard({ net }, { watchdog: true, watchdog_reload_min: 0 });
  const hole = frameTile(scanAt(0), 1, 0);
  let broken = true;
  net.tile = (r) => (broken && hole(r) ? 503 : 200);
  await connect(card);
  const okAt = card._pollOkAt;
  broken = false;
  net.json = 'down';
  await advance(2 * MIN + 5000);
  assert.equal(holes(card).filled, 1, 'the hole was filled on a failed poll');
  assert.equal(card._pollOkAt, okAt, 'and that is not a successful poll');
  assert.ok(card._backoff > 0, 'nor did it clear the backoff');
  await advance(17 * MIN, 5000);
  assert.equal(card.calls.teardown, 0, 'no re-init before 20 min');
  await advance(4 * MIN, 5000);
  assert.equal(card.calls.teardown, 1, 're-init at 20 min without a successful poll, as without holes');
});

test('H9 hole retries schedule nothing: with the poll chain stalled, a hole is not requested again', async (t) => {
  const { net } = env(t);
  const card = makeCard({ net }); // watchdog off
  const hole = frameTile(scanAt(0), 1, 0);
  net.tile = (r) => (hole(r) ? 503 : 200);
  await connect(card);
  card._fetchScans = () => new Promise(() => {}); // every later poll hangs before its scan list
  await advance(2 * MIN + 5000); // that poll still makes its one hole retry, at its start
  const n = count({ net }, hole);
  await advance(60 * MIN, 5000);
  assert.equal(count({ net }, hole), n);
  assert.equal(holes(card).retries, 1);
});

// ---- H10: an IEM tile outage stays bounded --------------------------------------------------------------------

test('H10a two tiles of every frame down for 3 h: each hole <= 3 retries, <= 8 per poll, total requests bounded', async (t) => {
  const { net } = env(t);
  const card = makeCard({ net }, { frame_count: 10 });
  const down = (r) => (r.x === 1 && r.y === 0) || (r.x === 2 && r.y === 1);
  net.tile = (r) => (down(r) ? 503 : 200);
  await connect(card);
  let before = holes(card).retries;
  let maxPerPoll = 0;
  for (let i = 0; i < 90; i++) {
    await advance(2 * MIN, 5000);
    maxPerPoll = Math.max(maxPerPoll, holes(card).retries - before);
    before = holes(card).retries;
  }
  const perUrl = new Map();
  for (const r of net.tiles) perUrl.set(r.url, (perUrl.get(r.url) || 0) + 1);
  const frames = new Set(net.tiles.filter((r) => r.src === 'site').map((r) => r.stamp)).size;
  const worst = Math.max(...[...perUrl].filter(([u]) => down(net.tiles.find((r) => r.url === u))).map(([, n]) => n));
  const bound = frames * (6 * 2 + 2 * 2 * 8); // healthy tiles once per source; a down tile <= 8 per source
  t.diagnostic(`3 h: ${frames} frames, ${net.tiles.length} tile requests (bound ${bound}), worst down tile ${worst} per source URL, max ${maxPerPoll} hole retries per poll, holes ${card.dataset.holes}`);
  assert.ok(maxPerPoll <= 8, `per poll ${maxPerPoll}`);
  assert.ok(worst <= 8, 'a down tile: 2 on first load + 3 retries x 2, per source');
  assert.ok(net.tiles.length <= bound, `${net.tiles.length} <= ${bound}`);
  assert.ok(holes(card).gaveup > 0 && holes(card).filled === 0);
});

test('H10b every tile down for 3 h (scan list up): no frame joins, no hole is kept or retried', async (t) => {
  const { net } = env(t);
  const card = makeCard({ net }, { frame_count: 10 });
  net.tile = () => 503;
  await connect(card);
  await advance(3 * 60 * MIN, 5000);
  const polls = net.urls.filter((u) => u.includes('/json/radar.py')).length;
  t.diagnostic(`3 h: ${polls} polls, ${net.tiles.length} tile requests (${Math.round(net.tiles.length / polls)} per poll: frames with no tile loaded are re-listed every poll, as before; 2 per source now), holes ${card.dataset.holes}`);
  assert.equal(card._frames.length, 0, 'no blank frame joins the loop');
  assert.equal(holes(card).retries, 0, 'no hole retry: those frames never joined the loop');
  assert.equal(holes(card).filled, 0);
});

// ---- controls ---------------------------------------------------------------------------------------------------

test('C1 CONTROL: healthy tiles for 1 h: nothing retried, nothing bypasses the cache, no data-holes', async (t) => {
  const { net } = env(t);
  const card = makeCard({ net });
  await connect(card);
  await advance(60 * MIN, 5000);
  assert.ok(card._frames.length === 4, 'frames loaded');
  assert.ok(net.tiles.length >= 4 * 8 * 2, `tiles were requested (${net.tiles.length})`);
  assert.equal(net.tiles.filter((r) => r.cache !== undefined).length, 0, 'no cache bypass');
  const perUrl = new Map();
  for (const r of net.tiles) perUrl.set(r.url, (perUrl.get(r.url) || 0) + 1);
  assert.equal(Math.max(...perUrl.values()), 1, 'each tile once per source');
  assert.equal(card.dataset.holes, undefined);
});

test('C2 the context redraw is untouched: _refade redraws every loaded tile, a hole keeps its attempt count', async (t) => {
  const { net } = env(t);
  const card = makeCard({ net });
  const hole = frameTile(scanAt(0), 1, 0);
  net.tile = (r) => (hole(r) ? 503 : 200);
  await connect(card);
  card._refade();
  await advance(10000);
  const els = card._frames.flatMap((f) => Object.values(f.layer._tiles).map((x) => x.el));
  const holeEl = tileEl(frameAt(card, scanAt(0)), 1, 0);
  assert.equal(els.length, 32);
  assert.deepEqual([...new Set(els.filter((el) => el !== holeEl).map((el) => el.draws))], [2], 'every other tile drawn again, once');
  assert.equal(holeEl.draws, 0, 'the hole could not be drawn (still 503)');
  assert.deepEqual([holes(card).open, holes(card).retries], [1, 0], 'and the redraw was not a hole retry');
});
