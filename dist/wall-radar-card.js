// wall-radar-card: NEXRAD radar loop for Home Assistant Lovelace.
// One site's super-res reflectivity (IEM RIDGE N0B) with MRMS filling its gaps, an HRRR forecast tail,
// and NWS warning outlines, over a dark hillshade. Every radar pixel is decoded back to dBZ and
// recoloured in a canvas. Plain JS, no build step.

const BASE = new URL('.', import.meta.url);
// The card's own ?v= is passed on to the vendored Leaflet files so a deploy busts their cache too.
const VERSION = new URL(import.meta.url).search;
const IEM = 'https://mesonet.agron.iastate.edu';
const TILE = `${IEM}/cache/tile.py/1.0.0`;

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
// The credit strings are each service's own copyright text (the MapServer's copyrightText), prefixed with what it is.
const HILLSHADE_DARK = {
  url: `${ESRI}/Elevation/World_Hillshade_Dark/MapServer/tile/{z}/{y}/{x}`,
  maxNativeZoom: 16,
  attribution: 'Hillshade: Esri, Vantor, Airbus DS, USGS, NGA, NASA, CGIAR, N Robinson, NCEAS, NLS, OS, NMA, Geodatastyrelsen, Rijkswaterstaat, GSA, Geoland, FEMA, Intermap, and the GIS user community',
};
const SATELLITE = {
  url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
  maxNativeZoom: 19,
  attribution: 'Imagery: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
};
const RADAR_CREDIT = 'Radar, forecast and warnings: NOAA/NWS via Iowa Environmental Mesonet (IEM)';
const LABELS_CREDIT = 'Labels: © OpenStreetMap contributors, © CARTO';
// Ink: the same imagery recoloured onto one navy ramp, once per tile in a canvas (toneInk).
const INK = { ...SATELLITE, tone: true };
// Night: NASA Black Marble 2016 city lights from GIBS. Its tile matrix ends at zoom 8, so the URL
// zoom is capped there (maxUrlZoom) and Leaflet scales those tiles up for closer views.
const NIGHT = {
  url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
  maxUrlZoom: 8,
  detectRetina: false,
  attribution: 'Night lights: NASA Black Marble via NASA GIBS',
};
// Each basemap is a stack of tile layers, bottom first. Hillshade Dark alone has no water or
// coastlines (flat grey everywhere), so `hillshade_dark_coast` multiplies it by greyscale
// satellite imagery: the relief stays, water comes out darker than land, and there is no text.
// (Rejected: Esri Dark Gray Base bakes place and water names in at z9; Carto dark_nolabels now
// serves "API KEY REQUIRED" tiles to browsers.)
const BASEMAPS = {
  hillshade_dark: [HILLSHADE_DARK],
  hillshade_dark_coast: [HILLSHADE_DARK, { ...SATELLITE, className: 'grey-multiply' }],
  satellite: [SATELLITE],
  ink: [INK],
  night: [NIGHT],
};
/** The credit lines for what is on screen: the basemap's layers, the labels when shown, then the radar data. */
export function creditsFor(basemap, labels) {
  const base = (BASEMAPS[basemap] || []).map((b) => b.attribution);
  return [...new Set([...base, ...(labels ? [LABELS_CREDIT] : []), RADAR_CREDIT])];
}
const PALETTES = ['smooth', 'nws', 'universal_blue', 'twc', 'n0q'];

// The rain fade window while the satellite basemap shows (see fadeFor): starts at 8 dBZ and is full at 12.
// Measured on live rain over forest (ATX) and farmland (DMX): against
// the default 5..15, low-contrast pixels fall 30% and the translucent band about half, while the strong rain
// drawn stays within 1%. Moving the window up without narrowing it only moved the faint band to higher dBZ.
const SATELLITE_FADE_DEFAULT = 8;
const SATELLITE_FADE_WIDTH = 4;
const REFADE_CONCURRENCY = 4; // tile redraws in flight after a basemap swap (each fetches one or two sources)

// There is no default centre and no default site:
// the centre falls back to Home Assistant's own location (hass.config) and the site to the nearest NEXRAD radar.
const DEFAULTS = {
  height: '525px',
  zoom_level: 8,
  home_position: [0.5, 0.5],
  frame_count: 15,
  frame_delay: 400,
  restart_delay: 800,
  now_hold_ms: 1500,
  transition_ms: 400,
  detail: 1,
  radar_retina: false,
  basemap: 'hillshade_dark_coast',
  day_basemap: 'ink',
  night_basemap: 'night',
  satellite_fade_dbz: SATELLITE_FADE_DEFAULT,
  source: 'hybrid',
  site_range_km: 150,
  blend_km: 40,
  clutter_dbz: 20,
  clutter_radius_px: 16,
  palette: 'smooth',
  smooth: true,
  min_dbz: 5,
  fade_dbz: 15,
  opacity: 0.8,
  forecast_hours: 2,
  echo_dbz: 20,
  // Hide the forecast when IEM's newest HRRR run is older than this. Measured over 2026-09-21..23:
  // run age at a random moment was p50 2.3 h, p90 2.9 h, p99 3.9 h; 4 h showed it 99.4% of the time.
  forecast_max_age_h: 4,
  warnings: true,
  show_color_bar: true,
  show_progress: true,
  // Wall display: no place names on the map unless asked for. The data-source credits stay on by default:
  // the tile providers' terms ask for them.
  show_labels: false,
  show_attribution: true,
  show_status: false,
  // Self-healing on a page that is never reloaded (see _watch). 0 turns a step off.
  watchdog: true,
  watchdog_restart_min: 20,
  watchdog_reload_min: 45,
};

const POLL_MS = 2 * 60 * 1000;
const WARNINGS_POLL_MS = 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const HISTORY_MIN = 60;
const STALE_MIN = 20;
const FRAME_LOAD_TIMEOUT_MS = 20000;
const PRELOAD_CONCURRENCY = 3;
const TILE_RETRY_MS = 1500;
// A tile whose every source failed (a hole in a frame that otherwise loaded) is requested again on later polls:
const HOLE_ATTEMPTS = 3; // at most this many times,
const HOLE_RETRY_GAP_MS = 60 * 1000; // not twice within this long,
const HOLE_RETRIES_PER_POLL = 8; // and at most this many holes per poll.
const FETCH_TIMEOUT_MS = 30000; // a JSON or CSS request that has not finished by then fails like any other
const DETACHED_TEARDOWN_MS = 60000;
const WATCHDOG_MS = 60 * 1000; // watchdog tick
const WAKE_DEBOUNCE_MS = 5000; // visibilitychange, pageshow and online often arrive together
const RELOAD_GUARD_MS = 2 * 60 * 60 * 1000; // at most one watchdog reload per 2 h, across page loads
const RELOAD_KEY = 'wall-radar-card:last-reload';
const MRMS_MAX_LAG_MIN = 10; // an MRMS frame older than this relative to its N0B scan is not used
const FORECAST_OPACITY = 0.75; // forecast frames: lower opacity ...
const FORECAST_DESATURATE = 0.4; // ... and partly desaturated
const SMOOTH_RADIUS = 2; // box blur radius in source pixels, applied twice
const SMOOTH_NODATA = 44; // -10 dBZ on the n0q index scale
// Composite layers exist for the current image plus 5-minute offsets out to 55 minutes.
const COMPOSITE_OFFSETS = [55, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0];
const WARNING_COLORS = { TO: '#ff2020', SV: '#ffd700', FF: '#20e040', MA: '#ff8c00' };

// IEM n0q palette (the palette the RIDGE N0B and n0q composite tiles are drawn in),
// sampled every 2.5 dBZ from -30 to 75. Measured from USCOMP n0q_0.png's colormap;
// every opaque pixel of sampled RIDGE tiles matched an entry of that colormap.
const DBZ_STOPS = [
  '#87758b', '#8a7b85', '#8d8280', '#918879', '#989457', '#a5a36d', '#b2b283', '#c2c49d',
  '#d2d4b4', '#c0c4b4', '#b0b6b4', '#9da5b4', '#949bb5', '#7c89af', '#6779a9', '#4f67a2',
  '#4361a2', '#4f84b6', '#5eadcf', '#6ad0e4', '#4bd690', '#11d117', '#0fb714', '#0da212',
  '#0b880f', '#09730c', '#095e09', '#849d06', '#ead204', '#ffc900', '#ffb100', '#ff9400',
  '#ff0000', '#d50000', '#b10000', '#8d0000', '#fff5ff', '#ffbeff', '#fc6bfd', '#ed36ef',
  '#ac00fc', '#8300e8', '#05ebf0',
];

// The full n0q colormap, 256 RGB entries as hex; palette index i is (i / 2 - 32) dBZ.
const N0Q_PALETTE =
  '00000085718f85728f86738d87758b87768b887789897987897a878a7b858b7d848b7e848c7f828d81808d82808e837e' +
  '8f847c8f857c90877b918879918979928b77938d759691539894579b975b9d9a60a09d64a3a068a5a36da8a671aaa976' +
  'adac7ab0af7eb2b283b7b88cbabb90bdbe94bfc199c2c49dc4c7a2c7caa6cacdaaccd0afd2d4b4cfd2b4c9ccb4c6c9b4' +
  'c3c7b4c0c4b4bdc1b4b9beb4b6bbb4b3b9b4b0b6b4adb3b4aab0b4a4abb4a0a8b49da5b49aa2b497a0b4949db4919ab4' +
  '949bb59098b48c95b38892b2808cb07c89af7886ae7483ac7080ab6c7daa6779a96376a85f73a75b70a6576da44f67a2' +
  '4b64a14761a0435e9f415b9e4361a24568a6486faa4a76ae4d7db24f84b6518bbb5699c3599fc75ba6cb5eadcf60b4d4' +
  '62bbd865c2dc67c9e06ad0e46fd6e868d6d759d6b352d6a24bd69043d67e3cd66d35d65b11d51811d11710cd1710c816' +
  '10c4160fbc150fb7140eb3140eaf130eab130da6120da2120d9e110c99110c95100c91100b880f0b840e0a800e0a7c0d' +
  '0a770d09730c096f0c096b0b08660b08620a095e09327308467d085b88076f9207849d0698a806adb205c1bd05d6c704' +
  'ead204ffe200ffd800ffd300ffce00ffc900ffc400ffc000ffbb00ffb600ffb100ffac00ffa700ffa200ff9900ff9400' +
  'ff8f00ff8a00ff8500ff8000ff0000f80000f10000ea0000e30000d50000cd0000c60000bf0000b80000b10000aa0000' +
  'a300009b00009400008d00007f0000780000710000fffffffff5ffffeaffffdfffffd4ffffc9ffffbeffffb3ffff9dff' +
  'ff92ffff75fffc6bfdf960faf656f7f34bf4f040f1ed36efea2bece720e9e10be3b200ffac00fca400f79b00f49300ef' +
  '8800ea8300e87900e27200dd6900db05ecf005ebf005eaf005dde005dce005dbe005cdd005ccd004bdc004bcc004bbc0' +
  '04aeb004adb0049ea0049da0049ca0038e90038d90038c90037e80037d80036f70036e70036d70025f60025e60024f50' +
  '024e50024d50023f40023e40023d40013030012f30012020011f20011e203a67b53a66b53a65b53a64b53a63b53a62b5';

const LCREF_PALETTE =
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000a4a4ffa1a1fc9e9ef99a9af69797f29494ef9191ec8e8ee98a8ae68787e3' +
  '8484e08181dc7e7ed97a7ad67777d37474d07171cd6e6ec96a6ac66767c34080ff3e7df93d7af23b76ec3a73e63870df' +
  '366dd9356ad33366cc3263c63060c02e5db92d5ab32b56ac2a53a62850a0264d99254a9323468d22438620408000f900' +
  '00f20000ec0000e60000df0000d90000d30000cc0000c60000c00000b90000b30000ac0000a60000a000009900009300' +
  '008d00008600008000fff900fff200ffec00ffe600ffdf00ffd900ffd300ffcc00ffc600ffc000ffb900ffb300ffac00' +
  'ffa600ffa000ff9900ff9300ff8d00ff8600ff0000fa0000f50000f10000ec0000e70000e30000de0000d90000d40000' +
  'cf0000cb0000c60000c10000bd0000b80000b30000ae0000aa0000a50000ff00fff900f9f200f2ec00ece600e6df00df' +
  'd900d9d300d3cc00ccc600c6c000c0b900b9b300b3ac00aca600a6a000a09900999300938d008d860086fffffff9f9f9' +
  'f2f2f2ececece6e6e6dfdfdfd9d9d9d3d3d3ccccccc6c6c6c0c0c0b9b9b9b3b3b3acacaca6a6a6a0a0a0999999939393' +
  '8d8d8d868686808080808080808080808080808080808080808080808080808080808080808080808080808080808080' +
  '808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080808080';

// RainViewer colour tables (rainviewer_api_colors_table.csv), RGBA per 1 dBZ from -32 to 95.
const RV_UNIVERSAL_BLUE =
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000000000000000000000000000000000000000000000006361591466635a19' +
  '69665c1e6c685d246f6b5f29726e612e75706234787364397c75653e7f786744827b6949857d6a4e88806c548b826d59' +
  '8e856f5e928871649e93756eaa9e7978b6a97e82c2b4828ccec08796d2c48ba0d6c88faadacc93b4ded097be88ddeeff' +
  '6cd1ebff51c5e8ff36bae5ff1baee2ff00a3e0ff009ad5ff0091caff0088bfff007fb4ff0077aaff0070a3ff00699cff' +
  '006295ff005b8eff005588ff005180ff004e78ff004a70ff004768ffffee00ffffe000ffffd200ffffc500ffffb700ff' +
  'ffaa00ffff9f00ffff9500ffff8b00ffff8100ffff4400fff23600ffe62800ffd91b00ffcd0d00ffc10000ffa80000ff' +
  '8f0000ff760000ff5d0000ffffaaffffff9fffffff95ffffff8bffffff81ffffff77ffffff6cffffff62ffffff58ffff' +
  'ff4effffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ff00ff' +
  '00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff' +
  '00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff';
const RV_TWC =
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '0000000063eb63ff63eb63ff63eb63ff63eb63ff63eb63ff63eb63ff5be35bff53dc53ff4cd44cff44cd44ff3dc63dff' +
  '37be3bff31b639ff2bae37ff25a635ff1f9e34ff1c932eff198829ff167d23ff13721eff116719ff0f6016ff0d5a13ff' +
  '0c5411ff0a4e0eff08480cff074209ff053c07ff033604ff023002ffffff00ffffe500ffffcb00ffffb200ffff9800ff' +
  'ff7f00fffa6500fff54c00fff03200ffeb1900ffe60000ffe10000ffdc0000ffd70000ffd20000ffcd0000ffc30000ff' +
  'b90000ffaf0000ffa50000ff9b0000ff960000ff910000ff8c0000ff870000ff820000ff7d0000ff780000ff730000ff' +
  '6e0000ff690000ff820031ff9c0062ffb60094ffd000c5ffffffffffffffffffffffffffffffffffffffffffffffffff' +
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' +
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

// MetPy NWSReflectivity.tbl: 15 colours for 5-dBZ bins starting at 5 dBZ.
const NWS_COLORS = ['00ecec', '01a0f6', '0000f6', '00ff00', '00c800', '009000', 'ffff00', 'e7c000', 'ff9000', 'ff0000', 'd60000', 'c00000', 'ff00ff', '9955c9', '000000'];

// ---- palettes -------------------------------------------------------------

function hexLut(hex) {
  // Packed RGB -> lowest palette index with that colour.
  const m = new Map();
  for (let i = hex.length / 6 - 1; i >= 0; i--) m.set(parseInt(hex.substr(i * 6, 6), 16), i);
  return m;
}

let decodeLuts;
function luts() {
  if (!decodeLuts) {
    const n0q = hexLut(N0Q_PALETTE);
    n0q.set(0, 0);
    const lcref = hexLut(LCREF_PALETTE);
    lcref.set(0, 0);
    lcref.set(0x808080, 0); // missing / no coverage
    decodeLuts = { n0q, lcref };
  }
  return decodeLuts;
}

const rgbAt = (hex, i) => [0, 2, 4].map((o) => parseInt(hex.substr(i * 6 + o, 2), 16));

// RGBA for one dBZ value in the named palette, before the min_dbz/fade alpha.
function paletteColor(name, dbz, idx) {
  if (name === 'n0q') return [...rgbAt(N0Q_PALETTE, idx), 255];
  if (name === 'nws') {
    const bin = Math.max(0, Math.min(NWS_COLORS.length - 1, Math.floor((dbz - 5) / 5)));
    return [...rgbAt(NWS_COLORS[bin], 0), 255];
  }
  if (name === 'universal_blue' || name === 'twc') {
    const table = name === 'twc' ? RV_TWC : RV_UNIVERSAL_BLUE;
    const row = Math.max(0, Math.min(127, Math.floor(dbz) + 32));
    return [0, 2, 4, 6].map((o) => parseInt(table.substr(row * 8 + o, 2), 16));
  }
  // smooth: the NWS colours as stops at 5, 10, ... 70 dBZ, interpolated continuously.
  const stops = NWS_COLORS.length - 2; // the table's last entry (black, >= 75) is not used as a stop
  const t = Math.max(0, Math.min(stops, (dbz - 5) / 5));
  const k = Math.min(stops - 1, Math.floor(t));
  const a = rgbAt(NWS_COLORS[k], 0);
  const b = rgbAt(NWS_COLORS[k + 1], 0);
  const f = t - k;
  return [0, 1, 2].map((j) => Math.round(a[j] + (b[j] - a[j]) * f)).concat(255);
}

// 256-entry RGBA lookup indexed like the n0q scale (i / 2 - 32 dBZ). Index 0 is "no data".
function colorLut(c, forecast) {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 1; i < 256; i++) {
    const dbz = i / 2 - 32;
    const [r, g, b, a] = paletteColor(c.palette, dbz, i);
    let fade = dbz >= c.min_dbz ? 1 : 0;
    if (c.fade_dbz > c.min_dbz) fade = Math.max(0, Math.min(1, (dbz - c.min_dbz) / (c.fade_dbz - c.min_dbz)));
    let rgb = [r, g, b];
    if (forecast) {
      const grey = 0.3 * r + 0.59 * g + 0.11 * b;
      rgb = rgb.map((v) => v + (grey - v) * FORECAST_DESATURATE);
    }
    lut.set([...rgb, a * fade], i * 4);
  }
  return lut;
}

function colorBarGradient(c) {
  if (c.palette === 'n0q' && !c.smooth) {
    const n = DBZ_STOPS.length - 1;
    return `linear-gradient(to right, ${DBZ_STOPS.map((s, i) => `${s} ${((i / n) * 100).toFixed(2)}%`).join(', ')})`;
  }
  // The same ramp the radar is drawn with, from the fade start to 75 dBZ.
  const lut = colorLut(c, false);
  const lo = Math.min(c.min_dbz, 70);
  const stops = [];
  for (let d = lo; d <= 75; d += 1) {
    const i = Math.round((d + 32) * 2) * 4;
    stops.push(`rgba(${lut[i]},${lut[i + 1]},${lut[i + 2]},${(lut[i + 3] / 255).toFixed(2)}) ${(((d - lo) / (75 - lo)) * 100).toFixed(2)}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

// ---- tile pipeline --------------------------------------------------------

// A failed tile request, a 503 included, gets one retry after TILE_RETRY_MS. The retry, and every request with `fresh`
// (a hole's retry), skips the HTTP cache: IEM sends its 503s with max-age=300, so a plain retry could be answered with
// the cached 503. `alive()` false (the card was torn down meanwhile) stops before the retry.
async function fetchTile(url, { fresh = false, alive } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, fresh || attempt ? { mode: 'cors', cache: 'reload' } : { mode: 'cors' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.blob();
    } catch (err) {
      if (attempt) throw err;
      await new Promise((res) => setTimeout(res, TILE_RETRY_MS));
      if (alive && !alive()) throw err;
    }
  }
}

// fetch + read(response), aborted after FETCH_TIMEOUT_MS (the body read included), so a request that never answers
// becomes an ordinary failure instead of an await that never ends.
async function fetchTimed(url, opts, read) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await read(r);
  } finally {
    clearTimeout(timer);
  }
}

// ---- CPU work: one tile at a time, in short tasks ---------------------------
// Tiles are fetched and image-decoded in parallel, but the per-pixel work runs one tile at a
// time through `serial`, yielding to the event loop between steps. That keeps every task short
// (the loop's frame timer is never starved) and lets all tiles share these scratch buffers
// instead of allocating ~2 MB each.
const N = 256 * 256;
let bufs;
function buffers() {
  if (!bufs) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Not cached: this tile fails, and the next one asks for a context again.
    if (!ctx) throw new Error('wall-radar-card: no 2D context for the decode canvas');
    bufs = {
      ctx,
      site: new Uint8Array(N),
      mrms: new Uint8Array(N),
      out: new Uint8Array(N),
      tmp8: new Uint8Array(N),
      near: new Uint8Array(N),
      f0: new Float32Array(N),
      f1: new Float32Array(N),
      f2: new Float32Array(N),
      dx: new Float32Array(256),
      dy: new Float32Array(256),
      img: new ImageData(256, 256),
    };
  }
  return bufs;
}

let cpuChain = Promise.resolve();
function serial(fn) {
  const run = cpuChain.then(fn, fn);
  cpuChain = run.catch(() => {});
  return run;
}

const yieldTask = () =>
  globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((res) => setTimeout(res, 0));

// Decode an image bitmap to palette indices (0 = no data) into `out`, at 256 px.
function decodeInto(img, lut, out) {
  const ctx = buffers().ctx;
  ctx.clearRect(0, 0, 256, 256);
  ctx.drawImage(img, 0, 0, 256, 256);
  img.close?.();
  const px = ctx.getImageData(0, 0, 256, 256).data;
  let lastRgb = -1;
  let lastIdx = 0;
  for (let p = 0, i = 0; i < N; i++, p += 4) {
    if (!px[p + 3]) {
      out[i] = 0;
      continue;
    }
    const rgb = (px[p] << 16) | (px[p + 1] << 8) | px[p + 2];
    if (rgb !== lastRgb) {
      lastRgb = rgb;
      lastIdx = lut.get(rgb) ?? 0;
    }
    out[i] = lastIdx;
  }
}

// out = 1 where `mask` is non-zero within `r` pixels (square window), via two sliding-window passes.
function dilateInto(mask, r, tmp, out) {
  const n = 256;
  for (let y = 0; y < n; y++) {
    let count = 0;
    for (let x = -r; x < n; x++) {
      if (x + r < n && mask[y * n + x + r]) count++;
      if (x - r - 1 >= 0 && mask[y * n + x - r - 1]) count--;
      if (x >= 0) tmp[y * n + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < n; x++) {
    let count = 0;
    for (let y = -r; y < n; y++) {
      if (y + r < n && tmp[(y + r) * n + x]) count++;
      if (y - r - 1 >= 0 && tmp[(y - r - 1) * n + x]) count--;
      if (y >= 0) out[y * n + x] = count > 0 ? 1 : 0;
    }
  }
}

// Separable box blur of src into out (tmp is scratch), clamped at the tile edge.
function boxBlurInto(src, r, tmp, out) {
  const n = 256;
  const w = 2 * r + 1;
  for (let y = 0; y < n; y++) {
    const row = y * n;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(n - 1, Math.max(0, k))];
    for (let x = 0; x < n; x++) {
      tmp[row + x] = sum / w;
      sum += src[row + Math.min(n - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < n; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(n - 1, Math.max(0, k)) * n + x];
    for (let y = 0; y < n; y++) {
      out[y * n + x] = sum / w;
      sum += tmp[Math.min(n - 1, y + r + 1) * n + x] - tmp[Math.max(0, y - r) * n + x];
    }
  }
}

// Per-column / per-row km offsets from (lat0, lon0) for tile z/x/y (equirectangular; fine at this scale),
// plus the tile's nearest and farthest distance, so tiles wholly inside or outside the blend band skip per-pixel work.
function tileOffsets(z, x, y, lat0, lon0, dx, dy) {
  const n = 256;
  const world = n * 2 ** z;
  const kmLon = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const lon = ((x * n + i + 0.5) / world) * 360 - 180;
    dx[i] = (lon - lon0) * kmLon;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y * n + i + 0.5)) / world))) * 180) / Math.PI;
    dy[i] = (lat - lat0) * 110.57;
  }
  const near = (a) => (a[0] <= 0 && a[n - 1] >= 0) || (a[0] >= 0 && a[n - 1] <= 0) ? 0 : Math.min(Math.abs(a[0]), Math.abs(a[n - 1]));
  const far = (a) => Math.max(Math.abs(a[0]), Math.abs(a[n - 1]));
  return { min: Math.hypot(near(dx), near(dy)), max: Math.hypot(far(dx), far(dy)) };
}

// The NEXRAD site list, fetched once and shared. A failed fetch is not kept, so a later call asks again.
let siteList;
function sites() {
  if (!siteList) {
    siteList = fetchTimed(`${IEM}/geojson/network/NEXRAD.geojson`, {}, (r) => r.json())
      .then((d) => d.features.map((f) => ({ id: String(f.id || f.properties?.sid || '').toUpperCase(), sid: f.properties?.sid, lon: Number(f.geometry?.coordinates?.[0]), lat: Number(f.geometry?.coordinates?.[1]) })))
      .catch((err) => {
        siteList = null;
        throw err;
      });
  }
  return siteList;
}

let siteCoords;
function lookupSite(site) {
  siteCoords = siteCoords || new Map();
  if (!siteCoords.has(site)) {
    siteCoords.set(
      site,
      sites()
        .then((list) => {
          const f = list.find((x) => x.id === site || x.sid === site);
          return f ? { lon: f.lon, lat: f.lat } : null;
        })
        .catch(() => null),
    );
  }
  return siteCoords.get(site);
}

/** The id of the site in `list` ([{ id, lat, lon }]) nearest to a point, or null for an empty list. */
export function nearestSite(list, lat, lon) {
  let best = null;
  let bestKm = Infinity;
  const kmLon = 111.32 * Math.cos((lat * Math.PI) / 180);
  for (const s of list) {
    if (!s.id || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const km = Math.hypot((s.lon - lon) * kmLon, (s.lat - lat) * 110.57);
    if (km < bestKm) {
      bestKm = km;
      best = s.id;
    }
  }
  return best;
}

let leafletPromise;
let leafletCss;

function loadLeaflet() {
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const previous = window.L;
      const script = document.createElement('script');
      script.src = new URL(`leaflet.js${VERSION}`, BASE).href;
      script.onload = () => {
        const ours = window.L;
        // Hand any pre-existing global Leaflet back to whoever owned it.
        if (previous && previous !== ours) ours.noConflict();
        resolve(ours);
      };
      script.onerror = () => {
        script.remove();
        reject(new Error('wall-radar-card: failed to load leaflet.js'));
      };
      document.head.appendChild(script);
    });
    // A failure is not kept: the next build loads it again.
    leafletPromise.catch(() => (leafletPromise = null));
  }
  if (!leafletCss) {
    leafletCss = fetchTimed(new URL(`leaflet.css${VERSION}`, BASE).href, {}, (r) => r.text());
    leafletCss.catch(() => (leafletCss = null));
  }
  return Promise.all([leafletPromise, leafletCss]);
}

function isoMinute(date) {
  return date.toISOString().slice(0, 16) + 'Z';
}

const stamp = (t) => new Date(t).toISOString().slice(0, 16).replace(/\D/g, '');

// ---- horizon hooks: pure helpers ---------------------------------------------

// home_position: [x, y], fractions of the map area where the configured centre is drawn.
export function homePosition(v) {
  const ok =
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((n) => (typeof n === 'number' || (typeof n === 'string' && n.trim() !== '')) && Number(n) >= 0 && Number(n) <= 1);
  if (!ok) throw new Error('wall-radar-card: home_position must be [x, y], two fractions from 0 to 1');
  return v.map(Number);
}

// Container-pixel offset from home to the map centre that draws home at fraction `pos` of a
// width x height map: the centre sits (0.5 - x) * width right of home and (0.5 - y) * height below.
export function homeOffset(pos, width, height) {
  return [(0.5 - pos[0]) * width, (0.5 - pos[1]) * height];
}

// The basemap to show: `auto` follows sun.sun, night_basemap after sunset and day_basemap otherwise
// (also while sun.sun is missing or unknown).
// The rain fade window while `basemap` shows. Over satellite imagery the faintest rain is a translucent teal that
// blends into green land, so there the fade window moves to satellite_fade_dbz .. satellite_fade_dbz +
// SATELLITE_FADE_WIDTH: it starts later and is also narrower, so with the defaults (5..15 becomes 8..12) rain
// from 12 to 15 dBZ is drawn fully opaque over satellite where it is translucent on other basemaps. The window
// only moves when satellite_fade_dbz is above min_dbz: every other basemap, a satellite_fade_dbz at or below
// min_dbz (a hard cut, e.g. at 10), and satellite_fade_dbz off (-32) keep min_dbz / fade_dbz as configured.
export function fadeFor(c, basemap) {
  if (basemap !== 'satellite' || !(c.satellite_fade_dbz > c.min_dbz)) return { min_dbz: c.min_dbz, fade_dbz: c.fade_dbz };
  return { min_dbz: c.satellite_fade_dbz, fade_dbz: c.satellite_fade_dbz + SATELLITE_FADE_WIDTH };
}

export function wantedBasemap(c, sunState) {
  if (c.basemap !== 'auto') return c.basemap;
  return sunState === 'below_horizon' ? c.night_basemap ?? 'night' : c.day_basemap;
}

// Ink ramp, fitted to a reference pair of day and ink images (medians per
// luma level, rms 3.8): Rec. 601 luma 39 and below -> dark, 121 and above -> light, linear between.
const INK_RAMP = { lo: 39, hi: 121, dark: [10, 17, 35], light: [174, 190, 225] };
let inkTable;
export function inkLut() {
  if (!inkTable) {
    const { lo, hi, dark, light } = INK_RAMP;
    inkTable = new Uint8ClampedArray(256 * 3);
    for (let l = 0; l < 256; l++) {
      const t = Math.max(0, Math.min(1, (l - lo) / (hi - lo)));
      for (let j = 0; j < 3; j++) inkTable[l * 3 + j] = Math.round(dark[j] + (light[j] - dark[j]) * t);
    }
  }
  return inkTable;
}

// Recolour RGBA pixels in place onto the ink ramp by luma. Alpha is kept. The exact reference that
// toneInkComposite (what the card draws with) approximates.
export function toneInk(px) {
  const lut = inkLut();
  for (let p = 0; p < px.length; p += 4) {
    const l = Math.round(0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]) * 3;
    px[p] = lut[l];
    px[p + 1] = lut[l + 1];
    px[p + 2] = lut[l + 2];
  }
}

// Draw `img` into a size x size canvas context toned onto the ink ramp by compositing alone, without
// reading pixels (so a plain, CORS-less <img> is fine). The luma stretch (lo..hi -> 0..1, clamped) is a CSS
// brightness + contrast pair: contrast(k) = (v - 0.5) k + 0.5 after brightness(b) = v b, so
// b k = 255 / (hi - lo) and 0.5 - 0.5 k = -lo / (hi - lo). Then light - dark is multiplied in and dark added.
// CSS grayscale weighs luma a little differently (Rec. 709) from toneInk (Rec. 601), so the two
// differ slightly on real tiles.
export function toneInkComposite(ctx, img, size) {
  const { lo, hi, dark, light } = INK_RAMP;
  const k = 1 + (2 * lo) / (hi - lo);
  const b = 255 / (hi - lo) / k;
  // Luma as toneInk computes it: the 'luminosity' blend's Lum() is 0.3 R + 0.59 G + 0.11 B (Rec. 601),
  // where CSS grayscale() would use Rec. 709 weights.
  // Scale first, with a plain draw: resampling inside the luminosity draw blends luma unevenly
  // (measured up to 21 per channel at 85 px; 5 when scaled first).
  // clearRect + source-over, not 'copy': Chrome resamples a 'copy' draw differently (measured worse).
  const scaled = inkScratch('scaled', size);
  scaled.clearRect(0, 0, size, size);
  scaled.globalCompositeOperation = 'source-over';
  scaled.imageSmoothingQuality = 'high';
  scaled.drawImage(img, 0, 0, size, size);
  const grey = inkScratch('grey', size);
  grey.globalCompositeOperation = 'source-over';
  grey.fillStyle = '#808080';
  grey.fillRect(0, 0, size, size);
  grey.globalCompositeOperation = 'luminosity';
  grey.drawImage(scaled.canvas, 0, 0, size, size, 0, 0, size, size);
  grey.globalCompositeOperation = 'source-over';
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = `rgb(${light.map((v, j) => v - dark[j])})`;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'multiply';
  ctx.filter = `brightness(${b.toFixed(4)}) contrast(${k.toFixed(4)})`;
  ctx.drawImage(grey.canvas, 0, 0, size, size, 0, 0, size, size);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `rgb(${dark})`;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
}

const inkScratches = {};
// Shared scratch canvases for the scaling and luma passes (tiles are toned one at a time, synchronously).
function inkScratch(name, size) {
  let ctx = inkScratches[name];
  if (!ctx || ctx.canvas.width < size) {
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
    ctx = inkScratches[name] = cv.getContext('2d');
  }
  return ctx;
}

// Lowest n0q index at or above `dbz` (index i is i / 2 - 32 dBZ). 0 means no data and never counts.
export function echoIndex(dbz) {
  return Math.max(1, Math.ceil((dbz + 32) * 2));
}

// Global pixel position of lat/lng at zoom z on 256-px Web Mercator tiles: what Leaflet's
// map.project(latlng, z) returns for EPSG:3857.
export function sourcePixel(lat, lng, z) {
  const scale = 256 * 2 ** z;
  const phi = (Math.max(-85.0511287798, Math.min(85.0511287798, lat)) * Math.PI) / 180;
  return { x: scale * (lng / 360 + 0.5), y: scale * (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) };
}

// Numbers for one tile's dBZ field as drawn (256 x 256 values on the n0q index scale; smoothed
// fields are fractional and round the way the colouring does) at tile x, y: how many pixels inside
// `view` (global pixels at the tile's zoom) reach echoIdx, and the dBZ at `home` when this tile holds
// it. No data reads -32, or -10 once smoothed (v2 blurs no data as -10 dBZ).
export function tileNumbers(field, x, y, view, home, echoIdx) {
  const x0 = Math.max(0, Math.floor(view.minX) - x * 256);
  const x1 = Math.min(256, Math.ceil(view.maxX) - x * 256);
  const y0 = Math.max(0, Math.floor(view.minY) - y * 256);
  const y1 = Math.min(256, Math.ceil(view.maxY) - y * 256);
  let echoes = 0;
  for (let row = y0; row < y1; row++) {
    for (let i = row * 256 + x0, end = row * 256 + x1; i < end; i++) if (field[i] >= echoIdx - 0.5) echoes++;
  }
  const hx = Math.floor(home.x) - x * 256;
  const hy = Math.floor(home.y) - y * 256;
  const inTile = hx >= 0 && hx < 256 && hy >= 0 && hy < 256;
  return { echoes, home: inTile ? Math.round(field[hy * 256 + hx]) / 2 - 32 : undefined };
}

// A frame's numbers from its tiles' numbers (a Map, as _recordTile keeps them). undefined = unknown.
export function frameNumbers(tiles) {
  if (!tiles?.size) return { echoes: undefined, home: undefined };
  let echoes = 0;
  let home;
  for (const t of tiles.values()) {
    echoes += t.echoes;
    if (t.home !== undefined) home = t.home;
  }
  return { echoes, home };
}

// data-now-dbz, data-rain-at and data-rain-peak-dbz from [{ time, forecast, home }], oldest first.
// '' means unknown (no such frame, or the tile holding home never rendered) or, for rain-at, none.
export function summarize(frames, echoDbz) {
  const fmt = (v) => (v === undefined ? '' : String(v));
  const observed = frames.filter((f) => !f.forecast);
  const now = observed.length ? observed[observed.length - 1].home : undefined;
  let rainAt = '';
  let peak;
  for (const f of frames) {
    if (!f.forecast || f.home === undefined) continue;
    if (peak === undefined || f.home > peak) peak = f.home;
    if (!rainAt && f.home >= echoDbz) rainAt = new Date(f.time).toISOString();
  }
  return { nowDbz: fmt(now), rainAt, rainPeakDbz: fmt(peak) };
}

// Even-odd ray cast of lng/lat against one GeoJSON ring of [lng, lat] points.
function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Whether a GeoJSON Polygon or MultiPolygon covers lng/lat. Holes are excluded; other types never cover.
export function insideGeometry(g, lng, lat) {
  const polygons = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
  return polygons.some((rings) => inRing(rings[0], lng, lat) && !rings.slice(1).some((hole) => inRing(hole, lng, lat)));
}

// The warnings the card draws (significance W; TO, SV, FF, MA) that cover lng/lat and have not
// expired, as [{ phenomena, expire_utc }]: in drawing order (TO, SV, FF, MA), then by expiry, no duplicates.
export function homeWarnings(features, lng, lat, now) {
  const order = Object.keys(WARNING_COLORS);
  const seen = new Set();
  const out = [];
  for (const f of features) {
    const p = f.properties || {};
    if (p.significance !== 'W' || !order.includes(p.phenomena)) continue;
    const expire = p.expire_utc || p.expire || '';
    const t = Date.parse(expire);
    if (Number.isFinite(t) && t <= now) continue;
    if (!insideGeometry(f.geometry, lng, lat)) continue;
    const key = `${p.phenomena}|${expire}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ phenomena: p.phenomena, expire_utc: expire });
  }
  return out.sort((a, b) => order.indexOf(a.phenomena) - order.indexOf(b.phenomena) || a.expire_utc.localeCompare(b.expire_utc));
}

const CARD_CSS = `
  :host { display: block; }
  ha-card {
    display: flex; flex-direction: column; overflow: hidden; position: relative;
    background: #000;
  }
  #color-bar { flex: 0 0 8px; height: 8px; }
  #map { flex: 1 1 auto; min-height: 0; width: 100%; position: relative; background: #000; }
  .leaflet-container { background: #000; }
  /* Tiles overlap by 1px (see _initTile). Leaflet 1.9's plus-lighter blend would add the
     overlapping column into a bright seam, so composite tiles normally instead. */
  .leaflet-container img.leaflet-tile { mix-blend-mode: normal; }
  .leaflet-layer.grey-multiply { mix-blend-mode: multiply; filter: grayscale(1) brightness(1.9) contrast(1.1); }
  .leaflet-radar-pane > .leaflet-layer { transition: opacity var(--xfade, 0ms) linear; }
  /* Loop position, no text: solid under observed frames, dotted under forecast frames. */
  #progress { position: absolute; left: 0; right: 0; top: 8px; height: 2px; z-index: 1000; pointer-events: none; display: flex; }
  #progress > div { height: 100%; }
  #progress .obs { background: rgba(255, 255, 255, var(--a)); }
  #progress .fc { background: repeating-linear-gradient(90deg, rgba(255, 255, 255, var(--a)) 0 3px, transparent 3px 6px); }
  #progress-track { --a: 0.18; }
  #progress-fill { --a: 0.75; }
  #chip {
    position: absolute; right: 8px; top: 16px; z-index: 1000; display: none;
    padding: 2px 8px; border-radius: 10px; font: 12px/18px system-ui, sans-serif;
    color: #fff; background: rgba(0, 0, 0, 0.55); pointer-events: none;
  }
  #chip.show { display: block; }
  .leaflet-control-attribution {
    font-size: 9px; background: rgba(0, 0, 0, 0.35) !important; color: rgba(255, 255, 255, 0.6);
  }
  .leaflet-control-attribution a { color: inherit; }
`;

// Node can import this file for its pure helpers and palettes; there it has no DOM.
class WallRadarCard extends (globalThis.HTMLElement ?? class {}) {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._frames = []; // [{ key, time, forecast, layer }] oldest first, fully loaded
    this._pending = new Map(); // key -> layer still preloading (queued or loading)
    this._queue = []; // preloads waiting for a slot
    this._active = 0;
    this._index = 0;
    this._mode = null; // 'site' | 'hybrid' | 'composite'
    this._backoff = 0;
    this._built = false;
  }

  static getStubConfig() {
    return { ...DEFAULTS };
  }

  setConfig(config) {
    if (!config) throw new Error('wall-radar-card: missing config');
    const c = { ...DEFAULTS, ...config };
    if (c.min_dbz === null || c.min_dbz === false) c.min_dbz = -32; // filter off
    if (c.fade_dbz === null || c.fade_dbz === false) c.fade_dbz = c.min_dbz;
    if (c.satellite_fade_dbz === null || c.satellite_fade_dbz === false) c.satellite_fade_dbz = -32; // off
    for (const k of ['zoom_level', 'frame_count', 'frame_delay', 'restart_delay', 'detail', 'opacity', 'min_dbz', 'fade_dbz', 'transition_ms', 'now_hold_ms', 'forecast_hours', 'forecast_max_age_h', 'site_range_km', 'blend_km', 'clutter_dbz', 'clutter_radius_px', 'echo_dbz', 'satellite_fade_dbz', 'watchdog_restart_min', 'watchdog_reload_min']) {
      c[k] = Number(c[k]);
      if (!Number.isFinite(c[k])) throw new Error(`wall-radar-card: ${k} must be a number`);
    }
    if (!['site', 'hybrid', 'composite'].includes(c.source)) throw new Error('wall-radar-card: source must be "hybrid", "site" or "composite"');
    if (!BASEMAPS[c.basemap] && c.basemap !== 'auto') throw new Error(`wall-radar-card: basemap must be one of ${Object.keys(BASEMAPS).join(', ')}, auto`);
    if (!BASEMAPS[c.day_basemap]) throw new Error(`wall-radar-card: day_basemap must be one of ${Object.keys(BASEMAPS).join(', ')}`);
    if (!BASEMAPS[c.night_basemap]) throw new Error(`wall-radar-card: night_basemap must be one of ${Object.keys(BASEMAPS).join(', ')}`);
    if (!PALETTES.includes(c.palette)) throw new Error(`wall-radar-card: palette must be one of ${PALETTES.join(', ')}`);
    // The centre and the site are optional: unset, they come from hass.config and the nearest site (_centre, _resolveSite).
    for (const k of ['center_latitude', 'center_longitude']) {
      if (c[k] === undefined || c[k] === null || c[k] === '') {
        delete c[k];
        continue;
      }
      c[k] = Number(c[k]);
      if (!Number.isFinite(c[k])) throw new Error(`wall-radar-card: ${k} must be a number`);
    }
    if (('center_latitude' in c) !== ('center_longitude' in c)) throw new Error('wall-radar-card: set both center_latitude and center_longitude, or neither');
    c.site = c.site ? String(c.site).toUpperCase() : '';
    c.frame_count = Math.max(1, Math.round(c.frame_count));
    c.detail = Math.max(0, Math.round(c.detail));
    c.home_position = homePosition(c.home_position);
    // HA re-sends an identical config on many re-renders; only rebuild when it changed.
    if (this._config && JSON.stringify(this._config) === JSON.stringify(c)) return;
    const rebuild = this._built;
    this._config = c;
    this._luts = null; // built by _setFade when the basemap is set (or on first use)
    this._fadeKey = null;
    this._site = undefined;
    if (rebuild) this._teardown();
    if (this.isConnected) {
      this._start();
      this._armWatchdog();
    }
  }

  set hass(hass) {
    this._hass = hass;
    // No centre in the config: the card is built once Home Assistant's own location is known.
    if (this._config && !this._built && this.isConnected && this._centre()) this._start();
    // basemap: auto follows sun.sun. Only the base tile layers change; the radar frames are untouched.
    if (this._config?.basemap === 'auto') this._setBasemap(wantedBasemap(this._config, hass?.states?.['sun.sun']?.state));
  }

  getCardSize() {
    const px = parseFloat(this._config?.height);
    return String(this._config?.height).endsWith('px') && px ? Math.ceil(px / 50) : 10;
  }

  connectedCallback() {
    clearTimeout(this._detachTimer);
    if (this._config) {
      this._start();
      this._armWatchdog();
    }
  }

  disconnectedCallback() {
    this._stopTimers();
    this._disarmWatchdog();
    // HA detaches and re-attaches cards on view switches; only free everything after a while.
    clearTimeout(this._detachTimer);
    this._detachTimer = setTimeout(() => {
      if (!this.isConnected) this._teardown();
    }, DETACHED_TEARDOWN_MS);
  }

  // ---- lifecycle ----------------------------------------------------------

  // The map centre: center_latitude / center_longitude, else Home Assistant's location. null until one is known.
  _centre() {
    const c = this._config;
    if ('center_latitude' in c) return [c.center_latitude, c.center_longitude];
    const h = this._hass?.config;
    if (h && h.latitude !== null && h.latitude !== undefined && h.longitude !== null && h.longitude !== undefined) {
      const at = [Number(h.latitude), Number(h.longitude)];
      if (at.every(Number.isFinite)) return at;
    }
    return null;
  }

  async _start() {
    if (this._built) {
      this._resume();
      return;
    }
    const at = this._centre();
    if (!at) return; // no centre yet: `set hass` starts the card when the location arrives
    this._home = at;
    this._built = true;
    const gen = (this._gen = (this._gen || 0) + 1);
    let L, css;
    try {
      [L, css] = await loadLeaflet();
    } catch (err) {
      // Nothing was built: the next connect, config change or watchdog tick tries again.
      console.warn('wall-radar-card: Leaflet did not load', err);
      if (gen === this._gen) this._built = false;
      return;
    }
    if (gen !== this._gen) return; // torn down or rebuilt while loading
    this.L = L;
    this._render(css);
    this._resume();
  }

  _render(css) {
    const c = this._config;
    const L = this.L;
    this.shadowRoot.innerHTML = `
      <style>${css}</style>
      <style>${CARD_CSS}</style>
      <ha-card style="height:${c.height}">
        <div id="color-bar" style="display:${c.show_color_bar ? '' : 'none'}; background:${colorBarGradient(c)}"></div>
        <div id="map"></div>
        ${c.show_progress ? '<div id="progress"><div id="progress-track"></div></div>' : ''}
        ${c.show_status ? '<div id="chip"></div>' : ''}
      </ha-card>`;
    this._chip = this.shadowRoot.getElementById('chip');
    this._progress = this.shadowRoot.getElementById('progress');
    if (this._progress) this._progress.style.top = c.show_color_bar ? '8px' : '0';
    const el = this.shadowRoot.getElementById('map');

    const map = L.map(el, {
      zoomSnap: 0,
      zoomControl: false,
      attributionControl: c.show_attribution,
      dragging: false,
      touchZoom: false,
      doubleClickZoom: false,
      scrollWheelZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
      fadeAnimation: false,
      zoomAnimation: false,
      inertia: false,
      trackResize: false, // a window listener would keep a detached card alive; ResizeObserver covers it
    }).setView(this._home, c.zoom_level);
    map.attributionControl?.setPrefix(false);
    map.createPane('radar').style.zIndex = 350;
    for (const [name, z] of [['warnings', 400], ['labels', 450]]) {
      const pane = map.createPane(name);
      pane.style.zIndex = z;
      pane.style.pointerEvents = 'none';
    }
    this._map = map;
    this._placeHome();

    this._seamlessLayer = L.TileLayer.extend({
      // Overlap each tile by 1px so fractional transforms never open a seam.
      // (_initTile is where Leaflet sizes the tile, so it has to be overridden there.)
      _initTile(tile) {
        L.TileLayer.prototype._initTile.call(this, tile);
        const size = this.getTileSize();
        tile.style.width = `${size.x + 1}px`;
        tile.style.height = `${size.y + 1}px`;
      },
      // Retry a failed tile once (IEM occasionally resets a connection under a burst).
      _tileOnError(done, tile, e) {
        if (tile._retried) return L.TileLayer.prototype._tileOnError.call(this, done, tile, e);
        tile._retried = true;
        const src = tile.src;
        setTimeout(() => { tile.src = src + (src.includes('?') ? '&' : '?') + 'retry=1'; }, TILE_RETRY_MS);
      },
    });

    // Radar tiles decoded to dBZ, composited, and recoloured into canvases.
    const card = this;
    this._radarLayer = this._seamlessLayer.extend({
      // No 1px overlap when radar pixels can be semi-transparent (smooth fade, RainViewer alpha):
      // an overlapping column would be drawn twice and show as a brighter line at every tile edge.
      // Hard-edged opaque palettes keep the overlap.
      _initTile(tile) {
        if (this.options.overlap) card._seamlessLayer.prototype._initTile.call(this, tile);
        else L.TileLayer.prototype._initTile.call(this, tile);
      },
      createTile(coords, done) {
        const tile = document.createElement('canvas');
        const size = Math.min(256, Math.round(this.getTileSize().x * (window.devicePixelRatio || 1)));
        tile.width = tile.height = size;
        tile.addEventListener('contextlost', () => (card._contextLost = true));
        tile.addEventListener('contextrestored', () => card._contextRestored());
        card._drawTile(this, coords, tile).then(
          () => done(null, tile),
          (err) => done(err, tile),
        );
        return tile;
      },
    });

    // `ink` tiles: recoloured once each into a canvas, by compositing (toneInkComposite), from a plain
    // <img>. No CORS fetch: Esri's CDN keys its cache on Origin, so CORS requests missed the cache and
    // about 1 in 500 got a 502 without CORS headers (a console error); plain requests share the CDN
    // cache. Never a CSS filter on the layer, which the compositor would re-run on every crossfade frame.
    this._tonedLayer = this._seamlessLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement('canvas');
        const size = Math.round(this.getTileSize().x * (window.devicePixelRatio || 1));
        tile.width = tile.height = size;
        tile.addEventListener('contextlost', () => (card._contextLost = true));
        tile.addEventListener('contextrestored', () => card._contextRestored());
        const url = this.getTileUrl(coords);
        const load = (src, retried) => {
          const img = new Image();
          img.onload = () => {
            toneInkComposite(tile.getContext('2d'), img, size);
            done(null, tile);
          };
          // One retry, as the other base layers do; then Leaflet's tile error.
          img.onerror = () => (retried ? done(new Error(`ink tile failed: ${url}`), tile) : setTimeout(() => load(`${url}${url.includes('?') ? '&' : '?'}retry=1`, true), TILE_RETRY_MS));
          img.src = src;
        };
        load(url, false);
        return tile;
      },
    });
    this._baseLayers = [];
    this._basemap = null;
    this._setBasemap(wantedBasemap(c, this._hass?.states?.['sun.sun']?.state));
    if (c.show_labels) {
      new this._seamlessLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png', {
        pane: 'labels',
        subdomains: 'abcd',
        attribution: LABELS_CREDIT,
      }).addTo(map);
    }
    map.attributionControl?.addAttribution(RADAR_CREDIT);
    if (c.warnings) this._warningsLayer = L.layerGroup().addTo(map);

    this._resizeObserver = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
      this._placeHome(); // keep home where home_position puts it
    });
    this._resizeObserver.observe(el);
  }

  _detailOptions() {
    const d = this._config.detail;
    return { tileSize: 256 / 2 ** d, zoomOffset: d };
  }

  // Draw the configured centre at home_position (fractions of the map area) instead of the middle.
  // Runs once on render, before any layer exists, and after every resize. The default [0.5, 0.5]
  // returns at once, so Leaflet's own setView and invalidateSize behave exactly as before.
  _placeHome() {
    const c = this._config;
    const map = this._map;
    const [fx, fy] = c.home_position;
    if (!map || (fx === 0.5 && fy === 0.5)) return;
    const size = map.getSize();
    if (!size.x || !size.y) return; // not laid out yet; the ResizeObserver calls this again
    const z = map.getZoom();
    const [dx, dy] = homeOffset(c.home_position, size.x, size.y);
    const home = map.project(this._home, z);
    // Within the map's size this is a plain pan (whole pixels), never a view reset.
    map.setView(map.unproject(home.add([dx, dy]), z), z, { animate: false });
  }

  // Show one basemap (a stack of tile layers, bottom first) in place of the current one. Base layers
  // sit in Leaflet's tile pane, below the radar, warnings and labels panes, so nothing else moves.
  _setBasemap(name) {
    if (!this._map || name === this._basemap) return;
    for (const layer of this._baseLayers) layer.remove();
    this._baseLayers = BASEMAPS[name].map((base) => this._baseLayer(base).addTo(this._map));
    this._basemap = name;
    this._setData('basemap', name); // for a parent card (Horizon's scrims)
    this._setData('credits', creditsFor(name, this._config.show_labels).join(' · ')); // data-credits: who to credit for what is on screen
    if (this._setFade(name)) this._refade();
  }

  // The colour lookups for the fade window that goes with `basemap` (fadeFor). Returns true when it changed.
  _setFade(basemap) {
    const c = this._config;
    const f = fadeFor(c, basemap);
    const key = `${f.min_dbz}/${f.fade_dbz}`;
    if (key === this._fadeKey) return false;
    this._fadeKey = key;
    const fc = { ...c, ...f };
    this._luts = { obs: colorLut(fc, false), forecast: colorLut(fc, true) };
    const bar = this.shadowRoot?.getElementById('color-bar');
    if (bar) bar.style.background = colorBarGradient(fc);
    return true;
  }

  // Redraw every loaded radar tile with the current colour lookups, after the fade changed with the basemap.
  // Each tile is drawn over in its own canvas, so nothing flickers; tiles still loading pick up the new lookups
  // by themselves. The redraws go through a queue with at most REFADE_CONCURRENCY in flight (each fetches one
  // or two sources), like the 3-frames-at-a-time preload. A newer swap drops the older swap's queued work, so
  // no tile is redrawn twice for one swap. Twice a day at most (basemap: auto with a satellite day map).
  _refade() {
    const cardGen = this._gen;
    const layers = [
      ...this._frames.map((f) => f.layer),
      ...this._pending.values(),
      ...(this._staged || []).map((f) => f.layer),
      ...(this._fcStaged || []).map((f) => f.layer),
    ];
    const jobs = [];
    for (const layer of layers) {
      if (!(layer instanceof this._radarLayer) || !layer._map) continue; // the undecoded v1 path has no fade
      const z = layer._getZoomForUrl();
      for (const t of Object.values(layer._tiles)) {
        if (t.loaded && t.el.tagName === 'CANVAS') jobs.push({ scan: layer.options.scan, z, x: t.coords.x, y: t.coords.y, canvas: t.el });
      }
    }
    // Replacing the queue drops an older swap's waiting work; its redraws still in flight finish, then take jobs
    // from this queue, so the number in flight never exceeds the cap.
    this._refadeQueue = jobs;
    const next = () => {
      if (cardGen !== this._gen) return; // torn down or rebuilt
      const job = this._refadeQueue.shift();
      if (!job) return;
      this._refadeActive = (this._refadeActive || 0) + 1;
      this._renderTile(job.scan, job.z, job.x, job.y)
        .then(
          (bmp) => {
            const ctx = job.canvas.getContext('2d');
            ctx.clearRect(0, 0, job.canvas.width, job.canvas.height);
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(bmp, 0, 0, job.canvas.width, job.canvas.height);
            bmp.close?.();
          },
          () => {}, // keep the old drawing
        )
        .finally(() => {
          if (cardGen !== this._gen) return; // the teardown already reset the count
          this._refadeActive--;
          next();
        });
    };
    for (let i = this._refadeActive || 0; i < REFADE_CONCURRENCY; i++) next();
  }

  // A lost 2D context (a GPU process crash or reset) comes back blank, and polls still succeed, so nothing else
  // would notice. Once restored, redraw every canvas tile: the ink base tiles through Leaflet, the radar tiles in
  // place through the _refade queue. Once per burst: every canvas fires its own event. A loss with no restore event
  // yet is redrawn when the page next becomes visible (_wake).
  _contextRestored() {
    if (this._redrawQueued) return;
    this._redrawQueued = true;
    const gen = this._gen;
    setTimeout(() => {
      this._redrawQueued = false;
      if (gen !== this._gen || !this._map) return;
      this._contextLost = false;
      for (const layer of this._baseLayers) if (layer instanceof this._tonedLayer) layer.redraw();
      this._refade();
    }, 500);
  }

  _baseLayer(base) {
    const Layer = base.tone ? this._tonedLayer : this._seamlessLayer;
    return new Layer(base.url, {
      ...this._detailOptions(),
      // maxUrlZoom caps the zoom in the tile URL: Leaflet adds zoomOffset (= detail) to maxNativeZoom.
      maxNativeZoom: base.maxUrlZoom === undefined ? base.maxNativeZoom : base.maxUrlZoom - this._config.detail,
      detectRetina: base.detectRetina ?? true,
      attribution: base.attribution,
      className: base.className || '',
    });
  }

  _resume() {
    if (!this._map) return;
    this._stopTimers();
    this._poll();
    if (this._config.warnings) this._pollWarnings();
    if (this._frames.length) this._scheduleNext(0);
  }

  _stopTimers() {
    clearTimeout(this._pollTimer);
    clearTimeout(this._loopTimer);
    clearTimeout(this._warnTimer);
    this._pollTimer = this._loopTimer = this._warnTimer = null;
  }

  _teardown() {
    this._stopTimers();
    this._resizeObserver?.disconnect();
    this._map?.remove();
    this._map = null;
    this._frames = [];
    this._pending.clear();
    this._queue = [];
    this._active = 0;
    this._staged = null;
    this._chip = null;
    this._progress = null;
    this._progressSplit = null;
    this._coords = undefined;
    this._site = undefined;
    this._fcStaged = null;
    this._warningFeatures = null;
    this._warningsLayer = null;
    this._baseLayers = [];
    this._basemap = null;
    this._refadeQueue = [];
    this._refadeActive = 0;
    this._holes.open.clear(); // the counts in data-holes stay
    if (this.dataset.holes) this._updateHoles();
    this._poster = null;
    this._mode = null;
    this._index = 0;
    this._built = false;
    this._gen = (this._gen || 0) + 1;
    for (const key of ['echoes', 'homeDbz', 'nowDbz', 'rainAt', 'rainPeakDbz', 'basemap', 'credits', 'site']) delete this.dataset[key];
    delete this.dataset.homeWarnings;
    this.shadowRoot.innerHTML = '';
  }

  // ---- watchdog -----------------------------------------------------------
  // The wall tablet's page is never reloaded, so the card heals itself. A poll chain that died (a throw after the
  // poll's try, a fetch that never settles) is restarted; no successful poll for watchdog_restart_min rebuilds the
  // card; for watchdog_reload_min, the page is reloaded (at most once per RELOAD_GUARD_MS). A successful poll is
  // one whose scan list (or composite) answered, never one with echoes: a dry sky is healthy. The failure clocks
  // count only time the watchdog saw: a tick that arrives late (timers frozen while the tablet slept) or the page
  // becoming visible restarts them and polls at once instead.

  _armWatchdog() {
    this._disarmWatchdog();
    if (!this._config.watchdog) return;
    this._wdEpoch = this._wdTick = Date.now();
    this._wdTimer = setInterval(() => this._watch(), WATCHDOG_MS);
    this._onWake = this._onWake || ((e) => this._wake(e));
    document.addEventListener('visibilitychange', this._onWake);
    window.addEventListener('pageshow', this._onWake);
    window.addEventListener('online', this._onWake);
  }

  _disarmWatchdog() {
    clearInterval(this._wdTimer);
    this._wdTimer = null;
    if (!this._onWake) return;
    document.removeEventListener('visibilitychange', this._onWake);
    window.removeEventListener('pageshow', this._onWake);
    window.removeEventListener('online', this._onWake);
  }

  // Back from hidden, from the back-forward cache, or back online: poll and step now.
  _wake(e) {
    if (e.type === 'visibilitychange' && document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (e.type !== 'online') this._wdEpoch = now; // time spent hidden is not time spent failing
    if (e.type !== 'online' && this._contextLost) this._contextRestored();
    if (!this._map || now - (this._pollStartedAt || 0) < WAKE_DEBOUNCE_MS) return;
    this._wdAct(e.type === 'visibilitychange' ? 'visible' : e.type);
    this._resume();
  }

  _watch() {
    try {
      const c = this._config;
      const now = Date.now();
      const late = now - this._wdTick > 3 * WATCHDOG_MS;
      this._wdTick = now;
      if (late) {
        this._wdEpoch = now;
        this._wdAct('wake');
        this._resume();
        return;
      }
      const okSince = Math.max(this._pollOkAt || 0, this._wdEpoch);
      if (c.watchdog_reload_min > 0 && now - okSince > c.watchdog_reload_min * 60000 && this._reloadPage(now)) return;
      if (c.watchdog_restart_min > 0 && now - Math.max(okSince, this._wdReinitAt || 0) > c.watchdog_restart_min * 60000) {
        this._wdReinitAt = now;
        this._wdAct('reinit');
        this._teardown();
        this._start();
        return;
      }
      // Dead: no poll has started for well past when the next one was due (a backoff of up to 30 min is not dead).
      // Without a map (Leaflet never loaded) nothing can poll: build it again instead.
      const started = Math.max(this._pollStartedAt || 0, this._wdEpoch, this._wdRestartAt || 0);
      if (now - started > Math.max(3 * POLL_MS, (this._pollDelay || POLL_MS) + 2 * POLL_MS)) {
        this._wdRestartAt = now; // a rebuild that polls nothing is not retried on every tick
        this._wdAct('restart');
        if (this._map) this._resume();
        else {
          this._teardown();
          this._start();
        }
      }
      this._updateChip(); // keeps data-status current while no poll finishes
    } catch (err) {
      console.warn('wall-radar-card: watchdog tick failed', err);
    }
  }

  // location.reload(), unless a watchdog reload happened within RELOAD_GUARD_MS on any page load (the time is kept
  // in localStorage). The time is written and read back first: storage that throws or does not keep it means no
  // reload, so the page can never reload in a loop.
  _reloadPage(now) {
    let stored = false;
    try {
      const last = Number(localStorage.getItem(RELOAD_KEY));
      if (!(Math.abs(now - last) < RELOAD_GUARD_MS)) {
        localStorage.setItem(RELOAD_KEY, String(now));
        stored = localStorage.getItem(RELOAD_KEY) === String(now);
      }
    } catch {
      stored = false;
    }
    if (!stored) {
      this._wdAct('reload-blocked');
      return false;
    }
    this._wdAct('reload');
    location.reload();
    return true;
  }

  // data-watchdog: the watchdog's last action and when (debugging only).
  _wdAct(action) {
    this._setData('watchdog', `${action} ${new Date().toISOString()}`);
  }

  // ---- tiles --------------------------------------------------------------

  // Render one radar tile of `layer` into its canvas: for createTile, and again for a hole (`hole`, from _retryHoles).
  // A tile whose every source failed is kept as a hole of its frame, so a later poll can ask for it again.
  async _drawTile(layer, coords, tile, hole) {
    const gen = this._gen;
    let bmp;
    try {
      bmp = await this._renderTile(layer.options.scan, layer._getZoomForUrl(), coords.x, coords.y, { fresh: !!hole, alive: () => gen === this._gen });
    } catch (err) {
      if (!hole && gen === this._gen) this._addHole(layer, coords, tile);
      throw err;
    }
    const ctx = tile.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, tile.width, tile.height);
    bmp.close?.();
  }

  // Holes: tiles of frames on the map whose every source failed, keyed by frame and Leaflet tile key, plus the
  // counts shown in data-holes.
  get _holes() {
    this.__holes = this.__holes || { open: new Map(), filled: 0, gaveUp: 0, retries: 0 };
    return this.__holes;
  }

  _addHole(layer, coords, tile) {
    const key = layer._tileCoordsToKey(coords);
    this._holes.open.set(`${layer.options.scan.key} ${key}`, { layer, coords, tile, key, attempts: 0, at: Date.now() });
    this._updateHoles();
  }

  // Ask again for the holes of frames in the loop, skipping the HTTP cache: at most HOLE_RETRIES_PER_POLL per call,
  // the least-tried first, then the newest observed frame (it holds "now"), then forecast frames soonest first; each
  // hole at most HOLE_ATTEMPTS times and not twice within HOLE_RETRY_GAP_MS. A filled tile is drawn into its own canvas,
  // so the frame is not rebuilt. Called at the start of each poll and never awaited: a retry is neither the poll's
  // success nor its failure, and schedules nothing of its own.
  _retryHoles() {
    const holes = this._holes;
    if (!holes.open.size) return;
    const inLoop = new Set(this._frames.map((f) => f.layer));
    const now = Date.now();
    const due = [];
    for (const [id, h] of holes.open) {
      // The frame left the map (rotated out, replaced, dropped) or Leaflet replaced the tile: nothing to fill.
      if (!h.layer._map || h.layer._tiles[h.key]?.el !== h.tile) holes.open.delete(id);
      else if (inLoop.has(h.layer) && !h.busy && now - h.at >= HOLE_RETRY_GAP_MS) due.push([id, h]);
    }
    const rank = ({ layer }) => (layer.options.scan.forecast ? -layer.options.scan.time : layer.options.scan.time);
    due.sort(([, a], [, b]) => a.attempts - b.attempts || rank(b) - rank(a));
    const gen = this._gen;
    for (const [id, h] of due.slice(0, HOLE_RETRIES_PER_POLL)) {
      h.busy = true;
      h.attempts++;
      h.at = now;
      holes.retries++;
      this._drawTile(h.layer, h.coords, h.tile, h).then(
        () => {
          if (gen !== this._gen) return;
          if (holes.open.delete(id)) holes.filled++;
          h.tile.classList.add('leaflet-tile-loaded'); // Leaflet shows a tile only with this class; an errored one lacks it
          this._updateHoles();
        },
        () => {
          if (gen !== this._gen) return;
          h.busy = false;
          if (h.attempts >= HOLE_ATTEMPTS && holes.open.delete(id)) holes.gaveUp++;
          this._updateHoles();
        },
      );
    }
    this._updateHoles();
  }

  // data-holes (debugging only, no UI): holes waiting, filled by a retry, given up, and retries made. Absent until
  // the first hole.
  _updateHoles() {
    const h = this._holes;
    this._setData('holes', `open=${h.open.size} filled=${h.filled} gaveup=${h.gaveUp} retries=${h.retries}`);
  }

  // One radar tile of one frame: decode every source to dBZ, composite, smooth, colour.
  async _renderTile(scan, z, x, y, opts) {
    const url = (s) => s.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    // Network and image decoding in parallel, off the main thread.
    const imgs = await Promise.allSettled(scan.sources.map((s) => fetchTile(url(s), opts).then((blob) => createImageBitmap(blob))));
    if (imgs.every((r) => r.status === 'rejected')) throw imgs[0].reason;
    return serial(() => this._composeTile(scan, imgs, z, x, y));
  }

  async _composeTile(scan, imgs, z, x, y) {
    const c = this._config;
    const B = buffers();
    const site = imgs[0].status === 'fulfilled' ? imgs[0].value : null;
    const mrms = imgs[1]?.status === 'fulfilled' ? imgs[1].value : null;
    let idx;
    if (site) {
      decodeInto(site, luts()[scan.sources[0].lut], B.site);
      idx = B.site;
      await yieldTask();
    }
    if (mrms) {
      decodeInto(mrms, luts()[scan.sources[1].lut], B.mrms);
      idx = B.mrms;
      await yieldTask();
    }
    if (site && mrms) {
      this._hybridInto(B.site, B.mrms, z, x, y, B.out);
      idx = B.out;
      await yieldTask();
    }
    let field = idx;
    if (c.smooth) {
      // Interpolate the dBZ field before colouring. No data counts as -10 dBZ, below the fade,
      // so echo edges fade out instead of stopping at a hard pixel boundary.
      const f = B.f0;
      for (let i = 0; i < N; i++) f[i] = idx[i] || SMOOTH_NODATA;
      boxBlurInto(f, SMOOTH_RADIUS, B.f1, B.f2);
      boxBlurInto(B.f2, SMOOTH_RADIUS, B.f1, B.f0);
      field = B.f0;
      await yieldTask();
    }
    this._recordTile(scan, field, z, x, y); // numbers only (never pixels), from the field as drawn
    if (!this._luts) this._setFade(this._basemap);
    const lut = scan.forecast ? this._luts.forecast : this._luts.obs;
    const px = B.img.data;
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      const v = c.smooth ? Math.round(field[i]) : field[i];
      const q = (v > 255 ? 255 : v) * 4;
      px[p] = lut[q];
      px[p + 1] = lut[q + 1];
      px[p + 2] = lut[q + 2];
      px[p + 3] = lut[q + 3];
    }
    return createImageBitmap(B.img);
  }

  // Keep numbers, never pixels, from one tile's dBZ field as drawn (after the clutter cleanup and the
  // smoothing): echo pixels inside the current view, and the dBZ at the configured centre if the tile
  // holds it. The shared buffers are reused by the next tile, so nothing else may be kept.
  _recordTile(scan, field, z, x, y) {
    const map = this._map;
    if (!map) return;
    const c = this._config;
    const k = 2 ** (z - map.getZoom());
    const b = map.getPixelBounds();
    const view = { minX: b.min.x * k, minY: b.min.y * k, maxX: b.max.x * k, maxY: b.max.y * k };
    const home = sourcePixel(this._home[0], this._home[1], z);
    scan.tiles = scan.tiles || new Map();
    scan.tiles.set(`${x}/${y}`, tileNumbers(field, x, y, view, home, echoIndex(c.echo_dbz)));
  }

  // Site data inside site_range_km, MRMS beyond it and in the site's gaps, blended across blend_km.
  // Weak site echoes with no MRMS echo nearby are clutter and are dropped.
  _hybridInto(site, mrms, z, x, y, out) {
    const c = this._config;
    const B = buffers();
    const coords = this._coords;
    const R = c.site_range_km;
    const far = R + c.blend_km;
    let span = { min: 0, max: 0 };
    if (coords) span = tileOffsets(z, x, y, coords.lat, coords.lon, B.dx, B.dy);
    const clutterIdx = c.clutter_dbz > -32 ? Math.round((c.clutter_dbz + 32) * 2) : 0;
    if (clutterIdx) dilateInto(mrms, c.clutter_radius_px, B.tmp8, B.near);
    const near = B.near;
    const allSite = span.max <= R;
    const allMrms = span.min >= far;
    let dropped = 0;
    for (let i = 0; i < N; i++) {
      let s = site[i];
      const m = mrms[i];
      if (s && s < clutterIdx && !near[i]) {
        s = 0;
        dropped++;
      }
      let w = 1;
      if (allMrms) w = 0;
      else if (!allSite) {
        const d = Math.hypot(B.dx[i & 255], B.dy[i >> 8]);
        w = d <= R ? 1 : d >= far ? 0 : 1 - (d - R) / c.blend_km;
      }
      if (!w || !s) out[i] = m;
      else if (w === 1 || !m) out[i] = s;
      else out[i] = Math.round(w * s + (1 - w) * m);
    }
    this._stats.clutterDropped += dropped;
  }

  _siteCoords() {
    const c = this._config;
    if (Number.isFinite(Number(c.site_latitude)) && Number.isFinite(Number(c.site_longitude)) && c.site_latitude !== null) {
      return Promise.resolve({ lat: Number(c.site_latitude), lon: Number(c.site_longitude) });
    }
    return lookupSite(this._site);
  }

  // The radar site: `site`, else the NEXRAD site nearest the centre. A failed lookup throws, which the poll treats
  // like an unreachable site feed (the national composite stands in) and tries again on the next poll.
  async _resolveSite() {
    if (this._site) return this._site;
    const c = this._config;
    const gen = this._gen;
    const id = c.site || nearestSite(await sites(), this._home[0], this._home[1]);
    if (!id) throw new Error('no NEXRAD site found near the centre');
    if (gen === this._gen) {
      this._site = id;
      this._setData('site', id); // data-site: the site in use (debugging, and how an installer confirms the pick)
    }
    return id;
  }

  get _stats() {
    this.__stats = this.__stats || { clutterDropped: 0 };
    return this.__stats;
  }

  // ---- data ---------------------------------------------------------------

  async _poll() {
    const gen = this._gen;
    const c = this._config;
    let ok = true;
    this._pollStartedAt = Date.now();
    try {
      this._retryHoles();
    } catch (err) {
      console.warn('wall-radar-card: hole retry failed', err);
    }
    try {
      if (c.source === 'composite') {
        await this._pollComposite(gen);
      } else {
        await this._resolveSite();
        if (gen !== this._gen) return;
        const scans = await this._fetchScans();
        const newest = scans.length ? new Date(scans[scans.length - 1].time) : null;
        if (!newest || Date.now() - newest.getTime() > STALE_MIN * 60000) {
          await this._pollComposite(gen);
        } else {
          if (c.source === 'hybrid') {
            await this._addMrms(scans);
            // Resolved before any tile renders, so no tile waits on it.
            if (this._coords === undefined) this._coords = await this._siteCoords();
          }
          if (gen !== this._gen) return;
          this._setMode(c.source);
          this._sync(scans);
        }
      }
    } catch (err) {
      ok = false;
      console.warn('wall-radar-card: poll failed, keeping last frames', err);
      // Site feed unreachable: if nothing fresh is on screen, or the composite is already
      // standing in, (re)load the composite. A later successful scan list hands back to the site.
      const newest = this._frames.filter((f) => !f.forecast).pop();
      const stale = !newest || Date.now() - newest.time > STALE_MIN * 60000;
      if (c.source !== 'composite' && (stale || this._mode === 'composite')) {
        try {
          await this._pollComposite(gen);
          ok = true;
        } catch (err2) {
          console.warn('wall-radar-card: composite fallback failed', err2);
        }
      }
    }
    if (ok) this._pollOkAt = Date.now(); // the network answered (echoes or not): what the watchdog counts
    if (gen !== this._gen) return; // torn down or rebuilt while this poll was in flight
    try {
      if (c.forecast_hours > 0) await this._pollForecast(gen);
      if (gen !== this._gen) return;
      this._backoff = ok ? 0 : Math.min(this._backoff ? this._backoff * 2 : POLL_MS, MAX_BACKOFF_MS);
      this._updateChip();
    } catch (err) {
      // Whatever went wrong here, the next poll is still scheduled.
      console.warn('wall-radar-card: poll step failed', err);
    }
    if (gen !== this._gen) return;
    if (this.isConnected && this._map) {
      clearTimeout(this._pollTimer);
      this._pollDelay = this._backoff || POLL_MS;
      this._pollTimer = setTimeout(() => this._poll(), this._pollDelay);
    }
  }

  _fetchJson(url) {
    return fetchTimed(url, { cache: 'no-store' }, (r) => r.json());
  }

  async _fetchScans() {
    const end = new Date();
    const start = new Date(end.getTime() - HISTORY_MIN * 60000);
    const q = new URLSearchParams({ operation: 'list', product: 'N0B', radar: this._site, start: isoMinute(start), end: isoMinute(end) });
    const data = await this._fetchJson(`${IEM}/json/radar.py?${q}`);
    const site = this._site;
    return (data.scans || [])
      .map((s) => ({
        key: s.ts,
        time: Date.parse(s.ts.replace(/Z$/, ':00Z')),
        sources: [{ url: `${TILE}/ridge::${site}-N0B-${s.ts.replace(/\D/g, '')}/{z}/{x}/{y}.png`, lut: 'n0q' }],
      }))
      .sort((a, b) => a.time - b.time)
      .slice(-this._config.frame_count);
  }

  // Pair every site scan with the MRMS lcref frame closest in time at or before it (2-minute cadence).
  async _addMrms(scans) {
    let latest = Infinity;
    try {
      const meta = await this._fetchJson(`${IEM}/data/gis/images/4326/mrms/lcref.json`);
      latest = Date.parse(meta.meta.start_valid) || Infinity;
    } catch (err) {
      console.warn('wall-radar-card: MRMS metadata unavailable, pairing by scan time', err);
    }
    for (const s of scans) {
      const t = Math.min(Math.floor(s.time / 120000) * 120000, latest);
      if (s.time - t > MRMS_MAX_LAG_MIN * 60000) continue; // site only for this scan
      s.sources.push({ url: `${TILE}/mrms::lcref-${stamp(t)}/{z}/{x}/{y}.png`, lut: 'lcref' });
    }
  }

  async _pollComposite(gen = this._gen) {
    const meta = await this._fetchJson(`${IEM}/data/gis/images/4326/USCOMP/n0q_0.json`);
    const valid = Date.parse(meta.meta.valid);
    if (!Number.isFinite(valid)) throw new Error('composite: no valid time');
    // Offset layer names are relative to "now", so every composite frame key carries the valid time.
    const scans = COMPOSITE_OFFSETS.slice(-this._config.frame_count).map((m) => ({
      key: `${meta.meta.valid}-${m}`,
      time: valid - m * 60000,
      sources: [{ url: `${TILE}/nexrad-n0q-900913${m ? `-m${String(m).padStart(2, '0')}m` : ''}/{z}/{x}/{y}.png?v=${valid}`, lut: 'n0q' }],
    }));
    if (gen !== this._gen) return;
    this._setMode('composite');
    this._sync(scans);
  }

  // HRRR simulated reflectivity, 15-minute steps from now to now + forecast_hours.
  // Hidden entirely when the latest run is older than forecast_max_age_h (capped at 8 h).
  async _pollForecast(gen) {
    const c = this._config;
    let wanted = [];
    try {
      const meta = await this._fetchJson(c.forecast_meta_url || `${IEM}/data/gis/images/4326/hrrr/refd_0000.json`);
      const init = Date.parse(meta.model_init_utc);
      const now = Date.now();
      if (Number.isFinite(init) && now - init <= Math.min(c.forecast_max_age_h, 8) * 3600000) {
        for (let m = 0; m <= 18 * 60; m += 15) {
          const t = init + m * 60000;
          if (t <= now) continue;
          if (t > now + c.forecast_hours * 3600000) break;
          wanted.push({
            key: `F|${stamp(init)}|${m}`,
            time: t,
            forecast: true,
            sources: [{ url: `${TILE}/hrrr::REFD-F${String(m).padStart(4, '0')}-${stamp(init)}/{z}/{x}/{y}.png`, lut: 'n0q' }],
          });
        }
      }
    } catch (err) {
      console.warn('wall-radar-card: forecast metadata unavailable', err);
      // Keep what we have, minus anything that is no longer in the future.
      wanted = this._frames.filter((f) => f.forecast && f.time > Date.now()).map((f) => ({ key: f.key }));
    }
    if (gen !== this._gen) return;
    this._syncForecast(wanted);
  }

  // Frames of a new HRRR run are staged and swapped in once they have all loaded; until then the
  // previous run keeps looping. Frames that are no longer in the future, and the whole forecast
  // when the run is stale (nothing wanted), go at once.
  _syncForecast(wanted) {
    const keys = new Set(wanted.map((s) => s.key));
    this._forecastKeys = keys;
    for (const [key, layer] of this._pending) {
      if (layer.options.scan.forecast && !keys.has(key)) {
        layer.remove();
        this._pending.delete(key);
      }
    }
    const have = new Set([...this._frames.map((f) => f.key), ...this._pending.keys()]);
    const fresh = wanted.filter((s) => s.sources && !have.has(s.key));
    const now = Date.now();
    this._dropForecast((f) => !keys.size || f.time <= now || (!fresh.length && !this._fcStaged && !keys.has(f.key)));
    this._updateSummaries();
    if (fresh.length) {
      this._fcStaged = this._fcStaged || [];
      fresh.forEach((s) => this._preload(s));
    }
  }

  _dropForecast(pred) {
    const before = this._frames.length;
    this._frames = this._frames.filter((f) => {
      if (!f.forecast || !pred(f)) return true;
      f.layer.remove();
      return false;
    });
    if (this._frames.length !== before) this._index = Math.min(this._index, Math.max(0, this._frames.length - 1));
  }

  _setMode(mode) {
    if (this._mode === mode) return;
    for (const [key, layer] of this._pending) {
      if (layer.options.scan.forecast) continue;
      layer.remove();
      this._pending.delete(key);
    }
    this._mode = mode;
    this._replaceNext = true;
  }

  // Bring the observed frame set in line with `scans`. New frames preload at opacity 0.
  // Incremental (site/hybrid): each new scan joins the loop once loaded and the oldest drops.
  // Replace (source switch, or a new composite cycle, whose offset layers all move):
  // the old frames keep animating until the whole new set has loaded, then swap at once.
  _sync(scans) {
    const have = new Set([...this._frames.map((f) => f.key), ...this._pending.keys()]);
    const fresh = scans.filter((s) => !have.has(s.key));
    if (!fresh.length) return;
    if (this._replaceNext || this._mode === 'composite') {
      this._replaceNext = false;
      for (const [key, layer] of this._pending) {
        if (layer.options.scan.forecast) continue;
        layer.remove();
        this._pending.delete(key);
      }
      this._staged = [];
      // Newest first, so it can stand in as a still image while the rest load.
      scans.slice().reverse().forEach((s) => this._preload(s));
    } else {
      fresh.forEach((s) => this._preload(s));
    }
  }

  _preload(scan) {
    const c = this._config;
    // v1's exact unfiltered look: plain image tiles, no decoding.
    const plain = c.palette === 'n0q' && !c.smooth && c.min_dbz <= -32 && scan.sources.length === 1;
    const opts = {
      ...this._detailOptions(),
      scan,
      pane: 'radar',
      opacity: 0,
      detectRetina: c.radar_retina,
      maxNativeZoom: 12,
      keepBuffer: 0,
      overlap: !c.smooth && c.fade_dbz <= c.min_dbz && (c.palette === 'n0q' || c.palette === 'nws'),
    };
    const layer = plain ? new this._seamlessLayer(scan.sources[0].url, opts) : new this._radarLayer('', opts);
    let loaded = 0;
    let failed = 0;
    layer.on('tileload', () => loaded++);
    layer.on('tileerror', () => failed++);
    layer.on('tileunload', (e) => scan.tiles?.delete(`${e.coords.x}/${e.coords.y}`));
    let timer;
    let finished = false;
    const gen = this._gen;
    // Runs once, from whichever comes first: the layer's 'load' or the timeout.
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      layer.off('load', finish);
      if (gen !== this._gen) return; // card was torn down since
      this._active--;
      this._pump();
      if (this._pending.get(scan.key) !== layer) return;
      this._pending.delete(scan.key);
      if (!loaded) {
        // No tile arrived (all failed, or none within the timeout): never loop a blank frame.
        // It is not in the frame set, so the next poll that still lists it tries it again.
        // Deferred: removing the layer inside its own 'load' event breaks Leaflet's handler.
        queueMicrotask(() => layer.remove());
      } else {
        this._addFrame({ key: scan.key, time: scan.time, forecast: !!scan.forecast, layer });
        if (!scan.forecast && !this._frames.length && !this._poster) {
          this._poster = layer;
          layer.setOpacity(c.opacity);
        }
      }
      this._settle();
    };
    this._pending.set(scan.key, layer);
    this._queue.push(() => {
      if (this._pending.get(scan.key) !== layer || !this._map) return false;
      timer = setTimeout(finish, FRAME_LOAD_TIMEOUT_MS);
      layer.once('load', finish);
      layer.addTo(this._map);
      return true;
    });
    this._pump();
  }

  // Load a few frames at a time rather than every tile of every frame at once.
  _pump() {
    while (this._active < PRELOAD_CONCURRENCY && this._queue.length) {
      if (this._queue.shift()()) this._active++;
    }
  }

  _addFrame(frame) {
    if (frame.forecast && this._fcStaged) {
      this._fcStaged.push(frame);
      return;
    }
    if (this._staged && !frame.forecast) {
      this._staged.push(frame);
      return;
    }
    this._frames.push(frame);
    this._frames.sort((a, b) => a.time - b.time);
    let obs = this._frames.filter((f) => !f.forecast).length;
    while (obs > this._config.frame_count) {
      const i = this._frames.findIndex((f) => !f.forecast);
      this._frames.splice(i, 1)[0].layer.remove();
      this._index = Math.max(0, this._index - 1);
      obs--;
    }
  }

  // Called after every preload settles (loaded, failed or timed out).
  _settle() {
    const obsPending = [...this._pending.values()].some((l) => !l.options.scan.forecast);
    if (this._staged && !obsPending) {
      if (this._staged.length) {
        for (const f of this._frames) if (!f.forecast) f.layer.remove();
        this._frames = this._staged.concat(this._frames.filter((f) => f.forecast)).sort((a, b) => a.time - b.time);
        this._index = this._frames.length - 1;
      }
      this._staged = null;
      this._poster = null;
    }
    const fcPending = [...this._pending.values()].some((l) => l.options.scan.forecast);
    if (this._fcStaged && !fcPending) {
      // The new run is complete: drop every forecast frame it does not include, then swap it in.
      // If none of its frames loaded (e.g. all tiles 503), keep the run already on screen.
      if (this._fcStaged.length) {
        const keys = this._forecastKeys || new Set();
        this._dropForecast((f) => !keys.has(f.key));
        this._frames = this._frames.concat(this._fcStaged).sort((a, b) => a.time - b.time);
      }
      this._fcStaged = null;
    }
    // The loop starts only once every frame of the set has loaded.
    if (!this._loopTimer && !this._pending.size && this._frames.length) {
      this._index = this._frames.length - 1; // first step shows the oldest frame
      this._scheduleNext(0);
    }
    this._updateSummaries();
    this._updateChip();
  }

  // ---- warnings -----------------------------------------------------------

  async _pollWarnings() {
    const gen = this._gen;
    try {
      const data = await this._fetchJson(this._config.warnings_url || `${IEM}/geojson/sbw.geojson`);
      this._warningFeatures = data.features || [];
    } catch (err) {
      console.warn('wall-radar-card: warnings unavailable, keeping the last set until each expires', err);
    }
    if (gen !== this._gen || !this._warningsLayer) return;
    this._drawWarnings();
    if (!this.isConnected) return;
    clearTimeout(this._warnTimer);
    this._warnTimer = setTimeout(() => this._pollWarnings(), WARNINGS_POLL_MS);
  }

  _drawWarnings() {
    const L = this.L;
    const view = this._map.getBounds();
    const now = Date.now();
    this._warningsLayer.clearLayers();
    let drawn = 0;
    for (const f of this._warningFeatures || []) {
      const p = f.properties || {};
      const color = p.significance === 'W' && WARNING_COLORS[p.phenomena];
      if (!color) continue;
      // Each polygon disappears at its own expiry, even if the feed stops answering.
      const expires = Date.parse(p.expire_utc || p.expire);
      if (Number.isFinite(expires) && expires <= now) continue;
      const shape = L.geoJSON(f, {
        pane: 'warnings',
        interactive: false,
        style: { color, weight: 2, opacity: 0.95, fill: false },
      });
      if (!shape.getBounds().intersects(view)) continue;
      shape.addTo(this._warningsLayer);
      drawn++;
    }
    this.dataset.warnings = String(drawn);
    // data-home-warnings: absent until the feed has answered once, '' while nothing covers home.
    if (this._warningFeatures) {
      const c = this._config;
      const home = homeWarnings(this._warningFeatures, this._home[1], this._home[0], now);
      this._setData('homeWarnings', home.length ? JSON.stringify(home) : '');
    }
  }

  // ---- animation ----------------------------------------------------------

  _scheduleNext(delay) {
    clearTimeout(this._loopTimer);
    this._loopTimer = setTimeout(() => this._step(), delay);
  }

  _step() {
    const c = this._config;
    const frames = this._frames;
    if (!frames.length || !this.isConnected) {
      this._loopTimer = null;
      return;
    }
    let delay = c.frame_delay;
    try {
      this._index = (this._index + 1) % frames.length;
      const cur = frames[this._index];
      const last = this._index === frames.length - 1;
      const nowFrame = !cur.forecast && (last || frames[this._index + 1].forecast);
      if (nowFrame && c.now_hold_ms > 0) delay = c.now_hold_ms;
      if (last) delay = Math.max(delay === c.frame_delay ? 0 : delay, c.restart_delay);
      // Crossfade: the outgoing and incoming frames fade over at most the time this frame is shown.
      const fade = Math.min(c.transition_ms, delay);
      this._map.getPane('radar').style.setProperty('--xfade', `${fade}ms`);
      frames.forEach((f, i) => f.layer.setOpacity(i === this._index ? c.opacity * (f.forecast ? FORECAST_OPACITY : 1) : 0));
      this.dataset.frame = String(this._index);
      this.dataset.frames = String(frames.length);
      this.dataset.forecastFrames = String(frames.filter((f) => f.forecast).length);
      this.dataset.frameTime = new Date(cur.time).toISOString();
      this.dataset.frameKind = cur.forecast ? 'forecast' : 'observed';
      const n = frameNumbers(cur.layer.options.scan.tiles);
      this._setData('echoes', n.echoes === undefined ? '' : String(n.echoes));
      this._setData('homeDbz', n.home === undefined ? '' : String(n.home));
      this._updateProgress();
    } catch (err) {
      console.warn('wall-radar-card: frame step failed', err);
    } finally {
      // Whatever went wrong above, the loop keeps running.
      this._scheduleNext(delay);
    }
  }

  _updateProgress() {
    if (!this._progress) return;
    const n = this._frames.length;
    const obs = this._frames.filter((f) => !f.forecast).length;
    const split = `<div class="obs" style="width:${(obs / n) * 100}%"></div><div class="fc" style="width:${((n - obs) / n) * 100}%"></div>`;
    if (this._progressSplit !== split) {
      this._progressSplit = split;
      this._progress.innerHTML = `<div id="progress-track" style="position:absolute;inset:0;display:flex">${split}</div><div id="progress-fill" style="position:absolute;inset:0;display:flex">${split}</div>`;
    }
    const fill = this._progress.querySelector('#progress-fill');
    if (!fill) {
      this._progressSplit = null; // rebuilt on the next step
      return;
    }
    fill.style.clipPath = `inset(0 ${(100 - ((this._index + 1) / n) * 100).toFixed(2)}% 0 0)`;
  }

  // The status text is always computed (and exposed as data-status); the chip shows it only with show_status.
  _updateChip() {
    const newest = this._frames.filter((f) => !f.forecast).pop();
    const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    let text = '';
    if (!newest) {
      text = this._pending.size ? '' : 'Radar unavailable';
    } else if (Date.now() - newest.time > STALE_MIN * 60000) {
      text = `Radar ${fmt(newest.time)} · ${Math.round((Date.now() - newest.time) / 60000)} min old`;
      // Older than the scan list's whole window, and nothing has answered for two poll periods.
      if (Date.now() - newest.time > HISTORY_MIN * 60000 && !(Date.now() - this._pollOkAt < 2 * POLL_MS)) text += ' · polls failing';
    } else if (this._mode === 'composite' && this._config.source !== 'composite') {
      text = `${this._site || 'Radar site'} offline · composite ${fmt(newest.time)}`;
    }
    this.dataset.status = text;
    if (this._chip) {
      this._chip.textContent = text;
      this._chip.classList.toggle('show', !!text);
    }
    this.dataset.mode = this._mode || '';
  }

  // data-now-dbz / data-rain-at / data-rain-peak-dbz, refreshed whenever the frame set changes.
  _updateSummaries() {
    const frames = this._frames.map((f) => ({ time: f.time, forecast: f.forecast, home: frameNumbers(f.layer.options.scan.tiles).home }));
    const s = summarize(frames, this._config.echo_dbz);
    this._setData('nowDbz', s.nowDbz);
    this._setData('rainAt', s.rainAt);
    this._setData('rainPeakDbz', s.rainPeakDbz);
    if (!frames.length) {
      this._setData('echoes', '');
      this._setData('homeDbz', '');
    }
  }

  // Write a data-* attribute only when its value changes, so observers are not woken for nothing.
  _setData(key, value) {
    if (this.dataset[key] !== value) this.dataset[key] = value;
  }
}

// The other two cards, loaded from this file's folder with this file's own query string: HACS registers only this
// file and bumps its ?hacstag= on every update, so one resource entry loads (and cache-busts) all three cards.
// Not awaited: the radar card is defined first and never waits for, or fails with, a sibling. Resolves when done.
const SIBLINGS = [['wall-horizon-card', 'WallHorizonCard'], ['wall-thermostat-card', 'WallThermostatCard']];
let siblingsLoaded;

if (globalThis.customElements) {
  // A second copy (e.g. the resource listed under two ?v= values) must not throw.
  if (!customElements.get('wall-radar-card')) {
    customElements.define('wall-radar-card', WallRadarCard);
    window.customCards = window.customCards || [];
    window.customCards.push({
      type: 'wall-radar-card',
      name: 'Wall Radar Card',
      description: 'NEXRAD radar loop (IEM): super-res site radar + MRMS, HRRR forecast, NWS warnings.',
    });
  }
  // The siblings load even when another copy defined the radar card first: that copy may be a cached 1.1.x one
  // (a second radar entry left by the upgrade), which loads nothing. Their defines are guarded, so a second load
  // only costs a request.
  siblingsLoaded = Promise.allSettled(SIBLINGS.map(([tag]) => import(new URL(`${tag}.js${VERSION}`, BASE).href))).then((results) => {
    const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${SIBLINGS[i][0]}.js (${r.reason?.message ?? r.reason})`] : []));
    if (failed.length) console.warn(`wall-radar-card: could not load ${failed.join(', ')}; the radar card works without them`);
    // A card defined by another copy first (an extra resource entry left from radar-dash 1.1.x) wins over this one.
    const other = results.flatMap((r, i) => {
      const [tag, name] = SIBLINGS[i];
      return r.status === 'fulfilled' && r.value[name] && customElements.get(tag) !== r.value[name] ? [tag] : [];
    });
    if (customElements.get('wall-radar-card') !== WallRadarCard) console.warn('wall-radar-card: wall-radar-card came from another resource entry, which may be an old copy. Keep one wall-radar-card.js resource entry (with HACS, the first one) and delete the other');
    else if (other.length) console.warn(`wall-radar-card: ${other.join(' and ')} came from another resource entry, which may be an old copy. Since radar-dash 1.2.0 this file loads every card: remove the extra ${other.map((t) => `${t}.js`).join(' and ')} resource entry`);
  });
}

export { WallRadarCard, N0Q_PALETTE, LCREF_PALETTE, siblingsLoaded };
