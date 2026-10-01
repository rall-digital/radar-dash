// The watchdog: the card heals a dead, hung or stale update loop without a page reload.
// The REAL _poll, _resume, backoff and watchdog run here against a fake fetch and node:test fake timers (setTimeout,
// setInterval, Date). Node has no DOM or Leaflet, so only the layer build (_preload: frames join the loop at once)
// and the Leaflet boot (_start) are stood in for. A headless-Chrome check (not in this repo) runs the whole stack.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { WallRadarCard } from '../dist/wall-radar-card.js';
import { radarConfig } from '../dist/wall-horizon-lib.js';
import { configure } from './helpers.mjs';

const MIN = 60000;
const T0 = Date.UTC(2026, 8, 29, 18, 0); // on a 5-minute boundary
const RELOAD_KEY = 'wall-radar-card:last-reload';
const iso = (t) => new Date(t).toISOString().slice(0, 19) + 'Z';

// A throw after the poll's try rejects the timer callback's promise: that is how the chain dies.
// node:test fails whichever test is running on any unhandled rejection, so this file takes them over: the
// injected ones are counted, and any other one fails the test it happened in (see env's t.after).
// The runner installs its own listener once the first test starts, so env() takes over at the start of each test.
const rejections = [];
const onRejection = (r) => rejections.push(r);

// addEventListener / removeEventListener with the DOM's dedupe (same type + function = one listener), counted.
class Target {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn({ type });
  }
  get count() {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

function env(t, { storage = 'ok', store = new Map() } = {}) {
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', onRejection);
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });
  const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  const warn = console.warn;
  console.warn = () => {}; // every failed poll warns; the assertions say what matters
  const seen = rejections.length;
  t.after(() => {
    mock.timers.reset();
    Object.assign(globalThis, saved);
    console.warn = warn;
    const other = rejections.slice(seen).filter((r) => !String(r?.message).startsWith('INJECTED'));
    assert.deepEqual(other.map(String), [], 'no unexpected unhandled rejections');
  });
  const win = new Target();
  const doc = Object.assign(new Target(), { visibilityState: 'visible' });
  const reloads = [];
  // Live intervals, counted across the mocked setInterval / clearInterval.
  const live = new Set();
  const si = globalThis.setInterval;
  const ci = globalThis.clearInterval;
  globalThis.setInterval = (...a) => {
    const id = si(...a);
    live.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    live.delete(id);
    ci(id);
  };
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.location = { reload: () => reloads.push(Date.now()) };
  globalThis.localStorage =
    storage === 'throws'
      ? { getItem() { throw new Error('SecurityError: storage disabled'); }, setItem() { throw new Error('SecurityError: storage disabled'); } }
      : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  // mode: ok | down (every request fails like a dropped network) | hang (the scan list never answers; like a real
  // fetch, an abort signal rejects it)
  // slowMs: the scan list answers after this long (an abort before then rejects it, counted in aborts)
  const net = { mode: 'ok', urls: [], echoes: 0, slowMs: 0, aborts: 0 };
  globalThis.fetch = (url, opts = {}) => {
    url = String(url);
    net.urls.push(url);
    if (net.mode === 'down') return Promise.reject(new TypeError('Failed to fetch'));
    if (net.mode === 'hang' && url.includes('/json/radar.py')) {
      return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))));
    }
    const now = Date.now();
    let body;
    if (url.includes('/json/radar.py')) {
      const newest = Math.floor((now - 2 * MIN) / (5 * MIN)) * 5 * MIN;
      body = { scans: Array.from({ length: 12 }, (_, i) => ({ ts: new Date(newest - (11 - i) * 5 * MIN).toISOString().slice(0, 16) + 'Z' })) };
    } else if (url.includes('/mrms/lcref.json')) body = { meta: { start_valid: iso(Math.floor((now - 2 * MIN) / 120000) * 120000) } };
    else if (url.includes('/hrrr/refd_0000.json')) body = { model_init_utc: iso(Math.floor(now / 3600000) * 3600000 - 3600000) };
    else if (url.includes('/USCOMP/n0q_0.json')) body = { meta: { valid: iso(Math.floor(now / MIN) * MIN - 5 * MIN) } };
    else if (url.includes('NEXRAD.geojson')) body = { features: [{ id: 'TLX', properties: { sid: 'TLX' }, geometry: { type: 'Point', coordinates: [-97.2778, 35.3331] } }] };
    else body = { type: 'FeatureCollection', features: [] };
    const reply = { ok: true, status: 200, json: async () => body };
    if (net.slowMs && url.includes('/json/radar.py')) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(reply), net.slowMs);
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          net.aborts++;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }
    return Promise.resolve(reply);
  };
  const scanLists = () => net.urls.filter((u) => u.includes('/json/radar.py')).length;
  return { win, doc, reloads, live, net, store, scanLists, listeners: () => win.count + doc.count };
}

const mapStub = () => ({ getPane: () => ({ style: { setProperty() {} } }), remove() {} });

function makeCard(e, config = {}, { bootFailures = 0 } = {}) {
  const card = Object.create(WallRadarCard.prototype);
  Object.assign(card, { _frames: [], _pending: new Map(), _queue: [], _active: 0, _index: 0, _mode: null, _backoff: 0, _built: false, dataset: {}, isConnected: false });
  card.shadowRoot = { innerHTML: '', getElementById: () => null };
  card.calls = { teardown: 0, start: 0 };
  // _start without Leaflet: the real one awaits loadLeaflet, renders, then resumes. `bootFailures` stands in for
  // leaflet.js failing to load (the real _start then leaves no map and resets _built).
  card._start = function () {
    this.calls.start++;
    if (this._built) return this._resume();
    this._gen = (this._gen || 0) + 1;
    if (bootFailures > 0) {
      bootFailures--;
      return;
    }
    this._built = true;
    this._map = mapStub();
    this._resume();
  };
  const teardown = WallRadarCard.prototype._teardown;
  card._teardown = function () {
    this.calls.teardown++;
    return teardown.call(this);
  };
  // _preload without Leaflet: every tile of the frame loads at once, with the echo count the network is serving.
  card._preload = function (scan) {
    scan.tiles = new Map([['0/0', { echoes: e.net.echoes, home: -10 }]]);
    const layer = { options: { scan }, setOpacity() {}, remove() {} };
    this._addFrame({ key: scan.key, time: scan.time, forecast: !!scan.forecast, layer });
    this._settle();
  };
  // A neutral centre and its nearest site (Oklahoma City, TLX).
  card.setConfig({ center_latitude: 35.47, center_longitude: -97.52, site: 'TLX', warnings: false, frame_count: 10, ...config });
  return card;
}

const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};
async function advance(ms, step = 5000) {
  for (let done = 0; done < ms; done += step) {
    mock.timers.tick(Math.min(step, ms - done));
    await flush();
  }
}
async function connect(card) {
  card.isConnected = true;
  card.connectedCallback();
  await flush();
}
function disconnect(card) {
  card.isConnected = false;
  card.disconnectedCallback();
}
// A poll that never finishes, in an await no fetch timeout covers (one-shot unless `always`).
function stall(card, method, always = false) {
  const orig = card[method];
  card[method] = function () {
    if (!always) card[method] = orig;
    return new Promise(() => {});
  };
}
const stallForecast = (card, always) => stall(card, '_pollForecast', always);
const newestObserved = (card) => card._frames.filter((f) => !f.forecast).at(-1)?.time;
const action = (card) => String(card.dataset.watchdog || '').split(' ')[0];

// ---- config ---------------------------------------------------------------------------------------

test('config: watchdog defaults, numbers validated, and Horizon passes radar: keys straight through', () => {
  const c = configure({});
  assert.equal(c.watchdog, true);
  assert.equal(c.watchdog_restart_min, 20);
  assert.equal(c.watchdog_reload_min, 45);
  assert.throws(() => configure({ watchdog_reload_min: 'soon' }), /watchdog_reload_min must be a number/);
  assert.throws(() => configure({ watchdog_restart_min: 'soon' }), /watchdog_restart_min must be a number/);
  const h = configure(radarConfig({ watchdog: false, watchdog_restart_min: 10, watchdog_reload_min: 0 }));
  assert.deepEqual([h.watchdog, h.watchdog_restart_min, h.watchdog_reload_min], [false, 10, 0]);
});

// ---- A1 / A2: the poll chain survives a throw and a request that never answers --------------------------
// watchdog: false in both, so the watchdog cannot be what keeps polling alive.

test('A1 a throw after the poll try does not end polling', async (t) => {
  const e = env(t);
  const card = makeCard(e, { watchdog: false });
  await connect(card);
  await advance(2 * MIN + 1000);
  assert.equal(e.scanLists(), 2, 'polling every 2 min before the fault');
  const orig = card._syncForecast;
  let thrown = 0;
  card._syncForecast = function () {
    card._syncForecast = orig;
    thrown++;
    throw new Error('INJECTED one-shot throw in _syncForecast');
  };
  await advance(2 * MIN);
  assert.equal(thrown, 1, 'the throw happened');
  const at = e.scanLists();
  await advance(6 * MIN + 1000);
  assert.ok(e.scanLists() >= at + 3, `still polling every 2 min (${e.scanLists() - at} since the throw)`);
});

test('A2 a scan list that never answers is abandoned after 30 s and polling continues', async (t) => {
  const e = env(t);
  const card = makeCard(e, { watchdog: false });
  await connect(card);
  const first = newestObserved(card);
  e.net.mode = 'hang';
  await advance(2 * MIN + 1000);
  const hung = e.scanLists();
  await advance(3 * MIN);
  assert.ok(e.scanLists() > hung, 'the next poll came after the usual 2-min retry');
  assert.ok(card._backoff > 0, 'the hang counted as a failed poll');
  e.net.mode = 'ok';
  await advance(10 * MIN);
  assert.ok(newestObserved(card) > first, 'fresh frames once the scan list answers');
});

// ---- round 2 -----------------------------------------------------------------------------------------

for (const where of ['_pollForecast', '_syncForecast', '_updateChip']) {
  test(`R2-D a throw from ${where} in the tail of _poll does not stop rescheduling`, async (t) => {
    const e = env(t);
    const card = makeCard(e, { watchdog: false });
    await connect(card);
    await advance(2 * MIN + 1000);
    let thrown = 0;
    const boom = () => {
      thrown++;
      throw new Error(`INJECTED one-shot throw in ${where}`);
    };
    const pollForecast = card._pollForecast;
    if (where === '_pollForecast') {
      card._pollForecast = async function () {
        card._pollForecast = pollForecast;
        boom();
      };
    } else if (where === '_syncForecast') {
      const orig = card._syncForecast;
      card._syncForecast = function () {
        card._syncForecast = orig;
        boom();
      };
    } else {
      // _updateChip also runs inside _sync (the poll's try); arm it only once the tail's _pollForecast has finished.
      card._pollForecast = async function (gen) {
        card._pollForecast = pollForecast;
        await pollForecast.call(this, gen);
        const orig = card._updateChip;
        card._updateChip = function () {
          card._updateChip = orig;
          boom();
        };
      };
    }
    await advance(2 * MIN);
    assert.equal(thrown, 1, 'the throw happened, in the tail');
    const at = e.scanLists();
    await advance(6 * MIN + 1000);
    assert.ok(e.scanLists() >= at + 3, `still polling every 2 min (${e.scanLists() - at} since the throw)`);
  });
}

test('R2-B a slow scan list that answers within 30 s is not aborted; one past 30 s is, and is retried', async (t) => {
  const e = env(t);
  const card = makeCard(e, { watchdog: false });
  await connect(card);
  await advance(2 * MIN + 1000);
  e.net.slowMs = 20000;
  await advance(2 * MIN + 30000); // the poll at ~4:00 answers at ~4:20
  assert.equal(e.net.aborts, 0, 'CONTROL: a 20-s answer is not aborted');
  assert.equal(card._backoff, 0);
  assert.ok(Date.now() - card._pollOkAt < MIN, 'that poll succeeded');
  const n = e.scanLists();
  e.net.slowMs = 35000;
  await advance(2 * MIN + 30000); // the poll at ~6:20 is aborted at ~6:50
  assert.equal(e.net.aborts, 1, 'a 35-s answer is aborted at 30 s');
  assert.ok(card._backoff > 0, 'and counted as a failed poll');
  e.net.slowMs = 0;
  await advance(3 * MIN);
  assert.ok(e.scanLists() >= n + 2, 'retried on the normal schedule');
  assert.equal(card._backoff, 0, 'and recovered');
});

test('R2-C a map that never builds: a rebuild about every 6-7 min, not every tick, then one guarded reload', async (t) => {
  const e = env(t);
  const card = makeCard(e, {}, { bootFailures: Infinity });
  await connect(card);
  await advance(47 * MIN, 10000);
  assert.ok(!card._map, 'never built');
  assert.ok(card.calls.start >= 4 && card.calls.start <= 10, `rebuild attempts: ${card.calls.start} in 47 min`);
  assert.equal(e.reloads.length, 1, 'then the guarded reload');
});

// The context redraw through the Node seam: the card's own _contextRestored and _wake, counted at _refade. What
// Node cannot reach is the wiring: Leaflet's createTile adds the contextlost/contextrestored listeners to each tile
// canvas (a headless-Chrome check covers that, not in this repo).
test('R2-A context redraw: a restore burst redraws once; a lost context redraws on visible, an intact one does not', async (t) => {
  const e = env(t);
  const card = makeCard(e);
  await connect(card);
  card._baseLayers = []; // the map stand-in has no base layers
  let redraws = 0;
  card._refade = () => redraws++;
  for (let i = 0; i < 5; i++) card._contextRestored(); // every canvas fires its own event
  await advance(1000, 250);
  assert.equal(redraws, 1, 'one redraw per burst');
  await advance(10000);
  e.doc.dispatch('visibilitychange');
  await advance(1000, 250);
  assert.equal(redraws, 1, 'CONTROL: visible with no lost context does not redraw');
  card._contextLost = true; // what a tile canvas's contextlost listener sets
  await advance(10000);
  e.doc.dispatch('visibilitychange');
  await advance(1000, 250);
  assert.equal(redraws, 2, 'a lost context is redrawn when the page becomes visible');
  assert.equal(card._contextLost, false, 'and the mark is cleared');
});

// ---- B2: a dead poll chain is restarted -------------------------------------------------------------

async function stalledChain(t, config) {
  const e = env(t);
  const card = makeCard(e, config);
  await connect(card);
  await advance(2 * MIN + 1000);
  assert.equal(e.scanLists(), 2, 'polling every 2 min before the fault');
  stallForecast(card);
  await advance(2 * MIN);
  return { e, card, dead: e.scanLists() };
}

test('B2 CONTROL: without the watchdog a poll that never finishes ends polling for good', async (t) => {
  const { e, dead } = await stalledChain(t, { watchdog: false });
  await advance(60 * MIN, 30000);
  assert.equal(e.scanLists(), dead);
});

test('B2 a poll that never finishes: the watchdog restarts the chain within ~7 min (round trip)', async (t) => {
  const { e, card, dead } = await stalledChain(t, {});
  await advance(3 * MIN);
  assert.equal(e.scanLists(), dead, 'no restart while the chain is merely late');
  await advance(5 * MIN);
  assert.ok(e.scanLists() > dead, `restarted (${e.scanLists()} > ${dead})`);
  assert.equal(action(card), 'restart');
  const after = e.scanLists();
  await advance(4 * MIN + 1000);
  assert.ok(e.scanLists() >= after + 2, 'the restarted chain keeps polling every 2 min');
  assert.equal(card.calls.teardown, 0, 'a restart, not a re-init');
});

test('A5 no map after a failed boot (leaflet.js did not load): the watchdog rebuilds within ~7 min', async (t) => {
  const e = env(t);
  const card = makeCard(e, { watchdog_restart_min: 0, watchdog_reload_min: 0 }, { bootFailures: 1 });
  await connect(card);
  assert.equal(card._map, undefined, 'the first boot failed');
  assert.equal(e.scanLists(), 0);
  await advance(8 * MIN);
  assert.ok(card._map, 'rebuilt');
  assert.ok(e.scanLists() >= 1, 'polling');
  assert.ok(newestObserved(card), 'frames');
});

test('B2 a live backoff (up to 30 min between polls) is not mistaken for a dead chain', async (t) => {
  const e = env(t);
  const card = makeCard(e, { watchdog_restart_min: 0, watchdog_reload_min: 0 });
  await connect(card);
  e.net.mode = 'down';
  await advance(90 * MIN, 10000);
  assert.equal(card._backoff, 30 * MIN, 'backed off to the cap');
  assert.equal(card.dataset.watchdog, undefined, 'no restart');
  assert.ok(e.scanLists() <= 9, `the backoff schedule held (${e.scanLists()} scan-list requests in 90 min)`);
});

// ---- B7: visibility, pageshow, online -------------------------------------------------------------

test('B7 hidden does nothing; hidden -> visible polls at once, and so does pageshow', async (t) => {
  const e = env(t);
  const card = makeCard(e);
  await connect(card);
  await advance(30000);
  assert.equal(e.scanLists(), 1);
  e.doc.visibilityState = 'hidden';
  e.doc.dispatch('visibilitychange');
  await flush();
  assert.equal(e.scanLists(), 1, 'hidden: no poll');
  await advance(10000);
  e.doc.visibilityState = 'visible';
  e.doc.dispatch('visibilitychange');
  await flush();
  assert.equal(e.scanLists(), 2, 'visible: polled without waiting for the timer');
  assert.equal(action(card), 'visible');
  e.win.dispatch('pageshow');
  await flush();
  assert.equal(e.scanLists(), 2, 'debounced: a poll started under 5 s ago');
  await advance(10000);
  e.win.dispatch('pageshow');
  await flush();
  assert.equal(e.scanLists(), 3, 'pageshow polls at once');
  assert.equal(action(card), 'pageshow');
});

test('B7 offline -> online recovers frames at once instead of waiting out the backoff (round trip)', async (t) => {
  const e = env(t);
  const card = makeCard(e, { watchdog_restart_min: 0, watchdog_reload_min: 0 });
  await connect(card);
  await advance(2 * MIN + 1000);
  const before = newestObserved(card);
  e.net.mode = 'down';
  await advance(16 * MIN + 30000); // failed polls at ~4, 6, 10, 18 min: the next one is 16 min away
  assert.ok(card._backoff >= 16 * MIN, `backing off (${card._backoff / MIN} min)`);
  const n = e.scanLists();
  e.net.mode = 'ok';
  await advance(60000);
  assert.equal(e.scanLists(), n, 'CONTROL: the network is back but nothing polls until the backoff timer');
  e.win.dispatch('online');
  await flush();
  assert.equal(e.scanLists(), n + 1, 'online polls at once');
  assert.ok(newestObserved(card) > before, 'new scans joined the loop');
  assert.equal(card._backoff, 0);
  assert.equal(action(card), 'online');
});

// ---- B5: the dry-sky control ----------------------------------------------------------------------

test('B5 CONTROL: a dry sky (every poll succeeds, zero echoes) for 3 h never triggers the watchdog', async (t) => {
  const e = env(t);
  e.net.echoes = 0;
  const card = makeCard(e);
  await connect(card);
  await advance(3 * 60 * MIN, 10000);
  assert.ok(e.scanLists() >= 85, `polled all along (${e.scanLists()})`);
  assert.equal(card.dataset.echoes, '0', 'the sky really is dry');
  assert.equal(card.dataset.watchdog, undefined);
  assert.equal(card.calls.teardown, 0);
  assert.equal(e.reloads.length, 0);
  assert.equal(card.dataset.status, '');
});

// ---- B4: soft re-init ----------------------------------------------------------------------------

test('B4 no successful poll for watchdog_restart_min -> soft re-init, exactly once per window', async (t) => {
  const e = env(t);
  const card = makeCard(e, { watchdog_reload_min: 0 });
  await connect(card);
  e.net.mode = 'down';
  await advance(19 * MIN);
  assert.equal(card.calls.teardown, 0, 'not before 20 min');
  await advance(11 * MIN);
  assert.equal(card.calls.teardown, 1, 'once by 30 min');
  assert.equal(action(card), 'reinit');
  assert.ok(card._map, 'rebuilt');
  await advance(20 * MIN);
  assert.equal(card.calls.teardown, 2, 'twice by 50 min');
  e.net.mode = 'ok';
  e.win.dispatch('online'); // without it the next poll waits out the backoff, and a third window can pass first
  await advance(40 * MIN);
  assert.equal(card.calls.teardown, 2, 'none once polls succeed');
  assert.ok(Date.now() - newestObserved(card) < 10 * MIN, 'fresh frames');
});

// ---- B6: the guarded reload ----------------------------------------------------------------------

test('B6 no successful poll for watchdog_reload_min -> one reload, then none within 2 h', async (t) => {
  const e = env(t);
  const card = makeCard(e, { watchdog_restart_min: 0 }); // re-inits would interleave with the reload attempts
  await connect(card);
  e.net.mode = 'down';
  await advance(44 * MIN);
  assert.equal(e.reloads.length, 0);
  await advance(3 * MIN);
  assert.equal(e.reloads.length, 1, 'reloaded after 45 min');
  assert.equal(e.store.get(RELOAD_KEY), String(e.reloads[0]), 'the reload time is stored first');
  await advance(100 * MIN, 10000); // location.reload is a stub here, so the page keeps running and keeps failing
  assert.equal(e.reloads.length, 1, 'blocked within 2 h');
  assert.equal(action(card), 'reload-blocked');
});

test('B6 a new page within 2 h of a reload does not reload again', async (t) => {
  const store = new Map([[RELOAD_KEY, String(T0 - 60 * MIN)]]);
  const e = env(t, { store });
  const card = makeCard(e);
  await connect(card);
  e.net.mode = 'down';
  await advance(55 * MIN);
  assert.equal(e.reloads.length, 0);
  assert.equal(action(card), 'reload-blocked');
});

test('B6 storage that throws: no reload, no crash, the watchdog keeps working', async (t) => {
  const e = env(t, { storage: 'throws' });
  const card = makeCard(e);
  await connect(card);
  e.net.mode = 'down';
  await advance(60 * MIN);
  assert.equal(e.reloads.length, 0);
  assert.equal(action(card), 'reload-blocked');
  assert.ok(card.calls.teardown >= 2, 're-inits still happen');
  e.net.mode = 'ok';
  await advance(25 * MIN);
  assert.ok(Date.now() - newestObserved(card) < 10 * MIN, 'recovers');
});

test('B6 watchdog_reload_min 0 never reloads (3 h down)', async (t) => {
  const e = env(t);
  const card = makeCard(e, { watchdog_reload_min: 0 });
  await connect(card);
  e.net.mode = 'down';
  await advance(3 * 60 * MIN, 10000);
  assert.equal(e.reloads.length, 0);
  assert.equal(e.store.has(RELOAD_KEY), false);
});

// ---- B10: time the watchdog did not see ------------------------------------------------------------

test('B10 8 h of frozen timers (tablet asleep), network not back yet: a wake poll, no re-init, no reload', async (t) => {
  const e = env(t);
  const card = makeCard(e);
  await connect(card);
  await advance(3 * MIN);
  e.net.mode = 'down';
  const n = e.scanLists();
  mock.timers.setTime(Date.now() + 8 * 60 * MIN); // the clock moves, no timer fires
  await advance(2 * MIN);
  assert.ok(e.scanLists() > n, 'polled on wake');
  assert.equal(action(card), 'wake');
  assert.equal(card.calls.teardown, 0);
  assert.equal(e.reloads.length, 0);
  e.net.mode = 'ok';
  await advance(3 * MIN);
  assert.ok(Date.now() - newestObserved(card) < 10 * MIN, 'recovers');
});

// ---- B8 / B9: lifecycle and the off switch ---------------------------------------------------------

test('B8 connect/disconnect x5 leaves no intervals or listeners, and nothing polls after', async (t) => {
  const e = env(t);
  const card = makeCard(e);
  for (let i = 0; i < 5; i++) {
    await connect(card);
    assert.equal(e.listeners(), 3, `connected #${i + 1}: visibilitychange, pageshow, online`);
    assert.equal(e.live.size, 1, `connected #${i + 1}: one watchdog interval`);
    await advance(30000);
    disconnect(card);
    assert.equal(e.listeners(), 0, `disconnected #${i + 1}`);
    assert.equal(e.live.size, 0, `disconnected #${i + 1}`);
  }
  const n = e.scanLists();
  await advance(60 * MIN, 30000);
  assert.equal(e.scanLists(), n);
  assert.equal(e.reloads.length, 0);
});

test('B9 watchdog: false is inert: no listeners, no interval, a stalled chain stays stalled for 3 h', async (t) => {
  const e = env(t);
  const card = makeCard(e, { watchdog: false });
  await connect(card);
  assert.equal(e.listeners(), 0);
  assert.equal(e.live.size, 0);
  stallForecast(card, true);
  await advance(2 * MIN + 1000);
  const hung = e.scanLists();
  e.doc.dispatch('visibilitychange');
  e.win.dispatch('online');
  await advance(3 * 60 * MIN, 30000);
  assert.equal(e.scanLists(), hung);
  assert.equal(card.dataset.watchdog, undefined);
  assert.equal(card.calls.teardown, 0);
  assert.equal(e.reloads.length, 0);
});

// ---- B11: data-status ----------------------------------------------------------------------------

test('B11 data-status stays current while no poll finishes', async (t) => {
  const e = env(t);
  const card = makeCard(e, { watchdog_restart_min: 0, watchdog_reload_min: 0 });
  await connect(card);
  stall(card, '_fetchScans', true); // every poll, restarted ones included, never gets its scan list
  await advance(30 * MIN);
  assert.match(card.dataset.status, /min old/);
});

test('B11 frames older than 60 min with polls failing read "polls failing"; 50 min does not', async (t) => {
  const e = env(t);
  const card = makeCard(e, { watchdog_restart_min: 0, watchdog_reload_min: 0 });
  await connect(card);
  e.net.mode = 'down';
  await advance(50 * MIN);
  assert.match(card.dataset.status, /min old$/);
  await advance(20 * MIN);
  assert.match(card.dataset.status, /min old · polls failing$/);
  e.net.mode = 'ok';
  e.win.dispatch('online');
  await flush();
  assert.equal(card.dataset.status, '');
});
