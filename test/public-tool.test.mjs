// tools/lovelace-ws.mjs against test/tool-stub-ws.mjs, a global WebSocket stand-in:
// nothing here can reach a network. PUBLIC_TOOL=<path> runs the same tests against another copy (for example a
// packaged copy). Run: node --test test/public-tool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SCRIPT = process.env.PUBLIC_TOOL || path.join(HERE, '../tools/lovelace-ws.mjs');
const STUB = path.join(HERE, 'tool-stub-ws.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-dash-tool-'));
const TOKEN = 'stub-token-7f3a9c';

const EXISTING = [
  { title: 'Home', path: 'home', cards: [{ type: 'entities', entities: ['light.lamp'] }] },
  { title: 'Media', cards: [{ type: 'vertical-stack', cards: [{ type: 'markdown', content: 'hi' }] }] },
];
const VIEW = { title: 'Radar', path: 'radar', type: 'panel', cards: [{ type: 'custom:wall-radar-card', height: '100vh' }] };
const file = (name, value) => {
  const p = path.join(tmp, `${name}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(value));
  return p;
};

function run(args, { state = {}, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'run-'));
  const log = path.join(dir, 'stub.log');
  fs.writeFileSync(log, '');
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ dashboards: { default: null, 'wall-tablet': { title: 'Wall', views: EXISTING } }, list: [{ url_path: 'wall-tablet', title: 'Wall', mode: 'storage' }], resources: [], ...state }));
  const base = { PATH: process.env.PATH, HA_URL: 'http://ha.invalid:8123', HA_TOKEN: TOKEN, STUB_LOG: log, STUB_STATE: stateFile, RADAR_DASH_TIMEOUT_MS: '600' };
  const full = { ...base, ...env };
  for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
  const r = spawnSync(process.execPath, ['--import', STUB, SCRIPT, ...args], { encoding: 'utf8', cwd: dir, env: full, timeout: 20000 });
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    code: r.status,
    out: r.stdout + r.stderr,
    dir,
    lines,
    constructs: lines.filter((l) => l.startsWith('construct')),
    sends: lines.filter((l) => l.startsWith('send ')).map((l) => l.slice(5)),
    saves: lines.filter((l) => l.startsWith('saved ')).map((l) => JSON.parse(l.slice(l.indexOf('{')))),
    fetches: lines.filter((l) => l.startsWith('fetch ')).map((l) => l.slice(6)),
    work: () => (fs.existsSync(path.join(dir, 'radar-dash-work')) ? fs.readdirSync(path.join(dir, 'radar-dash-work')).sort() : []),
  };
}

const viewFile = () => file('view', VIEW);
const WRITES = {
  'add-resource': ['add-resource', '/hacsfiles/radar-dash/wall-radar-card.js'],
  'create-dashboard': ['create-dashboard', 'new-wall', 'New wall'],
  'add-view': ['add-view', 'wall-tablet', viewFile(), file('backup', {})],
  'remove-view': ['remove-view', 'wall-tablet', viewFile(), file('backup', {})],
  'remove-resource': ['remove-resource', '/hacsfiles/radar-dash/wall-radar-card.js'],
  restore: ['restore', 'wall-tablet', file('backup', {})],
};

for (const [mode, args] of Object.entries(WRITES)) {
  test(`${mode} without --confirm-write: exit 2, no connection at all`, () => {
    const r = run(args);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /REFUSED/);
    assert.equal(r.constructs.length, 0, 'no WebSocket constructed');
    assert.deepEqual(r.sends, []);
  });
}

test('no HA_URL or no HA_TOKEN: exit 2, no connection, and there is no default host', () => {
  for (const env of [{ HA_URL: undefined }, { HA_TOKEN: undefined }, { HA_URL: 'not a url' }]) {
    const r = run(['inspect'], { env });
    assert.equal(r.code, 2, r.out);
    assert.equal(r.constructs.length, 0);
  }
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.equal(/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(src), false, 'no IP address in the tool');
});

test('the URL comes from HA_URL; https becomes wss', () => {
  assert.deepEqual(run(['inspect']).constructs, ['construct ws://ha.invalid:8123/api/websocket']);
  assert.deepEqual(run(['inspect'], { env: { HA_URL: 'https://ha.invalid/' } }).constructs, ['construct wss://ha.invalid/api/websocket']);
});

test('the token is sent only in the auth message and never printed or written', () => {
  const backup = path.join(tmp, 'token-backup.json');
  const runs = [run(['inspect']), run(['entities']), run(['backup', 'wall-tablet', backup]), run(['add-view', 'wall-tablet', viewFile(), file('backup', {})]), run(['verify', 'wall-tablet'])];
  for (const r of runs) {
    assert.equal(r.out.includes(TOKEN), false, 'not in stdout or stderr');
    for (const f of fs.readdirSync(r.dir)) if (f !== 'stub.log') assert.equal(fs.readFileSync(path.join(r.dir, f), 'utf8').includes(TOKEN), false, `not in ${f}`);
  }
  assert.ok(runs[0].lines.includes('auth token-from-env'));
  assert.equal(fs.readFileSync(backup, 'utf8').includes(TOKEN), false);
});

test('inspect is read-only, finds cards by type and does not print the coordinates', () => {
  const state = { dashboards: { default: null, 'wall-tablet': { views: [...EXISTING, { cards: [{ type: 'vertical-stack', cards: [{ type: 'custom:wall-radar-card' }] }] }] } } };
  const r = run(['inspect'], { state });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.saves.length, 0);
  const out = JSON.parse(r.out);
  assert.equal(out.location_set, true);
  assert.equal(/41\.6|93\.6/.test(r.out), false);
  const wall = out.dashboards.find((d) => d.dashboard === 'wall-tablet');
  assert.deepEqual(wall.cards['custom:wall-radar-card'], [{ view: 2, at: 'views.2.cards.0.cards.0' }]);
  assert.match(out.dashboards.find((d) => d.dashboard === 'default').note, /auto-generated/);
});

test('entities lists only the domains the cards use', () => {
  const r = run(['entities']);
  assert.match(r.out, /weather\.forecast_home/);
  assert.match(r.out, /sensor\.porch_temperature\t\ttemperature\t°F/);
  assert.equal(/light\.lamp/.test(r.out), false);
});

test('add-view: needs a backup equal to the live dashboard, appends one view, leaves the others, reads back', () => {
  const view = viewFile();
  const backup = path.join(tmp, 'b1.json');
  // backup, then add-view, in separate processes: each stub starts from the same seeded state.
  assert.equal(run(['backup', 'wall-tablet', backup]).code, 0);
  const r = run(['add-view', 'wall-tablet', view, backup, '--confirm-write']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.saves.length, 1);
  assert.deepEqual(r.saves[0].views.slice(0, 2), EXISTING, 'existing views byte-for-byte');
  assert.deepEqual(r.saves[0].views[2], VIEW);
  assert.equal(r.saves[0].title, 'Wall', 'the rest of the dashboard is kept');
  assert.match(r.out, /2 existing view\(s\) unchanged \(read back\)/);
  assert.ok(r.sends.indexOf('lovelace/config/save') < r.sends.lastIndexOf('lovelace/config'), 'a read follows the save');
});

test('add-view refuses: no backup, a stale backup, another dashboard\'s backup, a clash, a whole dashboard as the view', () => {
  const view = viewFile();
  const good = path.join(tmp, 'b2.json');
  run(['backup', 'wall-tablet', good]);
  const cases = {
    'no backup': run(['add-view', 'wall-tablet', view, '--confirm-write']),
    stale: run(['add-view', 'wall-tablet', view, good, '--confirm-write'], { state: { dashboards: { default: null, 'wall-tablet': { title: 'Wall', views: [...EXISTING, { title: 'New since' }] } } } }),
    'other dashboard': run(['add-view', 'wall-tablet', view, file('backup', { dashboard: 'other-one', config: { title: 'Wall', views: EXISTING } }), '--confirm-write']),
    'path clash': run(['add-view', 'wall-tablet', file('view', { ...VIEW, path: 'home' }), good, '--confirm-write']),
    'whole dashboard': run(['add-view', 'wall-tablet', file('view', { views: [VIEW] }), good, '--confirm-write']),
    'no card': run(['add-view', 'wall-tablet', file('view', { title: 'x', cards: [{ type: 'markdown' }] }), good, '--confirm-write']),
  };
  for (const [name, r] of Object.entries(cases)) {
    assert.equal(r.code, 1, `${name}: ${r.out}`);
    assert.equal(r.saves.length, 0, `${name}: nothing saved`);
  }
  assert.match(cases.stale.out, /changed since the backup/);
});

test('add-view never saves to the auto-generated default dashboard', () => {
  const backup = path.join(tmp, 'b3.json');
  assert.equal(run(['backup', 'default', backup]).code, 0);
  const r = run(['add-view', 'default', viewFile(), backup, '--confirm-write']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /auto-generated/);
  assert.equal(r.saves.length, 0);
  assert.match(run(['plan-view', 'default', viewFile()]).out, /would REFUSE/);
});

test('add-view fills a new, empty dashboard, and a readback mismatch fails loudly', () => {
  const state = { dashboards: { default: null, 'new-wall': null }, list: [{ url_path: 'new-wall', title: 'New', mode: 'storage' }] };
  const backup = path.join(tmp, 'b4.json');
  run(['backup', 'new-wall', backup], { state });
  const ok = run(['add-view', 'new-wall', viewFile(), backup, '--confirm-write'], { state });
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(ok.saves[0], { views: [VIEW] });
  const bad = run(['add-view', 'new-wall', viewFile(), backup, '--confirm-write'], { state, env: { STUB_DROP_SAVE: '1' } });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /READBACK MISMATCH/);
});

test('remove-view removes only the exact view; restore puts a backup back', () => {
  const state = { dashboards: { default: null, 'wall-tablet': { title: 'Wall', views: [EXISTING[0], VIEW, EXISTING[1]] } } };
  const live = file('backup', { dashboard: 'wall-tablet', config: state.dashboards['wall-tablet'] });
  const r = run(['remove-view', 'wall-tablet', viewFile(), live, '--confirm-write'], { state });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.saves[0].views, EXISTING);
  const edited = run(['remove-view', 'wall-tablet', file('view', { ...VIEW, title: 'Edited' }), live, '--confirm-write'], { state });
  assert.equal(edited.code, 1);
  assert.equal(edited.saves.length, 0);
  const backup = file('backup', { dashboard: 'wall-tablet', config: { title: 'Wall', views: EXISTING } });
  const back = run(['restore', 'wall-tablet', backup, '--confirm-write'], { state });
  assert.equal(back.code, 0, back.out);
  assert.deepEqual(back.saves[0].views, EXISTING);
});

test('add-resource takes only this project\'s two files and never registers one twice', () => {
  const ok = run(['add-resource', '/local/radar-dash/wall-horizon-card.js?v=1', '--confirm-write']);
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(ok.sends, ['lovelace/resources', 'lovelace/resources/create']);
  assert.equal(run(['add-resource', '/local/other/card.js', '--confirm-write']).code, 1);
  const dup = run(['add-resource', '/local/radar-dash/wall-radar-card.js', '--confirm-write'], { state: { resources: [{ id: 'h', url: '/hacsfiles/radar-dash/wall-radar-card.js?hacstag=1', type: 'module' }] } });
  assert.equal(dup.code, 1);
  assert.match(dup.out, /registered already/);
});

test('verify needs the resource and a card; create-dashboard refuses an existing path', () => {
  const withCard = { dashboards: { default: null, 'wall-tablet': { views: [VIEW] } } };
  assert.equal(run(['verify', 'wall-tablet'], { state: withCard }).code, 1, 'no resource');
  const served = { '/hacsfiles/radar-dash/wall-radar-card.js': "customElements.define('wall-radar-card', X)", '/hacsfiles/radar-dash/leaflet.js': 'L', '/hacsfiles/radar-dash/leaflet.css': 'c' };
  assert.equal(run(['verify', 'wall-tablet'], { state: { ...withCard, served, resources: [{ id: 'h', url: '/hacsfiles/radar-dash/wall-radar-card.js?hacstag=1' }] } }).code, 0);
  assert.equal(run(['verify', 'wall-tablet'], { state: { resources: [{ id: 'h', url: '/hacsfiles/radar-dash/wall-radar-card.js' }] } }).code, 1, 'no card');
  assert.equal(run(['create-dashboard', 'wall-tablet', 'Again', '--confirm-write']).code, 1);
  const made = run(['create-dashboard', 'new-wall', 'New wall', '--confirm-write']);
  assert.equal(made.code, 0, made.out);
  assert.equal(made.saves.length, 0, 'creating a dashboard saves no config');
});

// ---- fix round 1 (review + agent dry run) ---------------------------------------------------------------------

const liveBackup = (views = EXISTING) => file('backup', { dashboard: 'wall-tablet', config: { title: 'Wall', views } });
const CARD_JS = "customElements.define('wall-radar-card', WallRadarCard);";
const HZ_JS = "customElements.define('wall-horizon-card', WallHorizonCard);";
const servedAt = (ns, horizon) => ({
  [`${ns}wall-radar-card.js`]: CARD_JS, [`${ns}leaflet.js`]: 'L', [`${ns}leaflet.css`]: 'css',
  ...(horizon ? { [`${ns}wall-horizon-card.js`]: HZ_JS, [`${ns}wall-horizon-lib.js`]: 'lib', [`${ns}fonts/fredoka-latin-wght-normal.woff2`]: 'f', [`${ns}fonts/figtree-latin-wght-normal.woff2`]: 'f' } : {}),
});

test('F1 remove-resource refuses a resource that is not one of this project\'s card files', () => {
  const resources = [{ id: 'x', url: '/hacsfiles/mini-graph-card/mini-graph-card-bundle.js?hacstag=1', type: 'module' }, { id: 'o', url: '/local/radar-dash/wall-radar-card.js', type: 'module' }];
  const other = run(['remove-resource', '/hacsfiles/mini-graph-card/mini-graph-card-bundle.js?hacstag=1', '--confirm-write'], { state: { resources } });
  assert.equal(other.code, 1, other.out);
  assert.equal(other.sends.includes('lovelace/resources/delete'), false, 'nothing deleted');
  const ours = run(['remove-resource', '/local/radar-dash/wall-radar-card.js', '--confirm-write'], { state: { resources } });
  assert.equal(ours.code, 0, ours.out);
  assert.ok(ours.sends.includes('lovelace/resources/delete'));
});

test('F2 remove-view removes only a view holding one of the cards, and only with a backup equal to the live dashboard', () => {
  const plain = { title: 'Media', cards: [{ type: 'vertical-stack', cards: [{ type: 'markdown', content: 'hi' }] }] };
  const notOurs = run(['remove-view', 'wall-tablet', file('view', plain), liveBackup(), '--confirm-write']);
  assert.equal(notOurs.code, 1, notOurs.out);
  assert.equal(notOurs.saves.length, 0, 'a view without our cards is never removed');
  assert.match(notOurs.out, /neither/);
  const views = [EXISTING[0], VIEW, EXISTING[1]];
  const state = { dashboards: { default: null, 'wall-tablet': { title: 'Wall', views } } };
  const noBackup = run(['remove-view', 'wall-tablet', viewFile(), '--confirm-write'], { state });
  assert.equal(noBackup.code, 1, noBackup.out);
  assert.equal(noBackup.saves.length, 0);
  const stale = run(['remove-view', 'wall-tablet', viewFile(), liveBackup(), '--confirm-write'], { state });
  assert.equal(stale.code, 1, stale.out);
  assert.equal(stale.saves.length, 0, 'a backup that is not the live dashboard is refused');
  const ok = run(['remove-view', 'wall-tablet', viewFile(), liveBackup(views), '--confirm-write'], { state });
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual(ok.saves[0].views, EXISTING);
});

test('F3 backup never overwrites; its default name is timestamped in ./radar-dash-work/', () => {
  const existing = file('backup', { keep: 'me' });
  const r = run(['backup', 'wall-tablet', existing]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /exists/);
  assert.deepEqual(JSON.parse(fs.readFileSync(existing, 'utf8')), { keep: 'me' }, 'the old file is untouched');
  const d = run(['backup', 'wall-tablet']);
  assert.equal(d.code, 0, d.out);
  assert.equal(d.work().length, 1);
  assert.match(d.work()[0], /^backup-wall-tablet-\d{8}T\d{6}Z\.json$/);
  assert.match(d.out, /radar-dash-work\/backup-wall-tablet-/);
  const saved = JSON.parse(fs.readFileSync(path.join(d.dir, 'radar-dash-work', d.work()[0]), 'utf8'));
  assert.deepEqual(saved.config.views, EXISTING);
});

test('F3 restore snapshots the dashboard as it is BEFORE writing', () => {
  const now = [EXISTING[0], VIEW];
  const state = { dashboards: { default: null, 'wall-tablet': { title: 'Wall', views: now } } };
  const r = run(['restore', 'wall-tablet', liveBackup(), '--confirm-write'], { state });
  assert.equal(r.code, 0, r.out);
  const snap = r.work().filter((f) => /^pre-restore-wall-tablet-\d{8}T\d{6}Z\.json$/.test(f));
  assert.equal(snap.length, 1, r.work().join(','));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'radar-dash-work', snap[0]), 'utf8')).config.views, now, 'the snapshot holds what restore replaced');
  assert.deepEqual(r.saves[0].views, EXISTING);
});

test('F4 entities prints no state, and only temperature sensors by default', () => {
  const r = run(['entities']);
  assert.equal(r.code, 0, r.out);
  assert.equal(/Private Street|PrivateSSID|61\.2|cloudy/.test(r.out), false, 'no entity state reaches the transcript');
  assert.equal(/phone_geocoded_location|phone_wifi_connection/.test(r.out), false, 'unrelated sensors are not listed');
  assert.match(r.out, /sensor\.porch_temperature\t.*temperature\t°F/);
  assert.match(r.out, /weather\.forecast_home\tForecast Home/);
  assert.match(r.out, /climate\.den\tDen/);
  const all = run(['entities', 'sensor', '--all-sensors']);
  assert.match(all.out, /sensor\.phone_wifi_connection/);
  assert.equal(/Private Street|PrivateSSID/.test(all.out), false, 'still no states');
});

test('F5 the timeout is per request, and a readback that never answers after a save says the write happened', () => {
  const hang = run(['inspect'], { env: { STUB_HANG: 'lovelace/resources' } });
  assert.equal(hang.code, 1, hang.out);
  assert.match(hang.out, /no answer to lovelace\/resources/);
  const r = run(['add-view', 'wall-tablet', viewFile(), liveBackup(), '--confirm-write'], { env: { STUB_HANG_AFTER_SAVE: '1' } });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.saves.length, 1);
  assert.match(r.out, /THE WRITE WAS SENT/);
  assert.match(r.out, /restore wall-tablet/);
});

test('F6 verify fails unless the registered card file and its sibling files are actually served', () => {
  const dashboards = { default: null, 'wall-tablet': { views: [VIEW] } };
  const resources = [{ id: 'h', url: '/hacsfiles/radar-dash/wall-radar-card.js?hacstag=1', type: 'module' }];
  const notServed = run(['verify', 'wall-tablet'], { state: { dashboards, resources } });
  assert.equal(notServed.code, 1, notServed.out);
  assert.match(notServed.out, /HTTP 404/);
  assert.deepEqual(notServed.fetches.slice(0, 1), ['http://ha.invalid:8123/hacsfiles/radar-dash/wall-radar-card.js?hacstag=1']);
  const wrongBody = run(['verify', 'wall-tablet'], { state: { dashboards, resources, served: { ...servedAt('/hacsfiles/radar-dash/'), '/hacsfiles/radar-dash/wall-radar-card.js': '<html>login</html>' } } });
  assert.equal(wrongBody.code, 1, wrongBody.out);
  assert.match(wrongBody.out, /does not define/);
  const served = servedAt('/hacsfiles/radar-dash/');
  delete served['/hacsfiles/radar-dash/leaflet.css'];
  const noSibling = run(['verify', 'wall-tablet'], { state: { dashboards, resources, served } });
  assert.equal(noSibling.code, 1, noSibling.out);
  assert.match(noSibling.out, /leaflet\.css/);
  const ok = run(['verify', 'wall-tablet'], { state: { dashboards, resources, served: servedAt('/hacsfiles/radar-dash/') } });
  assert.equal(ok.code, 0, ok.out);
  for (const f of ok.fetches) assert.equal(f.includes(TOKEN), false, 'the token is not sent to the file URLs');
});

test('F6 verify with a Horizon card also needs its lib and fonts', () => {
  const hz = { title: 'H', type: 'panel', cards: [{ type: 'custom:wall-horizon-card' }] };
  const dashboards = { default: null, 'wall-tablet': { views: [hz] } };
  const resources = [{ id: 'a', url: '/local/radar-dash/wall-radar-card.js', type: 'module' }, { id: 'b', url: '/local/radar-dash/wall-horizon-card.js', type: 'module' }];
  const served = servedAt('/local/radar-dash/', true);
  assert.equal(run(['verify', 'wall-tablet'], { state: { dashboards, resources, served } }).code, 0);
  delete served['/local/radar-dash/fonts/figtree-latin-wght-normal.woff2'];
  const r = run(['verify', 'wall-tablet'], { state: { dashboards, resources, served } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /figtree/);
});

test('F8 HA_TOKEN_FILE: the token is read from a mode-600 file, a looser file is refused, and it is never printed', () => {
  const tf = path.join(tmp, 'token-600');
  fs.writeFileSync(tf, `${TOKEN}\n`, { mode: 0o600 });
  const r = run(['inspect'], { env: { HA_TOKEN: undefined, HA_TOKEN_FILE: tf } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.includes(TOKEN), false);
  assert.equal(r.constructs.length, 1);
  const loose = path.join(tmp, 'token-644');
  fs.writeFileSync(loose, TOKEN, { mode: 0o644 });
  fs.chmodSync(loose, 0o644);
  const bad = run(['inspect'], { env: { HA_TOKEN: undefined, HA_TOKEN_FILE: loose } });
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /chmod 600/);
  assert.equal(bad.constructs.length, 0);
  assert.equal(bad.out.includes(TOKEN), false);
});

test('F11 inspect reports country and resource_count', () => {
  const out = JSON.parse(run(['inspect']).out);
  assert.equal(out.country, 'US');
  assert.equal(out.resource_count, 0);
});

test('F12 a <dashboard> that is not a url_path slug is refused in every mode that takes one; no file lands outside radar-dash-work/', () => {
  const view = viewFile();
  const b = liveBackup();
  const modes = [['backup'], ['readback'], ['plan-view', view], ['verify'], ['add-view', view, b, '--confirm-write'], ['remove-view', view, b, '--confirm-write'], ['restore', b, '--confirm-write']];
  for (const bad of ['../../escaped', 'a/b', '..', 'wall tablet', 'x.json']) {
    for (const [mode, ...rest] of modes) {
      const r = run([mode, bad, ...rest]);
      assert.equal(r.code, 1, `${mode} ${bad}: ${r.out}`);
      assert.match(r.out, /not a dashboard url_path/, `${mode} ${bad}`);
      assert.equal(r.saves.length, 0);
      assert.deepEqual(r.sends.filter((s) => s.startsWith('lovelace/config')), [], `${mode} ${bad}: the dashboard is never asked for`);
      assert.deepEqual(r.work(), [], `${mode} ${bad}: no work file`);
      assert.deepEqual(fs.readdirSync(r.dir).sort(), ['state.json', 'stub.log'], `${mode} ${bad}: nothing written next to the work dir`);
      assert.equal(fs.readdirSync(path.dirname(r.dir)).some((f) => /escaped|backup-\.\.|readback-/.test(f)), false, 'nothing written above it');
    }
  }
  assert.equal(run(['backup', 'default']).code, 0, '"default" is allowed');
  assert.equal(run(['backup', 'wall-tablet']).code, 0);
});

// ---- v1.1.0: the third card, custom:wall-thermostat-card ---------------------------------------------------------

const TH_VIEW = { title: 'Climate', path: 'climate', cards: [{ type: 'custom:wall-thermostat-card', entity: 'climate.den' }] };
const TH_JS = "customElements.define('wall-thermostat-card', WallThermostatCard);";

test('T3 add-resource and remove-resource accept the thermostat card file, and still refuse foreign files', () => {
  for (const ns of ['/hacsfiles/radar-dash/', '/local/radar-dash/']) {
    const add = run(['add-resource', `${ns}wall-thermostat-card.js`, '--confirm-write']);
    assert.equal(add.code, 0, add.out);
    assert.ok(add.sends.includes('lovelace/resources/create'));
    const rm = run(['remove-resource', `${ns}wall-thermostat-card.js`, '--confirm-write'], { state: { resources: [{ id: 't', url: `${ns}wall-thermostat-card.js`, type: 'module' }] } });
    assert.equal(rm.code, 0, rm.out);
    assert.ok(rm.sends.includes('lovelace/resources/delete'));
  }
  assert.equal(run(['add-resource', '/local/radar-dash/wall-thermostat-card.css', '--confirm-write']).code, 1);
  assert.equal(run(['add-resource', '/local/other/wall-thermostat-card.js', '--confirm-write']).code, 1);
  assert.equal(run(['add-resource', '/local/radar-dash/wall-horizon-lib.js', '--confirm-write']).code, 1, 'the lib is not a resource');
});

test('T3 verify: a thermostat-only dashboard needs only its own resource, the card file and the lib', () => {
  const dashboards = { default: null, 'wall-tablet': { views: [...EXISTING, TH_VIEW] } };
  const resources = [{ id: 't', url: '/hacsfiles/radar-dash/wall-thermostat-card.js', type: 'module' }];
  const served = { '/hacsfiles/radar-dash/wall-thermostat-card.js': TH_JS, '/hacsfiles/radar-dash/wall-horizon-lib.js': 'lib' };
  const ok = run(['verify', 'wall-tablet'], { state: { dashboards, resources, served } });
  assert.equal(ok.code, 0, ok.out);
  assert.equal(ok.fetches.some((f) => /wall-radar-card|leaflet/.test(f)), false, 'the radar card is not asked for');
  const noRes = run(['verify', 'wall-tablet'], { state: { dashboards, served } });
  assert.equal(noRes.code, 1, noRes.out);
  assert.match(noRes.out, /wall-thermostat-card\.js is not registered/);
  const noLib = run(['verify', 'wall-tablet'], { state: { dashboards, resources, served: { '/hacsfiles/radar-dash/wall-thermostat-card.js': TH_JS } } });
  assert.equal(noLib.code, 1, noLib.out);
  assert.match(noLib.out, /wall-horizon-lib\.js is not served/);
  const wrong = run(['verify', 'wall-tablet'], { state: { dashboards, resources, served: { ...served, '/hacsfiles/radar-dash/wall-thermostat-card.js': CARD_JS } } });
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /does not define wall-thermostat-card/);
  // A radar view still needs the radar resource, thermostat or not.
  const mixed = run(['verify', 'wall-tablet'], { state: { dashboards: { default: null, 'wall-tablet': { views: [VIEW, TH_VIEW] } }, resources, served } });
  assert.equal(mixed.code, 1, mixed.out);
  assert.match(mixed.out, /wall-radar-card\.js is not registered/);
});

test('T3 the thermostat card is found by type, and a view holding only it can be added and removed', () => {
  const nested = { title: 'Nested', cards: [{ type: 'vertical-stack', cards: [{ type: 'custom:wall-thermostat-card', entity: 'climate.den' }] }] };
  const state = { dashboards: { default: null, 'wall-tablet': { title: 'Wall', views: [...EXISTING, nested] } } };
  const out = JSON.parse(run(['inspect'], { state }).out);
  assert.deepEqual(out.dashboards.find((d) => d.dashboard === 'wall-tablet').cards['custom:wall-thermostat-card'], [{ view: 2, at: 'views.2.cards.0.cards.0' }]);
  const view = file('view', TH_VIEW);
  const add = run(['add-view', 'wall-tablet', view, liveBackup(), '--confirm-write']);
  assert.equal(add.code, 0, add.out);
  assert.deepEqual(add.saves[0].views, [...EXISTING, TH_VIEW]);
  const live = { dashboards: { default: null, 'wall-tablet': { title: 'Wall', views: [...EXISTING, TH_VIEW] } } };
  const rm = run(['remove-view', 'wall-tablet', view, liveBackup([...EXISTING, TH_VIEW]), '--confirm-write'], { state: live });
  assert.equal(rm.code, 0, rm.out);
  assert.deepEqual(rm.saves[0].views, EXISTING);
});

// HACS 2.x (repositories/plugin.py, update_dashboard_resources) rewrites the FIRST resource whose URL starts with
// /hacsfiles/radar-dash to the radar card file on every update. An extra card listed before the radar entry, or with
// no radar entry at all, is turned into a second radar entry by the next update.
const HACS_RADAR = { id: 'r', url: '/hacsfiles/radar-dash/wall-radar-card.js?hacstag=1', type: 'module' };
const HACS_HZ = { id: 'h', url: '/hacsfiles/radar-dash/wall-horizon-card.js', type: 'module' };
const HACS_TH = { id: 't', url: '/hacsfiles/radar-dash/wall-thermostat-card.js', type: 'module' };

test('V1 inspect and verify warn when an extra radar-dash resource precedes the HACS radar entry', () => {
  const hz = { title: 'H', type: 'panel', cards: [{ type: 'custom:wall-horizon-card' }] };
  const dashboards = { default: null, 'wall-tablet': { views: [hz] } };
  const served = servedAt('/hacsfiles/radar-dash/', true);
  for (const resources of [[HACS_HZ, HACS_RADAR], [HACS_TH, HACS_RADAR, HACS_HZ], [HACS_TH]]) {
    const ins = run(['inspect'], { state: { dashboards, resources } });
    assert.equal(ins.code, 0, ins.out);
    const w = JSON.parse(ins.out).warnings;
    assert.equal(w.length, 1, ins.out);
    assert.match(w[0], new RegExp(resources[0].url.split('/').pop()));
    assert.match(w[0], /HACS/);
    const ver = run(['verify', 'wall-tablet'], { state: { dashboards, resources, served: { ...served, [HACS_TH.url]: TH_JS } } });
    assert.match(ver.out, /^WARN: .*wall-(horizon|thermostat)-card\.js.*HACS/m, ver.out);
  }
  // Radar first, any /local entries, or no HACS entries at all: no warning.
  for (const resources of [[HACS_RADAR, HACS_HZ, HACS_TH], [{ id: 'l', url: '/local/radar-dash/wall-horizon-card.js' }, HACS_RADAR, HACS_HZ], [], [{ id: 'a', url: '/local/radar-dash/wall-radar-card.js' }, { id: 'b', url: '/local/radar-dash/wall-horizon-card.js' }]]) {
    const ins = run(['inspect'], { state: { dashboards, resources } });
    assert.deepEqual(JSON.parse(ins.out).warnings, [], ins.out);
    const ver = run(['verify', 'wall-tablet'], { state: { dashboards, resources, served: { ...served, ...servedAt('/local/radar-dash/', true) } } });
    assert.doesNotMatch(ver.out, /WARN/, ver.out);
  }
  // The warning changes no exit code: a correct install with a bad order still verifies.
  const ok = run(['verify', 'wall-tablet'], { state: { dashboards, resources: [HACS_HZ, HACS_RADAR], served } });
  assert.equal(ok.code, 0, ok.out);
});

test('V2 inspect lists a wall-thermostat-card resource wherever it is registered', () => {
  const resources = [{ id: 'x', url: '/local/cards/wall-thermostat-card.js', type: 'module' }, { id: 'y', url: '/local/other/card.js', type: 'module' }];
  const out = JSON.parse(run(['inspect'], { state: { resources } }).out);
  assert.deepEqual(out.resources.map((r) => r.url), ['/local/cards/wall-thermostat-card.js']);
  assert.equal(out.resource_count, 2);
});

test('V3 the HACS prefix has no trailing slash, as in HACS: a /hacsfiles/radar-dash-extra/ entry listed first warns', () => {
  // HACS 2.0.5 custom_components/hacs/repositories/plugin.py: line 160 builds the namespace as f"/hacsfiles/{name}"
  // (no slash), and line 217 rewrites the first entry with entry_url.startswith(namespace). So this entry, from
  // another repository, would be the one turned into wall-radar-card.js.
  const extra = { id: 'x', url: '/hacsfiles/radar-dash-extra/other-card.js', type: 'module' };
  const ins = run(['inspect'], { state: { resources: [extra, HACS_RADAR] } });
  assert.equal(ins.code, 0, ins.out);
  const w = JSON.parse(ins.out).warnings;
  assert.equal(w.length, 1, ins.out);
  assert.match(w[0], /radar-dash-extra\/other-card\.js/);
  assert.deepEqual(JSON.parse(run(['inspect'], { state: { resources: [HACS_RADAR, extra] } }).out).warnings, [], 'radar first: fine');
});
