// A stand-in Home Assistant websocket for test/public-tool.test.mjs, loaded with `node --import`.
// It replaces the global WebSocket, so a test can never reach a network: every construction
// and message type is appended to $STUB_LOG, each save as "saved <dashboard> <config JSON>". It
// keeps state within one process, so a read after a save sees the save (the tool reads back what it wrote).
// STUB_STATE (a JSON file) seeds { dashboards: { <url_path|default>: config|null }, list: [...], resources: [...] }.
// `served` in the state maps a URL path to a body: the stub also replaces global fetch (each call logged as
// "fetch <url>"), answering 200 with that body or 404, so `verify` never reaches a network either.
// STUB_DROP_SAVE=1 makes a save answer ok but store nothing (a readback mismatch). STUB_HANG=<type> never answers
// that message type; STUB_HANG_AFTER_SAVE=1 never answers a lovelace/config read made after a save.
import fs from 'node:fs';

const log = (line) => fs.appendFileSync(process.env.STUB_LOG, `${line}\n`);
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, 'utf8'));
const key = (m) => m.url_path ?? 'default';
const fail = (code) => ({ __error: { code, message: code } });
let saved = false;
const REPLIES = {
  get_config: () => ({ version: '2026.9.0', latitude: 41.6, longitude: -93.6, country: 'US', components: ['lovelace'] }),
  get_states: () => [
    { entity_id: 'weather.forecast_home', state: 'cloudy', attributes: { friendly_name: 'Forecast Home' } },
    { entity_id: 'sensor.porch_temperature', state: '61.2', attributes: { device_class: 'temperature', unit_of_measurement: '°F' } },
    { entity_id: 'sensor.phone_geocoded_location', state: '12 Private Street', attributes: { friendly_name: 'Phone location' } },
    { entity_id: 'sensor.phone_wifi_connection', state: 'PrivateSSID', attributes: {} },
    { entity_id: 'climate.den', state: 'cool', attributes: { friendly_name: 'Den' } },
    { entity_id: 'light.lamp', state: 'on', attributes: {} },
  ],
  'lovelace/dashboards/list': () => state.list || [],
  'lovelace/dashboards/create': (m) => {
    (state.list ||= []).push({ url_path: m.url_path, title: m.title, mode: m.mode });
    state.dashboards[m.url_path] = null;
    return { id: m.url_path };
  },
  'lovelace/config': (m) => (state.dashboards[key(m)] ? structuredClone(state.dashboards[key(m)]) : fail('config_not_found')),
  'lovelace/config/save': (m) => {
    log(`saved ${key(m)} ${JSON.stringify(m.config)}`);
    saved = true;
    if (process.env.STUB_DROP_SAVE !== '1') state.dashboards[key(m)] = structuredClone(m.config);
    return null;
  },
  'lovelace/resources': () => state.resources || [],
  'lovelace/resources/create': (m) => {
    (state.resources ||= []).push({ id: 'new', url: m.url, type: m.res_type });
    return { id: 'new', url: m.url, type: m.res_type };
  },
  'lovelace/resources/delete': (m) => {
    state.resources = (state.resources || []).filter((r) => r.id !== m.resource_id);
    return null;
  },
};

globalThis.WebSocket = class {
  constructor(url) {
    log(`construct ${url}`);
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'auth_required' }) }), 0);
  }

  send(raw) {
    const m = JSON.parse(raw);
    if (m.type === 'auth') {
      log(`auth ${m.access_token === process.env.HA_TOKEN ? 'token-from-env' : 'other'}`);
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'auth_ok' }) }), 0);
      return;
    }
    log(`send ${m.type}`);
    if (process.env.STUB_HANG === m.type || (process.env.STUB_HANG_AFTER_SAVE === '1' && saved && m.type === 'lovelace/config')) return;
    const result = m.type in REPLIES ? REPLIES[m.type](m) : fail('unknown_command');
    const reply = result?.__error ? { id: m.id, type: 'result', success: false, error: result.__error } : { id: m.id, type: 'result', success: true, result };
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(reply) }), 0);
  }

  close() {}
};

globalThis.fetch = async (url) => {
  log(`fetch ${url}`);
  const body = (state.served || {})[new URL(url).pathname];
  return body === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => body };
};
