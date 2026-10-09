// wall-radar-layers: optional overlays for wall-radar-card, and the Layers picker that switches them.
// Loaded by the card only when its config asks for `layers` or `show_layer_picker`; a card without them never
// requests this file. Every layer is added to the card's own Leaflet map and goes away with it.
//
// Sources (all free, no key):
// - clouds: NOAA GOES GeoColor, masked with GOES infrared, via NASA GIBS. A new image every 10 min (~45 min behind).
// - wind: Open-Meteo's current 10 m wind on a grid over the view, drawn as drifting streaks. Hourly.
// - lightning: Blitzortung.org's live strike stream (a websocket, only while the layer is on and the page visible).
// - fires: NIFC's interagency feed (WFIGS incidents and perimeters). Every 10 min.
// - smoke: NOAA HMS smoke plumes. HMS sends no CORS headers, so it needs `hms_url`: a copy you serve yourself
//   (examples/hms/). With `hms_url`, the fires layer also shows HMS satellite fire detections.
// - quakes: USGS, M2.5+ in the last day. Every 5 min.
//
// Performance: one fetch per source, shared by every card on the page; a layer that is off fetches nothing; the two
// animated ones (wind, lightning) draw on one canvas each and do no work while the page is hidden or the card is
// detached.

const STORE_KEY = 'wall-radar-card:layers';

// [key, label, icon], in the picker's order. `rain` is the card's own radar.
export const LAYERS = [
  ['rain', 'Rain', 'mdi:radar'],
  ['clouds', 'Clouds', 'mdi:weather-cloudy'],
  ['wind', 'Wind', 'mdi:weather-windy'],
  ['lightning', 'Lightning', 'mdi:flash'],
  ['fires', 'Fires', 'mdi:fire'],
  ['smoke', 'Smoke', 'mdi:weather-hazy'],
  ['quakes', 'Earthquakes', 'mdi:pulse'],
];
export const LAYER_KEYS = LAYERS.map(([k]) => k);

// Each overlay: its pane's z-index (the radar is 350, warnings 400, labels 450), its credit line, and its maker.
const OVERLAYS = {
  clouds: { z: 300, credit: 'Clouds: NOAA GOES via NASA GIBS', make: cloudLayer },
  smoke: { z: 320, credit: 'Smoke: NOAA HMS', make: smokeLayer, needsHms: true },
  wind: { z: 380, credit: 'Wind: Open-Meteo', make: windLayer },
  quakes: { z: 410, credit: 'Earthquakes: USGS', make: quakeLayer },
  fires: { z: 420, credit: 'Fires: NIFC', hmsCredit: 'Fire detections: NOAA HMS', make: fireLayer },
  lightning: { z: 430, credit: 'Lightning: Blitzortung.org', make: lightningLayer },
};

// Which layers start on: rain, plus the config's `layers`, then the picker's last choice in this browser.
export function initialLayers(c, stored) {
  const on = Object.fromEntries(LAYER_KEYS.map((k) => [k, k === 'rain' || (c.layers || []).includes(k)]));
  if (c.show_layer_picker && stored && typeof stored === 'object') {
    for (const k of LAYER_KEYS) if (typeof stored[k] === 'boolean') on[k] = stored[k];
  }
  if (!c.hms_url) on.smoke = false;
  return on;
}

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    return null;
  }
}
function writeStore(on) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(on));
  } catch {
    /* storage off: the choice lasts until the page reloads */
  }
}

// Called by the card each time it builds its map. Returns { remove }.
export function attachLayers(card, map, L, c) {
  const s = { card, map, L, c, timers: [], live: {}, on: initialLayers(c, readStore()) };
  const root = card.shadowRoot;
  root.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));
  for (const [name, o] of Object.entries(OVERLAYS)) {
    const pane = map.createPane(`rl-${name}`);
    pane.style.zIndex = o.z;
    pane.style.pointerEvents = 'none';
  }
  const apply = () => {
    const radar = map.getPane('radar');
    if (radar) radar.style.display = s.on.rain ? '' : 'none';
    for (const [key, o] of Object.entries(OVERLAYS)) {
      const want = s.on[key] && (!o.needsHms || c.hms_url);
      if (want && !s.live[key]) {
        s.live[key] = o.make(s);
        credit(s, o.credit, true);
        if (o.hmsCredit && c.hms_url) credit(s, o.hmsCredit, true);
      } else if (!want && s.live[key]) {
        s.live[key].remove();
        s.live[key] = null;
        credit(s, o.credit, false);
        if (o.hmsCredit) credit(s, o.hmsCredit, false);
      }
    }
  };
  const picker = c.show_layer_picker ? layerPicker(s, (key) => {
    s.on = { ...s.on, [key]: !s.on[key] };
    writeStore(s.on);
    apply();
  }) : null;
  apply();
  const remove = () => {
    s.timers.forEach(clearInterval);
    s.timers = [];
    for (const k in s.live) s.live[k]?.remove();
    s.live = {};
    picker?.remove();
  };
  map.on('unload', remove);
  return { remove, get on() { return { ...s.on }; } };
}

function credit(s, text, on) {
  const a = s.map.attributionControl;
  if (a) on ? a.addAttribution(text) : a.removeAttribution(text);
}

// The picker: a round button in the top right corner and a panel of tiles. Hovering opens it, leaving closes it
// after a short grace, and a click pins it open (or closes it). On a touch screen a tap opens and closes it.
function layerPicker(s, toggle) {
  const card = s.card.shadowRoot.querySelector('ha-card') || s.card.shadowRoot;
  const el = document.createElement('div');
  el.className = 'rl-picker';
  card.appendChild(el);
  let open = false;
  let pinned = false;
  let timer = 0;
  const offered = LAYERS.filter(([k]) => k !== 'smoke' || s.c.hms_url);
  const render = () => {
    el.innerHTML = `
      <button type="button" class="rl-pbtn" aria-label="Map layers" aria-expanded="${open}"><ha-icon icon="mdi:layers"></ha-icon></button>
      ${open ? `<div class="rl-panel"><div class="rl-phead">Map layers</div><div class="rl-pgrid">${offered.map(([k, label, icon]) => `
        <button type="button" data-k="${k}" aria-pressed="${!!s.on[k]}"><span class="rl-tile"><ha-icon icon="${icon}"></ha-icon></span><span>${label}</span></button>`).join('')}
      </div></div>` : ''}`;
  };
  const show = (o, pin = false) => {
    clearTimeout(timer);
    open = o;
    pinned = o && pin;
    render();
  };
  el.addEventListener('mouseenter', () => { clearTimeout(timer); if (!open) show(true); });
  el.addEventListener('mouseleave', () => { if (!pinned) timer = setTimeout(() => show(false), 450); });
  el.addEventListener('click', (e) => {
    e.stopPropagation(); // a parent that opens something on a tap of the card should not see this one
    const tile = e.target.closest('[data-k]');
    if (tile) {
      toggle(tile.dataset.k);
      render();
    } else if (e.target.closest('.rl-pbtn')) show(!pinned, !pinned);
  });
  // Leaflet must not read a click or drag on the picker as one on the map
  s.L.DomEvent.disableClickPropagation(el);
  s.L.DomEvent.disableScrollPropagation(el);
  render();
  return { remove: () => { clearTimeout(timer); el.remove(); } };
}

// ---- shared helpers --------------------------------------------------------

// Repeat fn every ms until the layer is removed or the map goes
function every(s, fn, ms) {
  const t = setInterval(fn, ms);
  s.timers.push(t);
  return () => {
    clearInterval(t);
    s.timers = s.timers.filter((x) => x !== t);
  };
}

// Run fn now and whenever the view changes. The map has no size until it is laid out, so fn waits for one.
function onView(map, fn) {
  let key = '';
  const run = () => {
    const size = map.getSize();
    if (!size.x || !size.y) return;
    const b = map.getBounds();
    const k = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(r2).join();
    if (k !== key) {
      key = k;
      fn();
    }
  };
  map.on('resize moveend', run);
  run();
  return () => map.off('resize moveend', run);
}

// A JSON fetch, shared by every card asking for the same URL within maxAge (a watchdog rebuild does not fetch again)
const CACHE = new Map();
export function cached(url, maxAge) {
  const hit = CACHE.get(url);
  if (hit && Date.now() - hit.at < maxAge) return hit.p;
  const p = fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  });
  CACHE.set(url, { at: Date.now(), p });
  p.catch(() => CACHE.delete(url));
  return p;
}

// A full-size canvas in a pane, kept over the map's container; place() again after a move or resize
function overlayCanvas(L, map, pane, className) {
  const canvas = L.DomUtil.create('canvas', className, map.getPane(pane));
  const ctx = canvas.getContext('2d');
  const view = { canvas, ctx, size: null };
  view.place = () => {
    const size = (view.size = map.getSize());
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    canvas.width = Math.round(size.x * dpr);
    canvas.height = Math.round(size.y * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  return view;
}

const r2 = (x) => Math.round(x * 100) / 100;
const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

// "just now", "40 min ago", "3 h ago", "2 days ago", from minutes
export function ago(mins) {
  const m = Math.round(mins);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

// Miles between two points, and the compass direction from the first to the second
const R_MI = 3958.8;
const rad = (d) => (d * Math.PI) / 180;
export function distMi(lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.sqrt(a));
}
export function compass(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((Math.atan2(y, x) * 180) / Math.PI + 360) % 360) / 45) % 8];
}

// ---- clouds ----------------------------------------------------------------
// GOES GeoColor is true colour by day and infrared clouds over a dark background by night. Only the clouds are kept,
// as white with alpha, so the basemap stays visible: a pixel counts when it is white in GeoColor (bright and grey)
// and cool in infrared (Band 13). Whiteness alone also takes in bright desert and dry lake beds; hot ground is dark
// in infrared and the marine layer is not (a desert lit up on a clear 101 °F afternoon until the infrared check
// went in). GOES-West covers the west, GOES-East the rest. Infrared tiles stop at zoom 6, so a zoom 7 tile uses a
// quarter of its parent.

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

const image = (src) => new Promise((ok, fail) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => ok(img);
  img.onerror = () => fail(new Error(`cloud tile ${src}`));
  img.src = src;
});

function cloudLayer(s) {
  const { L, map } = s;
  const sat = map.getCenter().lng < -105 ? 'GOES-West' : 'GOES-East';
  const stamp = () => Math.floor(Date.now() / 600e3);
  const geo = () => `${GIBS}/${sat}_ABI_GeoColor/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png?t=${stamp()}`;
  // four zoom 7 tiles share one infrared tile: fetch it once per refresh
  const irs = new Map();
  const ir = (z, x, y) => {
    const src = `${GIBS}/${sat}_ABI_Band13_Clean_Infrared/default/default/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png?t=${stamp()}`;
    if (!irs.has(src)) {
      irs.set(src, image(src));
      irs.get(src).catch(() => irs.delete(src));
    }
    return irs.get(src);
  };
  const Clouds = L.TileLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 256;
      const { x, y, z } = coords;
      const up = z > 6;
      Promise.all([image(this.getTileUrl(coords)), ir(up ? z - 1 : z, up ? x >> 1 : x, up ? y >> 1 : y)]).then(([g, i]) => {
        const q = up ? [(x & 1) * 128, (y & 1) * 128, 128] : [0, 0, 256];
        cloudMask(tile.getContext('2d', { willReadFrequently: true }), g, i, q);
        done(null, tile);
      }, (e) => done(e, tile));
      return tile;
    },
  });
  const layer = new Clouds(geo(), { pane: 'rl-clouds', maxNativeZoom: 7, opacity: 0.9 }).addTo(map);
  const off = every(s, () => {
    irs.clear();
    layer.setUrl(geo());
  }, 600e3);
  return { remove() { off(); layer.remove(); } };
}

const ramp = (v, from, to) => Math.min(1, Math.max(0, (v - from) / (to - from)));

// The alpha (0..1) of one pixel: GeoColor r, g, b and the infrared grey
export function cloudAlpha(r, g, b, irGrey) {
  const lo = Math.min(r, g, b);
  const hi = Math.max(r, g, b);
  const sat = hi ? (hi - lo) / hi : 1;
  // white: bright (min channel 90 -> 170) and grey (saturation under .35, fully at .15).
  // cool: infrared grey 80 -> 105 (hot desert ground reads 50-90, the marine layer ~100, high cloud 130+)
  return ramp(lo, 90, 170) * ramp(-sat, -0.35, -0.15) * ramp(irGrey, 80, 105);
}

// GeoColor (geo) and the matching square of the infrared tile ([sx, sy, size]) -> white clouds
function cloudMask(ctx, geo, ir, [sx, sy, sw]) {
  ctx.drawImage(ir, sx, sy, sw, sw, 0, 0, 256, 256);
  const cold = ctx.getImageData(0, 0, 256, 256).data;
  ctx.clearRect(0, 0, 256, 256);
  ctx.drawImage(geo, 0, 0, 256, 256);
  const d = ctx.getImageData(0, 0, 256, 256);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const a = cloudAlpha(p[i], p[i + 1], p[i + 2], cold[i]);
    p[i] = p[i + 1] = p[i + 2] = 255;
    p[i + 3] = Math.round(a * 235 * (p[i + 3] / 255));
  }
  ctx.putImageData(d, 0, 0);
}

// ---- wind ------------------------------------------------------------------
// Streaks that drift with the wind. Open-Meteo's current 10 m wind on a grid over the view, interpolated into a
// field of screen-space speeds, and a few thousand particles moved through it on one canvas. A pan or zoom that
// stays inside the fetched area reuses it; leaving it fetches again.

const OM = 'https://api.open-meteo.com/v1/forecast';
const GRID = [8, 6]; // points across, down: 48 locations per request (Open-Meteo counts each toward its free limit)

// Wind from `deg` (meteorological: where it comes from) at `mph`, as a screen vector (y points down)
export function windVector(deg, mph) {
  const r = rad(deg);
  return [-Math.sin(r) * mph, Math.cos(r) * mph];
}

function windLayer(s) {
  const { map } = s;
  const v = overlayCanvas(s.L, map, 'rl-wind', 'rl-canvas');
  let field = null;
  let parts = [];
  let raf = 0;
  let tick = 0;
  let data = null;
  let dead = false;
  let retry = 0;

  const fetchWind = () => {
    const b = map.getBounds().pad(0.15);
    const [nx, ny] = GRID;
    const lats = [];
    const lons = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      lats.push(r2(b.getNorth() - ((b.getNorth() - b.getSouth()) * j) / (ny - 1)));
      lons.push(r2(b.getWest() + ((b.getEast() - b.getWest()) * i) / (nx - 1)));
    }
    const q = `latitude=${lats.join(',')}&longitude=${lons.join(',')}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=mph`;
    cached(`${OM}?${q}`, 30 * 60e3).then((res) => {
      if (dead) return;
      data = { b, z: map.getZoom(), pts: (Array.isArray(res) ? res : [res]).map((r) => r.current) };
      build();
    }).catch((e) => {
      // a refusal (429 when the free limit is hit) tries again in 10 minutes, not at the hourly refresh
      console.warn('wall-radar-card: wind', e);
      clearTimeout(retry);
      if (!dead) retry = setTimeout(() => !dead && fetchWind(), 600e3);
    });
  };

  // a view change: rebuild from the data we have while the view is inside it, else fetch
  const view = () => {
    v.place();
    if (data && data.b.contains(map.getBounds()) && Math.abs(map.getZoom() - data.z) < 2) build();
    else fetchWind();
  };

  // speeds in px per frame on a 10 px mesh over the screen, interpolated from the lat/lon grid
  const build = () => {
    const size = map.getSize();
    const [nx, ny] = GRID;
    const step = 10;
    const w = Math.ceil(size.x / step) + 1;
    const h = Math.ceil(size.y / step) + 1;
    const { b, pts } = data;
    const u = new Float32Array(w * h);
    const vv = new Float32Array(w * h);
    const sp = new Float32Array(w * h);
    // ~20 mph moves about 1.5 px a frame at zoom 8
    const k = 0.075 * 2 ** (map.getZoom() - 8);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const ll = map.containerPointToLatLng([x * step, y * step]);
      const fx = Math.min(Math.max(((ll.lng - b.getWest()) / (b.getEast() - b.getWest())) * (nx - 1), 0), nx - 1.001);
      const fy = Math.min(Math.max(((b.getNorth() - ll.lat) / (b.getNorth() - b.getSouth())) * (ny - 1), 0), ny - 1.001);
      const i0 = Math.floor(fx);
      const j0 = Math.floor(fy);
      const tx = fx - i0;
      const ty = fy - j0;
      let du = 0;
      let dv = 0;
      let s0 = 0;
      for (const [di, dj, wt] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
        const p = pts[(j0 + dj) * nx + i0 + di];
        if (!p) continue;
        const [vx, vy] = windVector(p.wind_direction_10m, p.wind_speed_10m);
        du += vx * wt;
        dv += vy * wt;
        s0 += p.wind_speed_10m * wt;
      }
      const n = y * w + x;
      u[n] = du * k;
      vv[n] = dv * k;
      sp[n] = s0;
    }
    field = { u, v: vv, sp, w, h, step, size };
    const count = Math.min(1800, Math.round((size.x * size.y) / 1500));
    parts = Array.from({ length: count }, () => spawn({}));
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const spawn = (p) => {
    p.x = Math.random() * field.size.x;
    p.y = Math.random() * field.size.y;
    p.age = Math.floor(Math.random() * 120);
    return p;
  };

  const at = (x, y) => {
    const { w, h, step } = field;
    const i = Math.min(Math.max(Math.round(x / step), 0), w - 1);
    const j = Math.min(Math.max(Math.round(y / step), 0), h - 1);
    return j * w + i;
  };

  const frame = () => {
    raf = 0;
    if (dead) return;
    raf = requestAnimationFrame(frame);
    // 30 frames a second is smooth enough and halves the work; nothing while hidden or detached
    if (++tick % 2 || document.hidden || !s.card.isConnected) return;
    const { u, v: vy, sp, size } = field;
    const { ctx } = v;
    // fade what is there, so each particle leaves a short trail
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,.94)';
    ctx.fillRect(0, 0, size.x, size.y);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    // two passes, so gusty streaks are brighter without a style change per particle
    for (const strong of [false, true]) {
      ctx.strokeStyle = strong ? 'rgba(255,236,200,.8)' : 'rgba(255,255,255,.45)';
      ctx.beginPath();
      for (const p of parts) {
        const n = at(p.x, p.y);
        if ((sp[n] >= 20) !== strong) continue;
        const x2 = p.x + u[n];
        const y2 = p.y + vy[n];
        if (--p.age < 0 || x2 < 0 || y2 < 0 || x2 > size.x || y2 > size.y) {
          spawn(p);
          p.age = 60 + Math.floor(Math.random() * 100);
          continue;
        }
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(x2, y2);
        p.x = x2;
        p.y = y2;
      }
      ctx.stroke();
    }
  };

  v.place();
  const unview = onView(map, view);
  const off = every(s, fetchWind, 60 * 60e3);
  return {
    remove() {
      dead = true;
      cancelAnimationFrame(raf);
      clearTimeout(retry);
      off();
      unview();
      v.canvas.remove();
    },
  };
}

// ---- lightning -------------------------------------------------------------
// Blitzortung.org's live stream: every strike in the world as it is located (a few a second, ~2 KB/s). One
// websocket, shared by every card with the layer on, open only while one is and the page is visible. Strikes in
// view flash white, then fade to amber over 15 minutes. Nothing from before the layer was switched on is shown.

const BO_HOSTS = ['ws1', 'ws7', 'ws8'];
const STRIKE_KEEP_MS = 15 * 60e3;
const BO = { ws: null, subs: new Set(), strikes: [], retry: 0, timer: 0, watching: false };

// Blitzortung sends its JSON LZW-compressed into a string; this unpacks it
export function boDecode(b) {
  const dict = {};
  const data = [...b];
  let c = data[0];
  let prev = c;
  let code = 256;
  const out = [c];
  for (let i = 1; i < data.length; i++) {
    const n = data[i].charCodeAt(0);
    const word = n < 256 ? data[i] : dict[n] ? dict[n] : prev + c;
    out.push(word);
    c = word.charAt(0);
    dict[code++] = prev + c;
    prev = word;
  }
  return out.join('');
}

function boConnect() {
  if (!BO.watching) {
    BO.watching = true;
    document.addEventListener('visibilitychange', () => (document.hidden ? boClose() : boConnect()));
  }
  if (BO.ws || !BO.subs.size || document.hidden) return;
  const ws = (BO.ws = new WebSocket(`wss://${BO_HOSTS[BO.retry % BO_HOSTS.length]}.blitzortung.org/`));
  ws.onopen = () => {
    BO.retry = 0;
    ws.send('{"a":111}');
  };
  ws.onmessage = (m) => {
    try {
      const j = JSON.parse(boDecode(m.data));
      if (j.lat == null) return;
      const now = Date.now();
      BO.strikes.push({ lat: j.lat, lon: j.lon, at: now });
      if (BO.strikes[0].at < now - STRIKE_KEEP_MS) BO.strikes = BO.strikes.filter((x) => x.at >= now - STRIKE_KEEP_MS);
    } catch {
      /* one bad message */
    }
  };
  ws.onclose = () => {
    if (BO.ws !== ws) return;
    BO.ws = null;
    // the next server, backing off to a minute
    clearTimeout(BO.timer);
    BO.timer = setTimeout(boConnect, Math.min(60e3, 2e3 * 2 ** BO.retry++));
  };
}
function boClose() {
  clearTimeout(BO.timer);
  const ws = BO.ws;
  BO.ws = null;
  ws?.close();
}

function lightningLayer(s) {
  const { map } = s;
  const v = overlayCanvas(s.L, map, 'rl-lightning', 'rl-canvas');
  let tick = 0;
  let flashing = false;
  // every strike in view; true while one is still flashing
  const draw = () => {
    const { ctx, size } = v;
    if (!size?.x) return false;
    const now = Date.now();
    const view = map.getBounds();
    ctx.clearRect(0, 0, size.x, size.y);
    let lit = false;
    for (const st of BO.strikes) {
      if (!view.contains([st.lat, st.lon])) continue;
      const age = now - st.at;
      const p = map.latLngToContainerPoint([st.lat, st.lon]);
      if (age < 3000) {
        lit = true;
        const k = 1 - age / 3000;
        ctx.fillStyle = `rgba(255,255,255,${0.35 * k})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 + 10 * k, 0, 7);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, 7);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(255,200,60,${0.9 * (1 - age / STRIKE_KEEP_MS)})`;
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      }
    }
    return lit;
  };
  // a strike in view from the last 3 s: only the newest few need checking
  const fresh = () => {
    const now = Date.now();
    const view = map.getBounds();
    for (let i = BO.strikes.length - 1; i >= 0 && now - BO.strikes[i].at < 3000; i--) {
      if (view.contains([BO.strikes[i].lat, BO.strikes[i].lon])) return true;
    }
    return false;
  };
  // 4 times a second while something flashes, else every 5 s for the fade
  const off = every(s, () => {
    if (document.hidden || !s.card.isConnected) return;
    if (flashing || fresh() || ++tick % 20 === 0) flashing = draw();
  }, 250);
  const place = () => {
    v.place();
    draw();
  };
  v.place();
  map.on('resize moveend', place);
  const sub = {};
  BO.subs.add(sub);
  boConnect();
  return {
    remove() {
      BO.subs.delete(sub);
      if (!BO.subs.size) boClose();
      off();
      map.off('resize moveend', place);
      v.canvas.remove();
    },
  };
}

// ---- fires -----------------------------------------------------------------
// Wildfires of 10 acres or more that are not fully contained: the mapped perimeter where there is one, and a marker
// with the name, size and containment that opens the fire's details. Smaller entries are mostly dispatch logs (one
// county can list dozens of 0.01-acre calls a day). With `hms_url`, NOAA's satellite fire detections from the last
// 12 hours sit faintly underneath: they show a start before it has a name. Fires within 25 miles of home are listed
// in `data-home-fires`.

const WFIGS = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services';
const FIRE_MIN_ACRES = 10;
const FIRE_MAX_AGE_D = 60;
export const FIRE_NEAR_MI = 25;

// "MTZ/BDC/82B" -> "82B", "POWERLINE 2" -> "Powerline 2": words title-cased, codes left alone
export const fireName = (n) => String(n || 'Fire').replace(/^MTZ\/[A-Z]+\//, '')
  .replace(/[A-Za-z]+/g, (w, i, all) => (/\d/.test(all[i - 1] || '') || /\d/.test(all[i + w.length] || '') ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()));

export const acres = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : Math.round(n).toLocaleString('en-US'));

export function fireLabel(p) {
  return [fireName(p.name), `${acres(p.size)} ac`, p.pct != null ? `${p.pct}% contained` : ''].filter(Boolean).join(' · ');
}

// Keep a fire: a wildfire, big enough, not out, not fully contained, not months old
export function liveFire(p, now = Date.now()) {
  return p.type === 'WF' && p.size >= FIRE_MIN_ACRES && !p.out && !(p.pct >= 100) && !(now - p.found > FIRE_MAX_AGE_D * 864e5);
}

// Every live wildfire in the country in one request (~35 KB). The filter runs at NIFC; liveFire checks again.
const FIRE_WHERE = "IncidentTypeCategory='WF' AND IncidentSize>=10 AND FireOutDateTime IS NULL AND (PercentContained IS NULL OR PercentContained<100)";
const FIRE_FIELDS = 'IncidentName,IncidentTypeCategory,IncidentSize,PercentContained,FireOutDateTime,FireDiscoveryDateTime,FireCause,POOCounty,POOState,TotalIncidentPersonnel';
const FIRES_URL = `${WFIGS}/WFIGS_Incident_Locations_Current/FeatureServer/0/query?where=${encodeURIComponent(FIRE_WHERE)}&outFields=${FIRE_FIELDS}&outSR=4326&geometryPrecision=4&f=geojson`;

// NIFC's GeoJSON -> [{ name, type, size, pct, out, found, cause, county, state, crew, lat, lon }], live fires only
export function parseFires(geojson, now = Date.now()) {
  return (geojson?.features || []).map((f) => {
    const a = f.properties || {};
    const c = f.geometry?.coordinates || [];
    return {
      name: a.IncidentName, type: a.IncidentTypeCategory, size: a.IncidentSize, pct: a.PercentContained, out: a.FireOutDateTime,
      found: a.FireDiscoveryDateTime, cause: a.FireCause, county: a.POOCounty, state: (a.POOState || '').replace(/^US-/, ''),
      crew: a.TotalIncidentPersonnel, lon: c[0], lat: c[1],
    };
  }).filter((f) => f.lat != null && liveFire(f, now));
}

// Fires within `mi` of [lat, lon], nearest first: [{ name, acres, contained, mi, dir }] for data-home-fires
export function nearFires(fires, [lat, lon], mi = FIRE_NEAR_MI) {
  return fires.map((f) => ({ f, mi: distMi(lat, lon, f.lat, f.lon) }))
    .filter((n) => n.mi <= mi)
    .sort((a, b) => a.mi - b.mi)
    .map(({ f, mi: d }) => ({ name: fireName(f.name), acres: Math.round(f.size), contained: f.pct ?? null, mi: Math.round(d), dir: compass(lat, lon, f.lat, f.lon) }));
}

// The details popup's HTML
export function fireDetails(f, home, now = Date.now()) {
  const where = [f.county && `${f.county} County`, f.state].filter(Boolean).join(', ');
  const d = home ? distMi(home[0], home[1], f.lat, f.lon) : null;
  const near = d != null && d <= 100 ? `${Math.round(d)} mi ${compass(home[0], home[1], f.lat, f.lon)} of home` : '';
  const facts = [where, f.found && `started ${ago((now - f.found) / 60e3)}`, f.cause && f.cause !== 'Undetermined' && `cause: ${f.cause.toLowerCase()}`, f.crew && `${f.crew} people assigned`].filter(Boolean);
  return `<b>${esc(fireName(f.name))} Fire</b>
    <div><b>${acres(f.size)} acres</b> · ${f.pct != null ? `${f.pct}% contained` : 'containment not reported'}</div>
    ${near ? `<div>${esc(near)}</div>` : ''}
    <div class="rl-sub">${esc(facts.join(' · '))}</div>
    <div class="rl-sub">NIFC interagency feed: size and containment are from the incident's last report.</div>`;
}

function fireLayer(s) {
  const { L, map, card, c } = s;
  const group = L.layerGroup().addTo(map);
  // the detections are many small dots: one canvas for all of them, under the markers
  const dots = L.canvas({ pane: 'rl-fires', padding: 0.1 });

  const draw = () => {
    const b = map.getBounds().pad(0.3);
    const env = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(r2).join(',');
    const shapes = cached(`${WFIGS}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1%3D1&geometry=${env}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326`
      + '&spatialRel=esriSpatialRelIntersects&outFields=attr_IncidentTypeCategory,attr_IncidentSize,attr_PercentContained,attr_FireOutDateTime,attr_FireDiscoveryDateTime'
      + '&returnGeometry=true&maxAllowableOffset=0.002&geometryPrecision=4&f=geojson', 10 * 60e3);
    const hms = c.hms_url ? cached(`${c.hms_url.replace(/\/$/, '')}/fires.json`, 10 * 60e3) : Promise.resolve(null);
    Promise.allSettled([cached(FIRES_URL, 10 * 60e3), shapes, hms]).then(([pts, polys, det]) => {
      for (const r of [pts, polys, det]) if (r.status === 'rejected') console.warn('wall-radar-card: fires', r.reason);
      if (!group._map) return;
      group.clearLayers();
      const now = Date.now();
      for (const [lon, lat, frp, mins] of det.value?.points || []) {
        if (!b.contains([lat, lon])) continue;
        // stronger and newer is brighter; 12 hours old is nearly gone
        L.circleMarker([lat, lon], {
          renderer: dots, interactive: false, stroke: false, radius: Math.min(5, 2 + Math.sqrt(frp) / 3),
          fillColor: '#ffb347', fillOpacity: 0.75 * (1 - Math.min(mins, 720) / 900),
        }).addTo(group);
      }
      for (const f of polys.value?.features || []) {
        const a = f.properties || {};
        const p = { type: a.attr_IncidentTypeCategory, size: a.attr_IncidentSize, pct: a.attr_PercentContained, out: a.attr_FireOutDateTime, found: a.attr_FireDiscoveryDateTime };
        if (!liveFire(p, now)) continue;
        L.geoJSON(f, { pane: 'rl-fires', interactive: false, style: { color: '#ff6a2b', weight: 1.5, opacity: 0.95, fillColor: '#ff4d1a', fillOpacity: 0.28 } }).addTo(group);
      }
      const fires = pts.status === 'fulfilled' ? parseFires(pts.value, now) : null;
      for (const f of fires || []) {
        if (!b.contains([f.lat, f.lon])) continue;
        L.marker([f.lat, f.lon], {
          pane: 'rl-fires',
          keyboard: false,
          icon: L.divIcon({ className: `rl-fire${f.size >= 1000 ? ' big' : ''}`, iconSize: [0, 0], html: `<i></i><span>${esc(fireLabel(f))}</span>` }),
        }).bindPopup(() => fireDetails(f, card._home), { className: 'rl-pop', maxWidth: 320 }).addTo(group);
      }
      if (fires && card._home) {
        const near = nearFires(fires, card._home);
        const v = near.length ? JSON.stringify(near) : '';
        if (card.dataset.homeFires !== v) card.dataset.homeFires = v;
      }
    });
  };

  const unview = onView(map, draw);
  const off = every(s, draw, 10 * 60e3);
  return { remove() { off(); unview(); group.remove(); delete card.dataset.homeFires; } };
}

// ---- smoke -----------------------------------------------------------------
// NOAA HMS smoke plumes, drawn as haze: heavier smoke, thicker haze. The analysts update them a few times a day.
// Needs `hms_url` (examples/hms/): `smoke.json` is {"features": [{"d": "Light|Medium|Heavy", "rings": [[[lon, lat], ...]]}]}.

const SMOKE = { Light: 0.16, Medium: 0.28, Heavy: 0.42 };

function smokeLayer(s) {
  const { L, map, c } = s;
  const group = L.layerGroup().addTo(map);
  const draw = () => cached(`${c.hms_url.replace(/\/$/, '')}/smoke.json`, 20 * 60e3).then((d) => {
    if (!group._map) return;
    group.clearLayers();
    const view = map.getBounds().pad(0.2);
    // light first, so heavier smoke draws over it
    const order = (f) => Object.keys(SMOKE).indexOf(f.d);
    for (const f of [...(d.features || [])].sort((a, b) => order(a) - order(b))) {
      const rings = f.rings.map((r) => r.map(([x, y]) => [y, x]));
      if (!L.latLngBounds(rings.flat()).intersects(view)) continue;
      L.polygon(rings, { pane: 'rl-smoke', interactive: false, stroke: false, fillColor: '#a8988a', fillOpacity: SMOKE[f.d] ?? 0.16, smoothFactor: 1.5 }).addTo(group);
    }
  }, (e) => console.warn('wall-radar-card: smoke', e));
  const unview = onView(map, draw);
  const off = every(s, draw, 20 * 60e3);
  return { remove() { off(); unview(); group.remove(); } };
}

// ---- earthquakes -----------------------------------------------------------
// USGS, magnitude 2.5 and up in the last day: a ring sized by magnitude, fading over the day; the last hour's ring
// pulses, and M3.5+ is labelled. Hovering a ring (or tapping it) shows the quake's details. Quakes within 100 miles
// of home are listed in `data-home-quakes`.

const QUAKES_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
export const QUAKE_NEAR_MI = 100;

export const quakeRadius = (mag) => Math.max(4, 3 * (mag - 1));

// The hover card's lines, from a USGS feature's properties and its depth (km)
export function quakeTip(p, depthKm, now = Date.now()) {
  const t = new Date(p.time);
  const time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = now - p.time > 864e5 / 2 ? ` ${t.toLocaleDateString('en-US', { weekday: 'short' })}` : '';
  return [
    `<b>M${p.mag.toFixed(1)}</b>${p.place ? ` · ${esc(p.place)}` : ''}`,
    `${esc(ago((now - p.time) / 60e3))} · ${esc(time)}${esc(day)}`,
    [depthKm != null && `${Math.round(depthKm * 0.621)} mi deep`, p.felt && `felt by ${p.felt.toLocaleString('en-US')}`].filter(Boolean).join(' · '),
    p.alert && `USGS alert: ${esc(p.alert)}`,
    p.tsunami && 'Tsunami bulletin from NOAA',
    p.status === 'reviewed' ? 'Reviewed by a seismologist' : 'Automatic, may be revised',
  ].filter(Boolean).map((l) => `<div>${l}</div>`).join('');
}

// Quakes within `mi` of [lat, lon], newest first: [{ mag, place, time, mi, dir }] for data-home-quakes
export function nearQuakes(features, [lat, lon], mi = QUAKE_NEAR_MI) {
  return (features || []).map((q) => {
    const [qlon, qlat] = q.geometry?.coordinates || [];
    const p = q.properties || {};
    if (qlat == null || p.mag == null) return null;
    const d = distMi(lat, lon, qlat, qlon);
    return d <= mi ? { mag: p.mag, place: p.place || '', time: new Date(p.time).toISOString(), mi: Math.round(d), dir: compass(lat, lon, qlat, qlon) } : null;
  }).filter(Boolean).sort((a, b) => (a.time < b.time ? 1 : -1));
}

function quakeLayer(s) {
  const { L, map, card } = s;
  const group = L.layerGroup().addTo(map);
  let open = null;
  const draw = () => cached(QUAKES_URL, 5 * 60e3).then((d) => {
    if (!group._map) return;
    group.clearLayers();
    const view = map.getBounds().pad(0.2);
    const now = Date.now();
    for (const q of d.features || []) {
      const [lon, lat, depth] = q.geometry?.coordinates || [];
      const p = q.properties || {};
      const { mag, time } = p;
      if (lat == null || mag == null || !view.contains([lat, lon])) continue;
      const mins = (now - time) / 60e3;
      const fade = 1 - (Math.min(mins, 1440) / 1440) * 0.7;
      const r = quakeRadius(mag);
      L.circleMarker([lat, lon], {
        pane: 'rl-quakes', interactive: false, radius: r, color: '#ffd34d', weight: 2, opacity: fade,
        fillColor: '#ffd34d', fillOpacity: 0.12 * fade, className: mins < 60 ? 'rl-quake-new' : '',
      }).addTo(group);
      // the hover target: invisible, and never smaller than a fingertip
      const hit = L.circleMarker([lat, lon], { pane: 'rl-quakes', radius: Math.max(r + 4, 12), stroke: false, fillOpacity: 0, className: 'rl-qhit' })
        .bindTooltip(quakeTip(p, depth, now), { className: 'rl-tip', direction: 'top', offset: [0, -r - 2], opacity: 1 })
        .addTo(group);
      hit.on('click', (e) => {
        L.DomEvent.stop(e.originalEvent);
        if (open && open !== hit) open.closeTooltip();
        hit.openTooltip();
        open = hit;
      });
      if (mag >= 3.5) {
        L.marker([lat, lon], {
          pane: 'rl-quakes', interactive: false, keyboard: false,
          icon: L.divIcon({ className: 'rl-qlabel', iconSize: [0, 0], html: `<span style="left:${r + 4}px">M${mag.toFixed(1)} · ${esc(ago(mins))}</span>` }),
        }).addTo(group);
      }
    }
    if (card._home) {
      const near = nearQuakes(d.features, card._home);
      const v = near.length ? JSON.stringify(near) : '';
      if (card.dataset.homeQuakes !== v) card.dataset.homeQuakes = v;
    }
  }, (e) => console.warn('wall-radar-card: quakes', e));
  const unview = onView(map, draw);
  const off = every(s, draw, 5 * 60e3);
  return { remove() { off(); unview(); group.remove(); delete card.dataset.homeQuakes; } };
}

// ---- styles (inside the card's shadow root) --------------------------------

const CSS = `
  .rl-canvas { position: absolute; pointer-events: none; }
  .rl-picker { position: absolute; top: 18px; right: 14px; z-index: 1001; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .rl-pbtn {
    width: 40px; height: 40px; border-radius: 50%; border: 0; cursor: pointer; display: grid; place-items: center;
    background: rgba(18, 21, 25, 0.78); color: #e9eef0; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  .rl-panel {
    padding: 10px 12px 12px; border-radius: 14px; background: rgba(18, 21, 25, 0.9); color: #e9eef0;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45); font: 500 12px/1.3 system-ui, sans-serif;
  }
  .rl-phead { font-weight: 600; font-size: 13px; margin-bottom: 8px; }
  .rl-pgrid { display: grid; grid-template-columns: repeat(4, 64px); gap: 10px 6px; }
  .rl-pgrid button { all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; color: rgba(233, 238, 240, 0.7); }
  .rl-tile { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: rgba(255, 255, 255, 0.08); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1); }
  .rl-pgrid button[aria-pressed='true'] { color: #fff; }
  .rl-pgrid button[aria-pressed='true'] .rl-tile { box-shadow: inset 0 0 0 2px #4fd1c5; color: #4fd1c5; }
  .rl-pgrid button:focus-visible .rl-tile, .rl-pbtn:focus-visible { outline: 2px solid #4fd1c5; outline-offset: 2px; }
  .rl-fire { position: absolute; pointer-events: auto; cursor: pointer; }
  .rl-fire i {
    position: absolute; left: -6px; top: -6px; width: 12px; height: 12px; border-radius: 50%; background: #ff7a2b;
    box-shadow: 0 0 0 3px rgba(255, 90, 30, 0.3), 0 0 14px 4px rgba(255, 80, 20, 0.75);
  }
  .rl-fire.big i { left: -8px; top: -8px; width: 16px; height: 16px; }
  .rl-fire span {
    position: absolute; left: 12px; top: -9px; white-space: nowrap; font: 600 12px/18px system-ui, sans-serif; color: #fff;
    padding: 0 7px; border-radius: 9px; background: rgba(40, 12, 4, 0.72); box-shadow: inset 0 0 0 1px rgba(255, 120, 60, 0.45);
  }
  .rl-qlabel span {
    position: absolute; top: -9px; white-space: nowrap; font: 600 11px/18px system-ui, sans-serif; color: #ffe08a;
    padding: 0 6px; border-radius: 9px; background: rgba(30, 24, 4, 0.7);
  }
  .rl-qhit { cursor: pointer; }
  .leaflet-tooltip.rl-tip {
    padding: 8px 11px; border-radius: 11px; background: rgba(22, 20, 10, 0.92); border: 1px solid rgba(255, 211, 77, 0.35);
    color: rgba(255, 255, 255, 0.75); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45); font: 500 12px/1.45 system-ui, sans-serif; white-space: nowrap;
  }
  .leaflet-tooltip.rl-tip b { color: #ffe08a; font-weight: 700; }
  .leaflet-tooltip.rl-tip div:first-child { color: #fff; font-weight: 600; }
  .leaflet-tooltip-top.rl-tip::before { border-top-color: rgba(22, 20, 10, 0.92); }
  .rl-pop .leaflet-popup-content-wrapper, .rl-pop .leaflet-popup-tip { background: rgba(28, 14, 8, 0.94); color: rgba(255, 255, 255, 0.85); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45); }
  .rl-pop .leaflet-popup-content { margin: 10px 14px; font: 500 12px/1.5 system-ui, sans-serif; }
  .rl-pop .leaflet-popup-content > b { display: block; font-size: 14px; color: #fff; margin-bottom: 2px; }
  .rl-pop .rl-sub { color: rgba(255, 255, 255, 0.55); font-size: 11px; }
  .rl-pop a.leaflet-popup-close-button { color: rgba(255, 255, 255, 0.6); }
  .rl-quake-new { animation: rlq 2.4s ease-out infinite; transform-box: fill-box; transform-origin: center; }
  @keyframes rlq { 0% { opacity: 1; } 50% { opacity: 0.35; } 100% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .rl-quake-new { animation: none; } }
`;
