#!/usr/bin/env node
// radar-dash: a small Home Assistant websocket helper for installing the cards on a dashboard.
// Node 22 or later (global WebSocket). No dependencies.
//
// usage: node tools/lovelace-ws.mjs <mode> [args] [--confirm-write]
//
// Credentials come from the environment only: HA_URL (e.g. http://homeassistant.local:8123) and either HA_TOKEN
// (a long-lived access token) or HA_TOKEN_FILE (the path of a file holding only the token, mode 600, kept outside
// this clone). There is no default host, the token is never printed, and nothing here writes it anywhere.
//
// <dashboard> is a dashboard's url_path (the part after the host, e.g. "wall-radar"), or "default" for Overview.
// Files this tool creates go to ./radar-dash-work/ (RADAR_DASH_WORK overrides), which the repo's .gitignore covers.
// It never overwrites a file: default names carry a timestamp, and a named file that exists is refused.
//
// read-only:
//   inspect                           version, country, location set or not, HACS, resource_count, radar-dash
//                                     resources, dashboards, cards found by type, and warnings (leftover 1.1.x extra
//                                     card entries; a HACS resource order that the next HACS update would break)
//   entities [domain ...] [--all-sensors]
//                                     entity_id, name, device class and unit (never the state) for the domains the
//                                     cards use (default: weather sensor climate media_player remote switch script
//                                     automation input_text sun). Sensors: only device_class temperature, unless
//                                     --all-sensors.
//   backup <dashboard> [out.json]     saves the dashboard's whole config to a local file and prints its path
//   plan-view <dashboard> <view.json> prints what add-view would do, and whether it would refuse
//   readback <dashboard> [out.json]   saves the dashboard's config as it is now
//   verify <dashboard>                exit 0 only if a card is on the dashboard, its resource is registered, and the
//                                     card file and the files it loads are really served by HA_URL (HTTP 200). The
//                                     wall-radar-card.js resource serves all three cards (it loads the other two).
//                                     Prints a WARN line, without failing, for the same warnings as inspect.
//
// WRITES. Each refuses with exit 2, before opening any connection, unless --confirm-write is passed. Pass it only
// after the human has seen the exact change and said yes.
//   add-resource <url>                registers /hacsfiles/radar-dash/<file>.js or /local/radar-dash/<file>.js as a
//                                     JavaScript module; refuses if that file is registered already, and refuses the
//                                     other two cards once wall-radar-card.js (which loads them) is. Additive: it is
//                                     not part of any dashboard backup, and is undone with remove-resource.
//   create-dashboard <url-path> <title>  a new, empty storage dashboard (url-path needs a hyphen); touches no other
//   add-view <dashboard> <view.json> <backup.json>
//                                     appends ONE new view. Refuses unless <backup.json> (from `backup`) equals the
//                                     dashboard as it is right now, so a backup always exists and nothing changed in
//                                     between. Never edits or reorders an existing view. Reads back and asserts.
//   remove-view <dashboard> <view.json> <backup.json>
//                                     rollback: removes the one view that equals view.json exactly. The view must
//                                     hold one of this project's cards, and <backup.json> must be a fresh backup.
//   remove-resource <url>             rollback: unregisters that exact URL; only this project's card files
//   restore <dashboard> <backup.json> last resort: puts the whole dashboard back from a backup file, after saving
//                                     what is there now to radar-dash-work/pre-restore-<dashboard>-<time>.json
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const confirmed = argv.includes('--confirm-write');
const allSensors = argv.includes('--all-sensors');
const [mode, ...args] = argv.filter((a) => a !== '--confirm-write' && a !== '--all-sensors');

const READS = ['inspect', 'entities', 'backup', 'plan-view', 'readback', 'verify'];
const WRITES = ['add-resource', 'create-dashboard', 'add-view', 'remove-view', 'remove-resource', 'restore'];
// The three cards: the file each is registered as, and the files it loads from its own folder.
const CARDS = {
  'custom:wall-radar-card': { file: 'wall-radar-card.js', element: 'wall-radar-card', loads: ['leaflet.js', 'leaflet.css'] },
  'custom:wall-horizon-card': { file: 'wall-horizon-card.js', element: 'wall-horizon-card', loads: ['wall-horizon-lib.js', 'fonts/fredoka-latin-wght-normal.woff2', 'fonts/figtree-latin-wght-normal.woff2'], needs: ['custom:wall-radar-card'] },
  'custom:wall-thermostat-card': { file: 'wall-thermostat-card.js', element: 'wall-thermostat-card', loads: ['wall-horizon-lib.js'] },
};
const CARD_TYPES = Object.keys(CARDS);
const RESOURCE = /^\/(hacsfiles|local)\/radar-dash\/(wall-radar-card|wall-horizon-card|wall-thermostat-card)\.js(\?[\w.=&-]*)?$/;
// HACS 2.x rewrites the FIRST resource whose URL starts with this to the radar card file on every update
// (repositories/plugin.py, update_dashboard_resources), so the radar entry must come before the other two.
const HACS_NAMESPACE = '/hacsfiles/radar-dash';
const ENTITY_DOMAINS = ['weather', 'sensor', 'climate', 'media_player', 'remote', 'switch', 'script', 'automation', 'input_text', 'sun'];

const refuse = (msg) => {
  console.error(`REFUSED: ${msg}`);
  process.exit(2);
};

if (![...READS, ...WRITES].includes(mode)) refuse(`unknown mode ${mode ?? '(none)'}; modes: ${[...READS, ...WRITES].join(', ')}`);
// Defence in depth: no write without the flag, and no connection either.
if (WRITES.includes(mode) && !confirmed) refuse(`${mode} writes to Home Assistant; pass --confirm-write, and only after the human approved this exact change`);

const { HA_URL, HA_TOKEN_FILE } = process.env;
let HA_TOKEN = process.env.HA_TOKEN;
if (!HA_TOKEN && HA_TOKEN_FILE) {
  // A token file must be private to its owner: a group- or world-readable one is refused, not read.
  let st;
  try {
    st = fs.statSync(HA_TOKEN_FILE);
  } catch {
    refuse('HA_TOKEN_FILE does not name a readable file');
  }
  if (st.mode & 0o077) refuse('HA_TOKEN_FILE is readable by other users; run: chmod 600 on it');
  HA_TOKEN = fs.readFileSync(HA_TOKEN_FILE, 'utf8').trim();
}
if (!HA_URL || !HA_TOKEN) refuse('set HA_URL (e.g. http://homeassistant.local:8123) and HA_TOKEN (a long-lived access token) or HA_TOKEN_FILE (a mode-600 file holding it) in the environment');
const TIMEOUT_MS = Number(process.env.RADAR_DASH_TIMEOUT_MS) || 20000;
const WORK = process.env.RADAR_DASH_WORK || path.join(process.cwd(), 'radar-dash-work');
let wsUrl;
let httpBase;
try {
  const u = new URL(HA_URL);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) throw new Error('scheme');
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/api\/websocket\/?$/, '').replace(/\/$/, '')}/api/websocket`;
  u.search = '';
  wsUrl = u.href;
  const h = new URL(HA_URL);
  h.protocol = h.protocol === 'https:' || h.protocol === 'wss:' ? 'https:' : 'http:';
  httpBase = `${h.origin}${h.pathname.replace(/\/api\/websocket\/?$/, '').replace(/\/$/, '')}`;
} catch {
  refuse('HA_URL must be a URL such as http://homeassistant.local:8123');
}

// ---- pure helpers ---------------------------------------------------------------------------------------------

/**
 * Every node of `type` under config.views, however deeply nested (stacks, layout cards, a conditional's card), in
 * document order: { view, at, node }. Cards are found by TYPE, never by a view path or index: people rearrange views.
 */
function findCards(config, type) {
  const out = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, i]));
    else if (node && typeof node === 'object') {
      if (node.type === type && path.length > 2) out.push({ view: path[1], at: path.join('.'), node });
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    }
  };
  (config?.views || []).forEach((v, i) => walk(v, ['views', i]));
  return out;
}

/** Deep equality of two JSON values, independent of key order. */
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && same(a[k], b[k]));
}

/** A view file: one view object holding at least one of this project's cards. */
function checkView(view) {
  if (!view || typeof view !== 'object' || Array.isArray(view)) throw new Error('view.json must hold one view object');
  if ('views' in view) throw new Error('view.json holds a whole dashboard; it must be ONE view (title, path, cards)');
  if (!CARD_TYPES.some((t) => findCards({ views: [view] }, t).length)) throw new Error(`view.json holds neither of this project's cards (${CARD_TYPES.join(', ')})`);
  return view;
}

/** The dashboard with `view` appended; refuses a clash. Existing views are passed through untouched. */
function withView(config, view) {
  const views = config?.views;
  if (!Array.isArray(views)) throw new Error('the dashboard has no views list (a strategy or auto-generated dashboard); use a new dashboard');
  if (view.path && views.some((v) => v.path === view.path)) throw new Error(`a view with path "${view.path}" exists already`);
  if (views.some((v) => same(v, view))) throw new Error('this exact view is on the dashboard already');
  return { ...config, views: [...views, view] };
}

/** The dashboard without the one view equal to `view`; refuses 0 or 2+ matches. */
function withoutView(config, view) {
  const views = config?.views || [];
  const hits = views.map((v, i) => (same(v, view) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) throw new Error(`expected exactly one view equal to view.json, found ${hits.length}; if it was edited since, remove it by hand in the dashboard editor`);
  return { config: { ...config, views: views.filter((_, i) => i !== hits[0]) }, index: hits[0] };
}

const readJson = (file) => {
  if (!file) throw new Error('missing file argument');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const urlPath = (name) => {
  if (!name) throw new Error('missing <dashboard> (a url_path, or "default")');
  // A url_path is a slug. Anything else is refused here: the name also goes into local file names.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error(`"${name}" is not a dashboard url_path (letters, digits, - and _ only, or "default")`);
  return name === 'default' ? null : name;
};
const resourceFile = (url) => url.split('?')[0];

/** Writes a new local file, never over an existing one. Without a name: <work dir>/<prefix>-<dashboard>-<UTC time>.json. */
function writeNew(file, prefix, dashboard, value) {
  let out = file;
  if (!out) {
    fs.mkdirSync(WORK, { recursive: true, mode: 0o700 });
    out = path.join(WORK, `${prefix}-${dashboard}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}.json`);
  }
  try {
    fs.writeFileSync(out, JSON.stringify(value, null, 1), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`${out} exists already; this tool never overwrites a file. Give another name, or none for a timestamped one`);
    throw e;
  }
  return out;
}

/** GET a path HA serves without a login (/hacsfiles, /local). The token is not sent. Returns { status, body }. */
async function served(urlPath) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${httpBase}${urlPath}`, { signal: ctl.signal });
    return { status: r.status, body: r.ok ? await r.text() : '' };
  } catch (e) {
    return { status: 0, body: '', error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

// ---- the websocket --------------------------------------------------------------------------------------------

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
// Each request has its own timeout; a slow dashboard with many reads is not cut off by one global clock.
const call = (msg) => new Promise((res, rej) => {
  const i = ++id;
  const t = setTimeout(() => {
    pending.delete(i);
    rej(new Error(`no answer to ${msg.type} within ${TIMEOUT_MS / 1000} s`));
  }, TIMEOUT_MS);
  pending.set(i, { res, rej, t });
  ws.send(JSON.stringify({ id: i, ...msg }));
});
// Until Home Assistant has accepted the token.
const connectTimer = setTimeout(() => {
  console.error(`FAIL no answer from Home Assistant within ${TIMEOUT_MS / 1000} s (check HA_URL)`);
  process.exit(1);
}, TIMEOUT_MS);

/** A dashboard's config, or null when Home Assistant has none stored for it (never edited, or just created). */
async function getConfig(dashboard) {
  try {
    return await call({ type: 'lovelace/config', url_path: dashboard, force: true });
  } catch (e) {
    if (/config_not_found/.test(e.message)) return null;
    throw e;
  }
}
const saveConfig = (dashboard, config) => call({ type: 'lovelace/config/save', url_path: dashboard, config });

/** The dashboard after a save. A failure here is NOT a failed write: the message says so and names the way back. */
async function readAfterSave(dashboard, name, undo) {
  try {
    return await getConfig(dashboard);
  } catch (e) {
    throw new Error(`THE WRITE WAS SENT and has most likely been applied, but reading the dashboard back failed (${e.message}). Do not repeat the write. Check with: readback ${name}. ${undo}`);
  }
}

const RADAR_FILE = CARDS['custom:wall-radar-card'].file;
const isRadarResource = (r) => RESOURCE.test(r.url) && resourceFile(r.url).endsWith(`/${RADAR_FILE}`);

/**
 * Since 1.2.0 wall-radar-card.js loads the other two cards itself, with its own query string (so a HACS update busts
 * every cache). With a radar entry registered, an entry for either other card is redundant, and an unversioned one
 * can load a stale copy that defines its element first. One warning per such entry; nothing is removed here.
 */
function redundantWarnings(resources) {
  if (!resources.some(isRadarResource)) return [];
  return resources.filter((r) => RESOURCE.test(r.url) && !isRadarResource(r)).map((r) => `${r.url} is no longer needed: since radar-dash 1.2.0 the wall-radar-card.js entry loads every card with its own version, and this extra entry can load an old copy. Remove it (remove-resource ${r.url}); never the radar entry`);
}

/** A warning when the next HACS update would overwrite one of the extra card resources, else null. */
function hacsOrderWarning(resources) {
  const hacs = resources.filter((r) => String(r.url).startsWith(HACS_NAMESPACE));
  if (!hacs.length || resourceFile(hacs[0].url).endsWith(`/${CARDS['custom:wall-radar-card'].file}`)) return null;
  const why = hacs.some((r) => resourceFile(r.url).endsWith(`/${CARDS['custom:wall-radar-card'].file}`)) ? 'is listed before the HACS radar entry' : 'is registered with no HACS radar entry';
  return `${hacs[0].url} ${why}: every HACS update rewrites the first ${HACS_NAMESPACE}/ resource to wall-radar-card.js, which would replace it. Remove the extra resources and add them again after the radar entry (README, "Resource order")`;
}

async function main() {
  switch (mode) {
    case 'inspect': {
      const [haConfig, dashboards, resources] = [await call({ type: 'get_config' }), await call({ type: 'lovelace/dashboards/list' }), await call({ type: 'lovelace/resources' })];
      const out = {
        version: haConfig.version,
        // The cards centre on this when no centre is configured. The coordinates themselves are not printed.
        location_set: Number.isFinite(Number(haConfig.latitude)) && Number.isFinite(Number(haConfig.longitude)) && haConfig.latitude !== null,
        country: haConfig.country ?? null,
        hacs_installed: (haConfig.components || []).includes('hacs'),
        resources: resources.filter((r) => /radar-dash|wall-(radar|horizon|thermostat)-card/.test(r.url)),
        resource_count: resources.length,
        warnings: [hacsOrderWarning(resources), ...redundantWarnings(resources)].filter(Boolean),
        dashboards: [],
      };
      for (const d of [{ url_path: null, title: 'Overview (default)', mode: 'storage' }, ...dashboards]) {
        const entry = { dashboard: d.url_path ?? 'default', title: d.title, mode: d.mode };
        if (d.mode !== 'storage') entry.note = 'YAML dashboard: this tool cannot write to it; edit its YAML file by hand';
        else {
          const cfg = await getConfig(d.url_path);
          if (!cfg) entry.note = 'no stored config (auto-generated or empty)';
          else if (!Array.isArray(cfg.views)) entry.note = 'strategy dashboard (no views list)';
          else {
            entry.views = cfg.views.map((v, i) => v.path ?? v.title ?? i);
            entry.cards = Object.fromEntries(CARD_TYPES.map((t) => [t, findCards(cfg, t).map((h) => ({ view: h.view, at: h.at }))]));
          }
        }
        out.dashboards.push(entry);
      }
      console.log(JSON.stringify(out, null, 1));
      return;
    }
    case 'entities': {
      // Names only, never states: a state can be an address, an SSID or a person's whereabouts, and this output
      // lands in an agent's transcript. Sensors are limited to temperature ones unless --all-sensors.
      const domains = args.length ? args : ENTITY_DOMAINS;
      const states = await call({ type: 'get_states' });
      const wanted = states.filter((x) => {
        const domain = x.entity_id.split('.')[0];
        if (!domains.includes(domain)) return false;
        return domain !== 'sensor' || allSensors || x.attributes?.device_class === 'temperature';
      });
      console.log('entity_id\tname\tdevice_class\tunit');
      for (const x of wanted.sort((a, b) => a.entity_id.localeCompare(b.entity_id))) {
        const a = x.attributes || {};
        console.log(`${x.entity_id}\t${a.friendly_name ?? ''}\t${a.device_class ?? ''}\t${a.unit_of_measurement ?? ''}`);
      }
      return;
    }
    case 'backup':
    case 'readback': {
      const dashboard = urlPath(args[0]);
      const config = await getConfig(dashboard);
      const out = writeNew(args[1], mode, args[0], { dashboard: args[0], taken: new Date().toISOString(), config });
      console.log(`${mode}: ${args[0]} -> ${out} (${config ? `${config.views?.length ?? 0} view(s)` : 'no stored config'})`);
      return;
    }
    case 'plan-view': {
      const dashboard = urlPath(args[0]);
      const view = checkView(readJson(args[1]));
      const config = await getConfig(dashboard);
      console.log(`dashboard ${args[0]}: ${config ? `${config.views?.length ?? 'no'} view(s) now` : 'no stored config'}`);
      try {
        if (!config) {
          if (dashboard === null) throw new Error('the default dashboard is auto-generated; saving to it would replace everything Home Assistant shows there. Use a new dashboard (create-dashboard)');
          console.log('add-view would store this as the first view of the empty dashboard');
        } else {
          const next = withView(config, view);
          console.log(`add-view would append view ${next.views.length - 1}; views 0..${config.views.length - 1} stay as they are`);
        }
      } catch (e) {
        console.log(`add-view would REFUSE: ${e.message}`);
      }
      console.log(JSON.stringify(view, null, 1));
      return;
    }
    case 'verify': {
      const dashboard = urlPath(args[0]);
      const resources = await call({ type: 'lovelace/resources' });
      const ours = resources.filter((r) => RESOURCE.test(r.url));
      const config = await getConfig(dashboard);
      const cards = CARD_TYPES.flatMap((t) => findCards(config, t).map((h) => `${t} in view ${h.view}`));
      console.log(`resources: ${ours.map((r) => r.url).join(', ') || 'none'}`);
      console.log(`cards: ${cards.join(', ') || 'none'}`);
      for (const w of [hacsOrderWarning(resources), ...redundantWarnings(resources)].filter(Boolean)) console.log(`WARN: ${w}`);
      if (!cards.length) throw new Error('the dashboard holds none of the cards');
      // Each card on the dashboard needs its own resource, or the radar card's (which loads it from its own folder,
      // with its own query); Horizon also needs the radar card's.
      const present = CARD_TYPES.filter((t) => findCards(config, t).length);
      const needed = [...new Set(present.flatMap((t) => [t, ...(CARDS[t].needs || [])]))];
      const resourceOf = (t) => {
        const own = ours.find((r) => resourceFile(r.url).endsWith(`/${CARDS[t].file}`));
        const radar = ours.find(isRadarResource);
        if (own || !radar) return own;
        return { url: `${resourceFile(radar.url).replace(/[^/]+$/, '')}${CARDS[t].file}${radar.url.slice(resourceFile(radar.url).length)}` };
      };
      for (const t of needed) if (!resourceOf(t)) throw new Error(`${CARDS[t].file} is not registered as a resource (the dashboard holds a ${present.find((p) => p === t || (CARDS[p].needs || []).includes(t)).replace('custom:', '')})`);
      // A registered resource proves nothing about the files: fetch them the way the browser will.
      for (const t of needed) {
        const res = resourceOf(t);
        const { element, loads } = CARDS[t];
        const got = await served(res.url);
        if (got.status !== 200) throw new Error(`${res.url} is registered but not served: HTTP ${got.status}${got.error ? ` (${got.error})` : ''}. Are the files in place?`);
        if (!got.body.includes(`customElements.define('${element}'`)) throw new Error(`${res.url} answers 200 but does not define ${element} (a login page or the wrong file?)`);
        const dir = resourceFile(res.url).replace(/[^/]+$/, '');
        const query = res.url.slice(resourceFile(res.url).length);
        for (const f of loads) {
          const sib = await served(`${dir}${f}${query}`);
          if (sib.status !== 200) throw new Error(`${dir}${f} is not served: HTTP ${sib.status}. The card loads it from its own folder; copy the whole dist/ folder`);
        }
        console.log(`served: ${res.url} and ${loads.length} file(s) it loads`);
      }
      console.log('verify: ok (configuration and files; open the view to see it render)');
      return;
    }
    case 'add-resource': {
      const url = args[0] || '';
      if (!RESOURCE.test(url)) throw new Error('add-resource needs /hacsfiles/radar-dash/<card>.js or /local/radar-dash/<card>.js (optionally ?v=...), where <card> is wall-radar-card, wall-horizon-card or wall-thermostat-card');
      const resources = await call({ type: 'lovelace/resources' });
      const radar = resources.find(isRadarResource);
      if (radar && !isRadarResource({ url })) throw new Error(`${resourceFile(url).split('/').pop()} is not needed: ${radar.url} loads every card since radar-dash 1.2.0, and an extra entry can load an old copy`);
      const dup = resources.find((r) => resourceFile(r.url).split('/').pop() === resourceFile(url).split('/').pop());
      if (dup) throw new Error(`${resourceFile(url).split('/').pop()} is registered already as ${dup.url}; registering it twice is not needed`);
      const created = await call({ type: 'lovelace/resources/create', res_type: 'module', url });
      console.log(`resource created: ${created?.id ?? ''} ${url}`);
      return;
    }
    case 'remove-resource': {
      if (!RESOURCE.test(args[0] || '')) throw new Error('remove-resource only removes this project\'s card files: /hacsfiles/radar-dash/<card>.js or /local/radar-dash/<card>.js');
      const resources = await call({ type: 'lovelace/resources' });
      const hits = resources.filter((r) => r.url === args[0]);
      if (hits.length !== 1) throw new Error(`expected one resource with exactly that URL, found ${hits.length}`);
      await call({ type: 'lovelace/resources/delete', resource_id: hits[0].id });
      console.log(`resource deleted: ${hits[0].id} ${hits[0].url}`);
      return;
    }
    case 'create-dashboard': {
      const [path, ...title] = args;
      if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(path || '')) throw new Error('create-dashboard needs a url-path of lower-case words joined by hyphens, e.g. wall-tablet');
      if (!title.length) throw new Error('create-dashboard needs a title');
      const dashboards = await call({ type: 'lovelace/dashboards/list' });
      if (dashboards.some((d) => d.url_path === path)) throw new Error(`a dashboard at /${path} exists already`);
      await call({ type: 'lovelace/dashboards/create', url_path: path, title: title.join(' '), mode: 'storage', show_in_sidebar: true, require_admin: false });
      console.log(`dashboard created: /${path}`);
      return;
    }
    case 'add-view': {
      const dashboard = urlPath(args[0]);
      const view = checkView(readJson(args[1]));
      if (!args[2]) throw new Error('add-view needs the backup file made by `backup` just before (third argument)');
      const backup = readJson(args[2]);
      if (!('config' in backup) || backup.dashboard !== args[0]) throw new Error('that file is not a backup of this dashboard (make one with `backup`)');
      const config = await getConfig(dashboard);
      if (!same(config, backup.config)) throw new Error('the dashboard changed since the backup was taken; take a fresh backup and show the human the plan again');
      let next;
      if (!config) {
        if (dashboard === null) throw new Error('the default dashboard is auto-generated; saving to it would replace everything Home Assistant shows there. Use a new dashboard (create-dashboard)');
        next = { views: [view] };
      } else next = withView(config, view);
      await saveConfig(dashboard, next);
      // Read back and assert: one more view, the new one last, every earlier view exactly as it was.
      const after = await readAfterSave(dashboard, args[0], `If it looks wrong: restore ${args[0]} ${args[2]} --confirm-write`);
      const before = config?.views || [];
      if (!after || after.views.length !== before.length + 1) throw new Error(`READBACK MISMATCH: expected ${before.length + 1} views, found ${after?.views?.length}. Restore with: restore ${args[0]} ${args[2]} --confirm-write`);
      if (!before.every((v, i) => same(v, after.views[i]))) throw new Error(`READBACK MISMATCH: an existing view changed. Restore with: restore ${args[0]} ${args[2]} --confirm-write`);
      if (!same(after.views[before.length], view)) throw new Error('READBACK MISMATCH: the stored view differs from view.json');
      console.log(`view added at index ${before.length} of ${args[0]}; ${before.length} existing view(s) unchanged (read back)`);
      return;
    }
    case 'remove-view': {
      const dashboard = urlPath(args[0]);
      const view = checkView(readJson(args[1]));
      if (!args[2]) throw new Error('remove-view needs a backup file made by `backup` just before (third argument)');
      const backup = readJson(args[2]);
      if (!('config' in backup) || backup.dashboard !== args[0]) throw new Error('that file is not a backup of this dashboard (make one with `backup`)');
      const current = await getConfig(dashboard);
      if (!same(current, backup.config)) throw new Error('the dashboard changed since the backup was taken; take a fresh backup first');
      const { config, index } = withoutView(current, view);
      await saveConfig(dashboard, config);
      const after = await readAfterSave(dashboard, args[0], `If it looks wrong: restore ${args[0]} ${args[2]} --confirm-write`);
      if (!same(after, config)) throw new Error(`READBACK MISMATCH after remove-view. Restore with: restore ${args[0]} ${args[2]} --confirm-write`);
      console.log(`view removed: index ${index} of ${args[0]}; ${config.views.length} view(s) remain (read back)`);
      return;
    }
    case 'restore': {
      const dashboard = urlPath(args[0]);
      const backup = readJson(args[1]);
      if (!('config' in backup) || backup.dashboard !== args[0]) throw new Error('that file is not a backup of this dashboard');
      if (!backup.config) throw new Error('the backup holds no stored config (the dashboard was empty or auto-generated); remove the added view with remove-view, or delete the dashboard in Settings > Dashboards');
      // What is there now is saved first: a restore is itself a whole-dashboard write and must be undoable.
      const snapshot = writeNew(null, 'pre-restore', args[0], { dashboard: args[0], taken: new Date().toISOString(), config: await getConfig(dashboard) });
      console.log(`pre-restore snapshot: ${snapshot}`);
      await saveConfig(dashboard, backup.config);
      const after = await readAfterSave(dashboard, args[0], `The dashboard as it was before this restore is in ${snapshot}`);
      if (!same(after, backup.config)) throw new Error(`READBACK MISMATCH after restore. The dashboard as it was before is in ${snapshot}`);
      console.log(`restored ${args[0]} from ${args[1]} (read back)`);
      return;
    }
    default:
      throw new Error('bad mode');
  }
}

ws.onerror = () => {
  console.error('FAIL could not connect to Home Assistant (check HA_URL)');
  process.exit(1);
};
ws.onmessage = async (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
  else if (m.type === 'auth_invalid') {
    console.error('FAIL auth_invalid: Home Assistant rejected HA_TOKEN');
    process.exit(2);
  } else if (m.type === 'auth_ok') {
    try {
      clearTimeout(connectTimer);
      await main();
      ws.close();
      process.exit(0);
    } catch (e) {
      console.error('FAIL', e.message);
      process.exit(1);
    }
  } else if (m.type === 'result') {
    const p = pending.get(m.id);
    if (!p) return; // answered after its timeout
    pending.delete(m.id);
    clearTimeout(p.t);
    if (m.success) p.res(m.result);
    else p.rej(new Error(`${m.error?.code ?? 'error'}: ${m.error?.message ?? ''}`));
  }
};
