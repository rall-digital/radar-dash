// The card with no personal defaults: the centre comes from Home Assistant's own location, the site is the nearest
// NEXRAD radar, and the data-source credits are on. Run: node --test test/public-defaults.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { WallRadarCard, creditsFor, nearestSite } from '../dist/wall-radar-card.js';
import { configure } from './helpers.mjs';

// Three real sites (IEM NEXRAD network): Oklahoma City, Amarillo, eastern North Carolina.
const SITES = [
  { id: 'TLX', lat: 35.3331, lon: -97.2778 },
  { id: 'AMA', lat: 35.2333, lon: -101.7092 },
  { id: 'MHX', lat: 34.7759, lon: -76.8762 },
];
const GEOJSON = { features: SITES.map((s) => ({ id: s.id, properties: { sid: s.id }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })) };

function card(config, hass) {
  const el = Object.create(WallRadarCard.prototype);
  Object.assign(el, { dataset: {}, isConnected: false, _built: false, _gen: 1 });
  el.setConfig(config);
  if (hass) el._hass = hass;
  return el;
}

test('no default centre, no default site, credits on', () => {
  const c = configure({});
  assert.equal('center_latitude' in c, false);
  assert.equal('center_longitude' in c, false);
  assert.equal(c.site, '');
  assert.equal(c.show_attribution, true);
  assert.equal(configure({ show_attribution: false }).show_attribution, false, 'still an option');
  const stub = WallRadarCard.getStubConfig();
  assert.equal('center_latitude' in stub || 'center_longitude' in stub || 'site' in stub, false, 'the card picker gets no location');
});

test('a configured centre is validated; half a centre is refused', () => {
  const c = configure({ center_latitude: '35.47', center_longitude: -97.52, site: 'tlx' });
  assert.deepEqual([c.center_latitude, c.center_longitude, c.site], [35.47, -97.52, 'TLX']);
  assert.throws(() => configure({ center_latitude: 'north', center_longitude: -97.52 }), /center_latitude must be a number/);
  assert.throws(() => configure({ center_latitude: 35.47 }), /both center_latitude and center_longitude/);
  assert.equal('center_latitude' in configure({ center_latitude: null, center_longitude: null }), false, 'null means unset');
});

test('the centre: the config, else hass.config, else none yet', () => {
  assert.deepEqual(card({ center_latitude: 35.47, center_longitude: -97.52 }, { config: { latitude: 1, longitude: 2 } })._centre(), [35.47, -97.52]);
  assert.deepEqual(card({}, { config: { latitude: 35.1, longitude: -77.05 } })._centre(), [35.1, -77.05]);
  assert.equal(card({})._centre(), null, 'no hass yet');
  assert.equal(card({}, { config: {} })._centre(), null, 'hass without a location');
  assert.equal(card({}, { config: { latitude: null, longitude: null } })._centre(), null, 'null is not 0, 0');
});

test('nothing is built until a centre is known, and `set hass` starts it', async () => {
  const el = card({});
  await WallRadarCard.prototype._start.call(el);
  assert.equal(el._built, false, 'no centre: not built');
  let starts = 0;
  el._start = () => starts++;
  el._setBasemap = () => {};
  el.isConnected = true;
  el.hass = { states: {}, config: {} };
  assert.equal(starts, 0, 'a hass without a location starts nothing');
  el.hass = { states: {}, config: { latitude: 35.47, longitude: -97.52 } };
  assert.equal(starts, 1);
});

test('nearestSite picks the closest site and skips broken entries', () => {
  assert.equal(nearestSite(SITES, 35.47, -97.52), 'TLX');
  assert.equal(nearestSite(SITES, 35.2, -101.5), 'AMA');
  assert.equal(nearestSite(SITES, 35.1, -77.05), 'MHX');
  assert.equal(nearestSite([{ id: '', lat: 35.47, lon: -97.52 }, { id: 'BAD', lat: NaN, lon: 0 }, ...SITES], 35.47, -97.52), 'TLX');
  assert.equal(nearestSite([], 35.47, -97.52), null);
});

test('the site: the config (no lookup), else the nearest from the IEM list; a failed lookup throws and is asked again', async () => {
  const urls = [];
  let fail = true;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (fail) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => GEOJSON };
  };
  const set = card({ site: 'mhx' });
  set._home = [35.47, -97.52];
  assert.equal(await set._resolveSite(), 'MHX');
  assert.equal(urls.length, 0, 'a configured site needs no site list');

  const auto = card({});
  auto._home = [35.47, -97.52];
  await assert.rejects(() => auto._resolveSite(), /HTTP 503/);
  assert.equal(auto._site, undefined);
  fail = false;
  assert.equal(await auto._resolveSite(), 'TLX');
  assert.equal(auto.dataset.site, 'TLX', 'data-site names the pick');
  assert.equal(urls.filter((u) => u.includes('NEXRAD.geojson')).length, 2, 'the failed list was not cached');
  assert.equal(await auto._resolveSite(), 'TLX');
  assert.equal(urls.length, 2, 'resolved once');
});

test('credits name every provider on screen: Esri\'s own wording, NOAA/NWS with IEM, OpenStreetMap with CARTO labels', () => {
  const radar = /NOAA\/NWS via Iowa Environmental Mesonet \(IEM\)/;
  const sat = creditsFor('satellite', false);
  assert.equal(sat.length, 2);
  assert.match(sat[0], /^Imagery: Esri, .*Earthstar Geographics, and the GIS User Community$/);
  assert.match(sat[1], radar);
  assert.match(creditsFor('ink', false)[0], /^Imagery: Esri/, 'ink is recoloured Esri imagery');
  const coast = creditsFor('hillshade_dark_coast', false);
  assert.equal(coast.length, 3, 'hillshade and imagery are both credited');
  assert.match(coast[0], /^Hillshade: Esri, .*USGS.*and the GIS user community$/);
  assert.match(creditsFor('night', false)[0], /NASA Black Marble via NASA GIBS/);
  const labels = creditsFor('satellite', true);
  assert.ok(labels.some((c) => /© OpenStreetMap contributors, © CARTO/.test(c)));
  assert.equal(creditsFor('satellite', false).some((c) => /OpenStreetMap|CARTO/.test(c)), false, 'no labels, no label credit');
  for (const name of ['hillshade_dark', 'hillshade_dark_coast', 'satellite', 'ink', 'night']) assert.match(creditsFor(name, false).at(-1), radar);
});
