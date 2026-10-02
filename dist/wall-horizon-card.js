// wall-horizon-card: a wall display. A full-bleed wall-radar-card with the time, date, outside temperature,
// forecast, room temperatures and TV controls around its edges. Plain JS, no build step.
// Drawn for one 1280 x 800 tablet and scaled to fit; every entity is optional. Pure logic: wall-horizon-lib.js.

const VERSION = new URL(import.meta.url).search;
// The lib and the fonts are fetched with this module's own ?v=, so one deploy busts every cache.
const {
  CALLOUT_DEFAULTS, XBOX_TIMEOUT_MS, callout, calloutGeometry, calloutIcon, conditionIcon, conditionLabel, dateLine,
  designFit, esc, fcScale, fitClock, fitNumber, fontMetrics, forecastRows, hhmm, homePoint, isCalm,
  musicView, newestObservedEchoes, num, strongScrim, parseRainWindow, popText, radarConfig, radarFallback, readRadar, roomView,
  scalePct, screenLabel, screenStep, tcol, tempText, toDate, volumeToast, xboxInit, xboxStep, xboxView,
  CLIMATE_DEBOUNCE_MS, DIAL, FAN_CHIPS, MODE_CHIPS, MODE_COLORS, SHEET_IDLE_MS, arcPath, chipsFor, climateDue,
  climateInit, climateStep, climateToast, dialAngle, dialCentre, dialDrag, dialLive, dialPoint, dialRange, dialStatus, dialTap,
  fillPath, modeColor, tickPath,
} = await import(new URL(`wall-horizon-lib.js${VERSION}`, import.meta.url).href);

// No entity has a default: a block with nothing set renders nothing and its taps do nothing.
const DEFAULTS = {
  height: '100vh',
  temperature_entity: '',
  weather_entity: '',
  rain_window: '',
  sun_entity: 'sun.sun',
  rooms: [],
  xbox: { switch: '', now_playing: '' },
  screen: { down: '', up: '', seconds: 45 },
  volume: { down: '', up: '', targets: [], labels: [] },
  select: { remote: '', command: 'select', num_repeats: 1, delay_secs: 0.4, label: 'Apple TV' },
  music: '',
  // The data-source credit line along the bottom edge. The tile providers' terms ask for it.
  show_attribution: true,
  calm_drift: true,
  // Echo pixels at or under this count as none in view (the drawn field is not reliably 0 on a dry day).
  calm_echo_floor: 50,
  callout: { heavy_dbz: CALLOUT_DEFAULTS.heavy_dbz, moderate_dbz: CALLOUT_DEFAULTS.moderate_dbz, hourly_pop: CALLOUT_DEFAULTS.hourly_pop, daily_pop: CALLOUT_DEFAULTS.daily_pop },
  radar: {},
};

// The radar card's interface: data-* attributes (absent or '' means unknown).
const RADAR_ATTRS = ['data-credits', 'data-basemap', 'data-frame', 'data-frames', 'data-forecast-frames', 'data-frame-kind', 'data-echoes', 'data-home-dbz', 'data-now-dbz', 'data-rain-at', 'data-rain-peak-dbz', 'data-home-warnings'];
// Home Assistant may restart under the page: a failed forecast subscription retries, and data this old counts as failed.
const FORECAST_RETRY_MS = 60000;
const FORECAST_STALE_MS = 2 * 3600000;
// The "N° now" label's horizontal limits in dial units: design x 8 (clear of the screen edge) to 690 (10 px short of
// the right column at 700). The dial box starts at design x 70 and draws DIAL.size units in 560 px.
const NOW_X = [((8 - 70) * 460) / 560, ((690 - 70) * 460) / 560];

// The thermostat's three fields per room, and the service each one calls.
const FIELDS = ['temp', 'mode', 'fan'];
const SERVICES = { temp: ['set_temperature', 'temperature'], mode: ['set_hvac_mode', 'hvac_mode'], fan: ['set_fan_mode', 'fan_mode'] };
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const icon = (name) => `<ha-icon icon="${esc(name)}"></ha-icon>`;
const setHTML = (el, html) => {
  if (el.__html !== html) {
    el.__html = html;
    el.innerHTML = html;
  }
};
const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

// ---- fonts ------------------------------------------------------------------------------------

const DF = `'Wall Fredoka', Fredoka, system-ui, sans-serif`;
const TF = `'Wall Figtree', Figtree, system-ui, sans-serif`;
const fontUrl = (file) => new URL(`fonts/${file}${VERSION}`, import.meta.url).href;
let fontsReady;

/** @font-face inside a shadow root is ignored, so the rules go into document.head, once. */
function loadFonts() {
  if (!fontsReady) {
    if (!document.head.querySelector('style[data-wall-horizon-fonts]')) {
      const style = document.createElement('style');
      style.dataset.wallHorizonFonts = '';
      style.textContent = `
@font-face { font-family: 'Wall Fredoka'; src: url('${fontUrl('fredoka-latin-wght-normal.woff2')}') format('woff2'); font-weight: 300 700; font-style: normal; font-display: block; }
@font-face { font-family: 'Wall Figtree'; src: url('${fontUrl('figtree-latin-wght-normal.woff2')}') format('woff2'); font-weight: 300 900; font-style: normal; font-display: block; }`;
      document.head.appendChild(style);
    }
    fontsReady = Promise.allSettled([
      document.fonts.load(`650 100px 'Wall Fredoka'`),
      document.fonts.load(`400 42px 'Wall Fredoka'`),
      document.fonts.load(`600 22px 'Wall Figtree'`),
    ]).then((results) => {
      if (results.some((r) => r.status === 'rejected' || !r.value.length)) console.warn('wall-horizon-card: a self-hosted font did not load; falling back to system-ui');
      return document.fonts.ready;
    });
  }
  return fontsReady;
}

let measureCtx;
/** The clock and temperature font's digit metrics, measured on a canvas at 100 px. */
function measureDigits() {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = `650 100px ${DF}`;
  const all = measureCtx.measureText('0123456789');
  return fontMetrics({
    digitWidths: [...'0123456789'].map((d) => measureCtx.measureText(d).width),
    colonWidth: measureCtx.measureText(':').width,
    ascent: all.actualBoundingBoxAscent,
    fontAscent: all.fontBoundingBoxAscent,
    fontDescent: all.fontBoundingBoxDescent,
  });
}

// ---- styles -----------------------------------------------------------------------------------
// Everything below #root is drawn in a 1280 x 800 design space (.stage), scaled by min(W/1280, H/800).

const BASE_CSS = `
  :host { display: block; height: var(--wall-horizon-height, 100vh); }
  #root { position: relative; isolation: isolate; width: 100%; height: 100%; overflow: hidden; background: #03060d; color: #f3f6fb;
    font-family: ${TF}; -webkit-font-smoothing: antialiased; user-select: none; -webkit-user-select: none; line-height: 1.2;
    --icon-primary-color: currentColor; }
  .stage { position: absolute; left: 0; top: 0; width: 1280px; height: 800px; transform-origin: 0 0;
    transform: translate(var(--ox, 0px), var(--oy, 0px)) scale(var(--s, 1)); pointer-events: none; }
  .stage button { pointer-events: auto; }
  .abs { position: absolute; }
  .drift { position: absolute; inset: 0; transform-origin: 0 0; }
  /* Leaflet's panes carry z-index 200-1000: the map layer must be its own stacking context, under the overlay. */
  #mapWrap { z-index: 0; }
  #scrims { z-index: 1; }
  #geoWrap { z-index: 2; }
  #ui { z-index: 3; }
  #sheet { position: absolute; inset: 0; z-index: 4; }
  #sheet[hidden] { display: none; }
  /* While the sheet is open only the map runs underneath: the wall's own text would show through the dim. */
  #root.sheet-open #ui, #root.sheet-open #geoWrap { visibility: hidden; }
  #over { z-index: 5; }
  wall-radar-card { position: absolute; inset: 0; display: block;
    --ha-card-border-radius: 0; --ha-card-border-width: 0; --ha-card-box-shadow: none; }
  button { appearance: none; border: 0; background: none; color: inherit; font: inherit; padding: 0; margin: 0;
    cursor: pointer; text-align: inherit; -webkit-tap-highlight-color: transparent; }
  button:focus-visible { outline: 4px solid #9cc2ff; outline-offset: 3px; }
  button:disabled { cursor: default; }
  ha-icon { display: inline-flex; flex: none; width: 1em; height: 1em; --mdc-icon-size: 1em; }
  .vig { left: 0; top: 0; width: 1280px; height: 800px; background: radial-gradient(120% 95% at 56% 45%, rgb(3 6 13 / 0) 42%, rgb(3 6 13 / .42) 72%, rgb(3 6 13 / .78) 100%); }
  .sc-tl { left: 0; top: 0; width: 1000px; height: 470px; background: radial-gradient(85% 100% at 0 0, rgb(3 6 13 / .88) 0, rgb(3 6 13 / .68) 46%, rgb(3 6 13 / .28) 74%, rgb(3 6 13 / 0) 100%); }
  .sc-tr { left: 720px; top: 0; width: 560px; height: 300px; background: radial-gradient(95% 100% at 100% 0, rgb(3 6 13 / .8), rgb(3 6 13 / 0) 80%); }
  /* Over the satellite basemap (bright, busy terrain) the top right gets a larger, darker scrim. */
  #scrims.sat .sc-tr { left: 640px; width: 640px; height: 360px; background: radial-gradient(100% 100% at 100% 0, rgb(3 6 13 / .92), rgb(3 6 13 / .72) 45%, rgb(3 6 13 / 0) 88%); }
  .sc-b { left: 0; top: 500px; width: 1280px; height: 300px; background: linear-gradient(180deg, rgb(3 6 13 / 0) 0, rgb(3 6 13 / .78) 40%, rgb(3 6 13 / .93) 100%); }
  .credit { left: 36px; right: 36px; bottom: 3px; text-align: right; font: 500 10px/12px ${TF}; color: rgb(255 255 255 / .62);
    text-shadow: 0 1px 2px rgb(0 0 0 / .8); pointer-events: none; }
  .credit:empty { display: none; }
  .toast { position: absolute; left: 640px; bottom: 34px; transform: translateX(-50%); background: rgb(8 11 20 / .95);
    border: 1px solid rgb(255 255 255 / .14); color: #fff; font: 600 22px/1.2 ${TF}; padding: 16px 22px; border-radius: 16px;
    box-shadow: 0 12px 34px rgb(0 0 0 / .45); white-space: nowrap; pointer-events: none; }
`;

const TOP_CSS = `
  .num { line-height: 1; white-space: nowrap; font-kerning: none; font-family: ${DF}; font-weight: 650; overflow: visible; }
  .num .dig { display: block; }
  #root:not(.fitted) .num, #root:not(.fitted) .date { visibility: hidden; }
  .clock { left: 36px; top: 34px; text-shadow: 0 4px 40px rgb(0 0 0 / .4); }
  .clock .d { display: inline-block; width: var(--dw, .6em); text-align: center; }
  .clock .c { display: inline-block; width: var(--cw, .3em); text-align: center; }
  .temp { right: 44px; top: 34px; text-shadow: 0 4px 40px rgb(0 0 0 / .4); }
  .date { left: 40px; top: 243px; display: flex; align-items: baseline; gap: 20px; color: #eef3fb; white-space: nowrap;
    font-family: ${DF}; text-shadow: 0 2px 16px rgb(0 0 0 / .6); }
  .date .wd { font-weight: 650; font-size: 66px; line-height: 1; }
  .date .md { font-weight: 400; font-size: 42px; line-height: 1; color: #c3cee0; }
  .cond { right: 46px; top: 214px; display: flex; align-items: center; gap: 16px; font: 600 22px/1 ${TF}; color: #c8d3e6;
    white-space: nowrap; text-shadow: 0 2px 12px rgb(0 0 0 / .6); }
  .cond ha-icon { font-size: 28px; }
  .cond b { font-weight: 750; color: #fff; }
`;

const BOTTOM_CSS = `
  .fc { left: 36px; top: 606px; width: 500px; }
  .fc-row { display: grid; grid-template-columns: 62px 28px 42px minmax(0, 1fr) 42px 40px; align-items: center; column-gap: 8px;
    height: 42px; font-family: ${DF}; font-weight: 500; font-size: 20px; line-height: 1; }
  .fc-row ha-icon { font-size: 26px; color: #dfe8f5; }
  .fc-day { color: #c6d1e3; }
  .fc-lo { text-align: right; color: #9fb0c8; }
  .fc-pop { font: 650 14px/1 ${TF}; color: #8cc6ff; }
  .fc-track { position: relative; display: block; height: 10px; border-radius: 6px; background: rgb(255 255 255 / .1); }
  .fc-bar { position: absolute; top: 0; bottom: 0; border-radius: 6px; }
  .fc-now { position: absolute; top: 50%; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; background: #fff;
    box-shadow: 0 0 0 3px rgb(18 22 38 / .95); }
  .fc-msg { height: 168px; display: flex; align-items: center; font: 600 20px/1 ${TF}; color: #9fb0c8; }
  .rooms { left: 568px; top: 614px; width: 322px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
  .room { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 0; border-radius: 16px; }
  .room ha-icon { font-size: 30px; color: #c6d1e3; }
  .room .t { font-family: ${DF}; font-weight: 650; font-size: 52px; line-height: 1; }
  .room .n { font: 500 14px/1 ${TF}; color: #9fb0c8; white-space: nowrap; }
  .hv { position: relative; display: inline-flex; }
  .room[data-h="cool"] .hv::after, .room[data-h="heat"] .hv::after { content: ""; position: absolute; right: -4px; top: -2px;
    width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 0 2.5px rgb(20 24 40 / .9); }
  .room[data-h="cool"] .hv::after { background: #5fb6ff; }
  .room[data-h="heat"] .hv::after { background: #ffae45; }
`;

const THEATER_CSS = `
  .theater { left: 904px; top: 612px; width: 340px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .xbox { grid-column: 1 / -1; justify-self: end; width: 84px; height: 84px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: #4a5262; color: #c3cad6; border: 1px solid rgb(255 255 255 / .14); }
  .xbox ha-icon { font-size: 48px; }
  .xbox[data-s="on"] { background: #107c10; color: #fff; border-color: rgb(255 255 255 / .2); box-shadow: 0 0 22px rgb(16 124 16 / .55); }
  .xbox[data-s="starting"], .xbox[data-s="stopping"] { animation: breathe .9s ease-in-out infinite alternate; }
  .xbox[data-s="starting"] { background: #107c10; color: #fff; }
  .xbox:disabled { opacity: .45; }
  @keyframes breathe { from { opacity: 1; } to { opacity: .3; } }
  .scr { position: relative; overflow: hidden; height: 58px; display: flex; align-items: center; justify-content: center; gap: 8px;
    border-radius: 16px; background: rgb(255 255 255 / .06); border: 1px solid rgb(255 255 255 / .1); font: 600 16px/1 ${TF}; color: #c6d1e3; }
  .scr ha-icon { font-size: 24px; }
  .scr:disabled { opacity: .45; }
  .scr .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 5px; background: #8db8ff; transform: scaleX(0); transform-origin: 0 50%; }
  .scr[data-run] .bar { animation: fill var(--dur, 45s) linear forwards; animation-delay: var(--dl, 0s); }
  @keyframes fill { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  .np { grid-column: 1 / -1; box-sizing: border-box; height: 152px; display: flex; align-items: center; gap: 14px; padding: 0 18px; border-radius: 20px;
    background: rgb(255 255 255 / .08); border: 1px solid rgb(255 255 255 / .13); }
  .np .art { width: 72px; height: 72px; flex: none; border-radius: 12px; object-fit: cover; background: rgb(255 255 255 / .1); }
  .np .xl { flex: 1 1 auto; min-width: 0; }
  .np .xl b { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; font-family: ${DF}; font-weight: 650; font-size: 22px; line-height: 1.15; }
  .np .xl span { display: block; margin-top: 6px; font: 500 16px/1.2 ${TF}; color: #aebbd1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .np .pp { flex: none; width: 64px; height: 64px; border-radius: 50%; background: #eef2f8; color: #0c1424; display: flex; align-items: center; justify-content: center; }
  .np .pp ha-icon { font-size: 34px; }
`;

const CALLOUT_CSS = `
  .home { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; background: #fff;
    box-shadow: 0 0 0 3px rgb(0 0 0 / .5), 0 0 16px rgb(0 0 0 / .6); }
  .home::after { content: ""; position: absolute; inset: -10px; border-radius: 50%; border: 2px solid rgb(255 255 255 / .8);
    animation: ping 2.6s ease-out infinite; }
  @keyframes ping { 0% { transform: scale(.35); opacity: .9; } 100% { transform: scale(2.4); opacity: 0; } }
  .lead { height: 2px; background: rgb(255 255 255 / .75); transform-origin: 0 50%; }
  .call { display: flex; align-items: center; gap: 14px; padding: 12px 24px 12px 16px; border-radius: 999px; background: rgb(5 9 18 / .84);
    border: 1px solid rgb(255 255 255 / .16); box-shadow: 0 10px 30px rgb(0 0 0 / .35); }
  .call > ha-icon { font-size: 34px; color: #8ec9ff; }
  .call .txt { min-width: 0; }
  .call b { display: block; font-family: ${DF}; font-weight: 650; font-size: 29px; line-height: 1; text-wrap: balance; }
  .call span { display: block; margin-top: 5px; font: 500 15px/1.1 ${TF}; color: #aebbd1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .call span:empty { display: none; }
  #root.drifting .drift { animation: drift 80s ease-in-out infinite alternate; will-change: transform; }
  @keyframes drift { from { transform: none; } to { transform: translate(calc(-70px * var(--s, 1)), calc(-26px * var(--s, 1))) scale(1.06); } }
  @media (prefers-reduced-motion: reduce) {
    #root .drift, .home::after, .xbox { animation: none !important; }
  }
`;

const SHEET_CSS = `
  .sh-bg { position: absolute; inset: 0; background: rgb(3 6 13 / .84); }
  .sh-tabs { left: 40px; top: 30px; display: flex; gap: 12px; }
  .tab { padding: 16px 28px; border-radius: 999px; background: rgb(5 9 18 / .84); border: 1px solid rgb(255 255 255 / .16);
    font: 600 26px/1 ${TF}; color: #c8d3e6; white-space: nowrap; }
  .tab[aria-pressed="true"] { background: #f3f6fb; border-color: #f3f6fb; color: #07101f; font-weight: 700; }
  .tab[data-na] { opacity: .45; }
  .sh-x { right: 30px; top: 22px; width: 84px; height: 84px; border-radius: 50%; background: rgb(255 255 255 / .08);
    border: 1px solid rgb(255 255 255 / .2); display: flex; align-items: center; justify-content: center; font: 500 42px/1 ${TF}; }
  .sh-dial { left: 70px; top: 150px; width: 560px; height: 560px; pointer-events: auto; }
  .sh-dial svg { position: absolute; inset: 0; overflow: visible; touch-action: none; }
  .d-face { fill: rgb(5 9 18 / .6); }
  .d-track { fill: none; stroke: rgb(255 255 255 / .12); stroke-width: 30; stroke-linecap: round; }
  .d-ticks { fill: none; stroke: rgb(255 255 255 / .28); stroke-width: 2; }
  .d-glow { fill: none; stroke: var(--mc); stroke-width: 54; stroke-linecap: round; opacity: .18; }
  .d-fill { fill: none; stroke: var(--mc); stroke-width: 30; stroke-linecap: round; }
  .d-now { fill: #fff; opacity: .85; }
  .d-nowt { fill: #aebbd1; font: 700 17px ${TF}; dominant-baseline: middle; }
  .d-end { fill: #7d8aa3; font: 700 18px ${TF}; text-anchor: middle; }
  .d-knob { fill: #fff; stroke: rgb(3 6 13 / .5); stroke-width: 4; }
  .d-ring { fill: none; stroke: var(--mc); stroke-width: 4; }
  .d-ring.sending { opacity: .35; animation: breathe .9s ease-in-out infinite alternate; }
  .d-num { position: absolute; left: 0; right: 0; top: 150px; text-align: center; font-family: ${DF}; font-weight: 650;
    font-size: 220px; line-height: 1; letter-spacing: -4px; pointer-events: none; }
  .d-status { position: absolute; left: 40px; right: 40px; top: 382px; text-align: center; font: 600 30px/1 ${DF};
    color: var(--mc); white-space: nowrap; pointer-events: none; }
  .d-step { position: absolute; top: 420px; width: 96px; height: 96px; border-radius: 50%; background: rgb(255 255 255 / .07);
    border: 2px solid rgb(255 255 255 / .24); display: flex; align-items: center; justify-content: center; font: 500 70px/1 ${DF}; }
  .d-step[data-d="-1"] { left: 170px; }
  .d-step[data-d="1"] { left: 294px; }
  .d-step:disabled { opacity: .35; }
  .sh-dial[data-live="false"] svg, .sh-dial[data-live="false"] .d-num { opacity: .45; }
  .d-num.room { opacity: .45; }
  .sh-col { left: 700px; top: 170px; width: 540px; pointer-events: auto; }
  .sh-name { font-family: ${DF}; font-weight: 650; font-size: 60px; line-height: 1; white-space: nowrap; }
  .sh-lbl { margin-top: 44px; font: 700 18px/1 ${TF}; letter-spacing: 2px; color: #7d8aa3; }
  .sh-lbl.fan { margin-top: 34px; }
  .sh-modes, .sh-fans { margin-top: 14px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .sh-fans { grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
  .chip { position: relative; height: 78px; border-radius: 22px; background: rgb(5 9 18 / .84); border: 1px solid rgb(255 255 255 / .16);
    display: flex; align-items: center; justify-content: center; gap: 10px; font: 600 26px/1 ${TF}; color: #c8d3e6; }
  .sh-fans .chip { height: 68px; border-radius: 20px; font-size: 24px; }
  .chip i { width: 12px; height: 12px; border-radius: 50%; background: var(--c); }
  .chip[aria-pressed="true"] { background: color-mix(in srgb, var(--c) 26%, transparent); border: 2px solid var(--c); color: #fff; font-weight: 700; }
  .chip[data-pending]::after { content: ""; position: absolute; inset: -6px; border-radius: 26px; border: 2px solid var(--c);
    animation: breathe .9s ease-in-out infinite alternate; }
  .chip:disabled { opacity: .4; }
  @media (prefers-reduced-motion: reduce) {
    .d-ring.sending, .chip[data-pending]::after { animation: none; }
  }
`;

const TEMPLATE = `
  <div id="root">
    <div class="drift" id="mapWrap"></div>
    <div class="stage" id="scrims"><div class="abs vig"></div><div class="abs sc-tl"></div><div class="abs sc-tr"></div><div class="abs sc-b"></div></div>
    <div class="drift" id="geoWrap"><div class="stage" id="geo">
      <div class="abs lead" id="lead"></div>
      <div class="home" id="home"></div>
      <div class="abs call" id="call"><ha-icon id="callIcon"></ha-icon><div class="txt" id="callTxt"><b id="callHead"></b><span id="callSub"></span></div></div>
    </div></div>
    <div class="stage" id="ui">
      <button type="button" class="abs num clock" id="clock" data-act="select" aria-label="Clock."><span class="dig" id="clockDig"><span class="d">0</span><span class="d">0</span><span class="c">:</span><span class="d">0</span><span class="d">0</span></span></button>
      <button type="button" class="abs date" id="date" data-act="vol" data-dir="down"><span class="wd" id="wd"></span><span class="md" id="md"></span></button>
      <button type="button" class="abs num temp" id="temp" data-act="vol" data-dir="up"><span class="dig" id="tempDig">—</span></button>
      <div class="abs cond" id="cond"></div>
      <div class="abs fc" id="fc"></div>
      <div class="abs rooms" id="rooms"></div>
      <div class="abs theater" id="theater"></div>
      <div class="abs credit" id="credit"></div>
    </div>
    <div id="sheet" hidden>
      <div class="sh-bg" data-act="close"></div>
      <div class="stage">
        <div class="abs sh-tabs" id="shTabs"></div>
        <button type="button" class="abs sh-x" data-act="close" aria-label="Close">✕</button>
        <div class="abs sh-dial" id="shDial">
          <svg id="shSvg" viewBox="0 0 ${DIAL.size} ${DIAL.size}" width="560" height="560">
            <circle class="d-face" cx="${DIAL.cx}" cy="${DIAL.cy}" r="${DIAL.r}"></circle>
            <path class="d-track" id="dTrack"></path>
            <path class="d-ticks" id="dTicks"></path>
            <path class="d-glow" id="dGlow"></path>
            <path class="d-fill" id="dFill"></path>
            <g id="dNow"><circle class="d-now" r="7"></circle><text class="d-nowt" id="dNowT"></text></g>
            <text class="d-end" id="dMin"></text><text class="d-end" id="dMax"></text>
            <g id="dHandle"><circle class="d-ring" id="dRing" r="36"></circle><circle class="d-knob" r="28"></circle></g>
          </svg>
          <div class="d-num" id="dNum"></div>
          <div class="d-status" id="dStatus"></div>
          <button type="button" class="d-step" data-act="step" data-d="-1" aria-label="One degree down">−</button>
          <button type="button" class="d-step" data-act="step" data-d="1" aria-label="One degree up">+</button>
        </div>
        <div class="abs sh-col">
          <div class="sh-name" id="shName"></div>
          <div class="sh-lbl">MODE</div>
          <div class="sh-modes" id="shModes"></div>
          <div class="sh-lbl fan">FAN</div>
          <div class="sh-fans" id="shFans"></div>
        </div>
      </div>
    </div>
    <div class="stage" id="over"></div>
  </div>`;

// ---- the card -----------------------------------------------------------------------------------

class WallHorizonCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._built = false;
    this._deps = {};
    this._xbox = xboxInit(undefined);
    this._screen = { dir: null, t0: 0 };
    this._forecast = null;
    this._forecastFailed = false;
    this._radarSummary = null;
    this._echoes = undefined;
    this._rule = 0;
    this._clim = {};
    this._sheet = null;
    this._drag = null;
    this.shadowRoot.addEventListener('click', (e) => this._onClick(e));
    this.shadowRoot.addEventListener('pointerdown', (e) => this._onPointerDown(e));
  }

  static getStubConfig() {
    return { rooms: [] };
  }

  setConfig(config) {
    if (!config || typeof config !== 'object') throw new Error('wall-horizon-card: missing config');
    const c = { ...DEFAULTS, ...config };
    for (const k of ['xbox', 'screen', 'volume', 'select', 'callout']) c[k] = { ...DEFAULTS[k], ...(config[k] || {}) };
    if (!c.radar || typeof c.radar !== 'object' || Array.isArray(c.radar)) throw new Error('wall-horizon-card: radar must be a mapping of wall-radar-card options');
    if (!Array.isArray(c.rooms) || c.rooms.length > 3 || c.rooms.some((r) => !r || typeof r.entity !== 'string')) {
      throw new Error('wall-horizon-card: rooms must be a list of up to 3 { entity, icon, name }');
    }
    c.screen.seconds = Number(c.screen.seconds);
    if (!(c.screen.seconds > 0)) throw new Error('wall-horizon-card: screen.seconds must be a positive number');
    for (const k of Object.keys(DEFAULTS.callout)) {
      c.callout[k] = Number(c.callout[k]);
      if (!Number.isFinite(c.callout[k])) throw new Error(`wall-horizon-card: callout.${k} must be a number`);
    }
    if (!Array.isArray(c.volume.targets) || c.volume.targets.some((t) => typeof t !== 'string')) throw new Error('wall-horizon-card: volume.targets must be a list of media_player entities');
    if (!Array.isArray(c.volume.labels)) throw new Error('wall-horizon-card: volume.labels must be a list of names, one per target');
    c.calm_echo_floor = Number(c.calm_echo_floor);
    if (!(c.calm_echo_floor >= 0)) throw new Error('wall-horizon-card: calm_echo_floor must be a number, 0 or more');
    // HA re-sends an identical config on many re-renders; only rebuild when it changed.
    if (this._config && JSON.stringify(this._config) === JSON.stringify(c)) return;
    const prevWeather = this._config?.weather_entity;
    this._config = c;
    if (prevWeather && prevWeather !== c.weather_entity) {
      // A new weather entity: drop the old subscription and its data, then subscribe to the new one.
      this._unsubscribe();
      this._forecast = null;
      this._forecastFailed = false;
    }
    // The rain threshold is the radar card's own echo_dbz, so rule 2, rule 3 and calm mode agree.
    this._thresholds = { ...c.callout, rain_dbz: num(c.radar.echo_dbz) ?? CALLOUT_DEFAULTS.rain_dbz };
    this.style.setProperty('--wall-horizon-height', c.height);
    if (this._built || this.isConnected) this._build();
    this._subscribe();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._radar) this._radar.hass = hass;
    if (!this._config) return;
    const xs = this._config.xbox.switch ? hass.states[this._config.xbox.switch]?.state : undefined;
    if (xs !== this._xboxEntity) {
      this._xboxEntity = xs;
      this._setXbox({ type: 'entity', value: xs }, false);
    }
    for (const r of this._config.rooms) this._feedClimate(r.entity, hass.states[r.entity]);
    if (!this._built) return;
    this._subscribe();
    this._render();
  }

  getCardSize() {
    return 12;
  }

  connectedCallback() {
    if (!this._config) return;
    if (!this._built) this._build();
    this._tick();
    clearInterval(this._clock);
    this._clock = setInterval(() => this._tick(), 1000);
    this._subscribe();
    this._climSchedule();
  }

  disconnectedCallback() {
    clearInterval(this._clock);
    this._clock = null;
    this._closeSheet();
    clearTimeout(this._climTimer);
    this._climTimer = null;
    this._unsubscribe();
  }

  // ---- build ------------------------------------------------------------------------------------

  _build() {
    this._built = true;
    this._deps = {};
    this._shown = null;
    this._dayKey = null;
    this._observer?.disconnect();
    this._resizeObserver?.disconnect();
    this._radar = null;
    this._sheet = null;
    this._drag = null;
    clearTimeout(this._idleTimer);
    this.shadowRoot.innerHTML = `<style>${BASE_CSS}${TOP_CSS}${BOTTOM_CSS}${THEATER_CSS}${CALLOUT_CSS}${SHEET_CSS}</style>${TEMPLATE}`;
    const $ = (id) => this.shadowRoot.getElementById(id);
    this._el = {};
    for (const id of ['root', 'scrims', 'mapWrap', 'home', 'lead', 'call', 'callIcon', 'callTxt', 'callHead', 'callSub', 'ui', 'clock', 'clockDig', 'date', 'wd', 'md', 'temp', 'tempDig', 'cond', 'fc', 'rooms', 'theater', 'credit',
      'sheet', 'over', 'shTabs', 'shDial', 'shSvg', 'dTrack', 'dTicks', 'dGlow', 'dFill', 'dNow', 'dNowT', 'dMin', 'dMax', 'dHandle', 'dRing',
      'dNum', 'dStatus', 'shName', 'shModes', 'shFans']) this._el[id] = $(id);
    this._el.steps = [...this._el.shDial.querySelectorAll('.d-step')];
    // lostpointercapture ends a drag like pointerup: the tablet can drop a finger's pointerup.
    for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) this._el.shSvg.addEventListener(type, (e) => this._onDrag(e));
    this._el.digits = [...this._el.clockDig.querySelectorAll('.d')].map((d) => d.firstChild);
    this._resizeObserver = new ResizeObserver(([e]) => this._onResize(e.contentRect.width, e.contentRect.height));
    this._resizeObserver.observe(this._el.root);
    this._labelTaps();
    this._fit();
    this._mountRadar();
    this._tick();
    if (this._hass) this._render();
  }

  /** The clock, date and temperature are hidden buttons: each says what its tap does, or nothing when it does nothing. */
  _labelTaps() {
    const c = this._config;
    const cmd = String(c.select.command);
    this._selectName = cmd.charAt(0).toUpperCase() + cmd.slice(1);
    this._tapNote = {
      clock: c.select.remote ? ` Sends ${this._selectName} to the ${c.select.label}.` : '',
      down: c.volume.down ? ' Turns the volume down.' : '',
      up: c.volume.up ? ' Turns the volume up.' : '',
    };
    this._el.clock.setAttribute('aria-label', `Clock.${this._tapNote.clock}`);
    this._el.clock.style.cursor = c.select.remote ? '' : 'default';
    this._el.date.style.cursor = c.volume.down ? '' : 'default';
    this._el.temp.style.cursor = c.volume.up ? '' : 'default';
  }

  async _mountRadar() {
    const gen = (this._gen = (this._gen || 0) + 1);
    await customElements.whenDefined('wall-radar-card');
    if (gen !== this._gen) return;
    const el = document.createElement('wall-radar-card');
    // The layout's bottom shade covers the map's own credit control, so Horizon draws the credit itself (_onRadar).
    const cfg = { ...radarConfig(this._config.radar), show_attribution: false };
    try {
      el.setConfig(cfg);
    } catch (err) {
      const fallback = radarFallback(cfg);
      if (!fallback) {
        console.error('wall-horizon-card: wall-radar-card rejected its config', err);
        return;
      }
      console.warn(`wall-horizon-card: wall-radar-card rejected basemap "${cfg.basemap}" (${err.message}); using its default basemap`);
      try {
        el.setConfig(fallback);
      } catch (err2) {
        console.error('wall-horizon-card: wall-radar-card rejected its config', err2);
        return;
      }
    }
    if (this._hass) el.hass = this._hass;
    // An older wall-radar-card ignores home_position and keeps its centre in the middle.
    this._radarSupportsHome = 'home_position' in (el.constructor.getStubConfig?.() || {});
    this._radar = el;
    this._el.mapWrap.appendChild(el);
    this._observer = new MutationObserver(() => this._onRadar());
    this._observer.observe(el, { attributes: true, attributeFilter: RADAR_ATTRS });
    this._onRadar();
    this._layoutGeo();
  }

  _onResize(W, H) {
    if (!W || !H) return;
    this._size = { W, H };
    const f = designFit(W, H);
    const st = this._el.root.style;
    st.setProperty('--s', String(f.s));
    st.setProperty('--ox', `${f.ox}px`);
    st.setProperty('--oy', `${f.oy}px`);
    this._layoutGeo();
  }

  async _fit() {
    await loadFonts();
    if (!this._el) return;
    const m = measureDigits();
    const clock = fitClock(m, 208, 680);
    const temp = fitNumber(m, 150);
    const place = (btn, dig, f) => {
      btn.style.height = `${f.digitH.toFixed(2)}px`;
      btn.style.fontSize = `${f.size.toFixed(2)}px`;
      dig.style.marginTop = `${(-f.shift).toFixed(2)}px`;
    };
    place(this._el.clock, this._el.clockDig, clock);
    this._el.clock.style.setProperty('--dw', `${m.dw}em`);
    this._el.clock.style.setProperty('--cw', `${m.cw}em`);
    place(this._el.temp, this._el.tempDig, temp);
    // The date's top sits 20 px under the bottom of the clock digits (digit top 34).
    this._el.date.style.top = `${(34 + clock.digitH + 20).toFixed(2)}px`;
    this._el.root.classList.add('fitted');
    this.dataset.fitted = '';
  }

  // ---- render -----------------------------------------------------------------------------------

  /** Each region re-renders only when one of its inputs changed (HA replaces a state object when it changes). */
  _render() {
    const h = this._hass;
    if (!h || !this._built) return;
    const c = this._config;
    const st = (id) => (id ? h.states[id] : undefined);
    this._region('temp', [st(c.temperature_entity)], () => this._renderTemp());
    this._region('cond', [st(c.weather_entity), st(c.sun_entity), this._forecast, this._dayKey], () => this._renderCond());
    this._region('fc', [st(c.temperature_entity), this._forecast, this._forecastFailed, this._dayKey], () => this._renderForecast());
    this._region('rooms', c.rooms.map((r) => st(r.entity)), () => this._renderRooms());
    this._region('theater', [st(c.music), st(c.xbox.now_playing), this._xbox, this._screen], () => this._renderTheater());
    if (this._sheet !== null) {
      const cl = this._clim[c.rooms[this._sheet].entity];
      this._region('sheet', [this._sheet, ...c.rooms.map((r) => st(r.entity)), cl.temp, cl.mode, cl.fan], () => this._renderSheet());
    }
    this._region('callout', [st(c.weather_entity), st(c.sun_entity), st(c.rain_window), this._forecast, this._forecastFailed, this._radarSummary, this._minute], () => this._renderCallout());
  }

  _region(name, deps, fn) {
    const last = this._deps[name];
    if (last && last.length === deps.length && last.every((d, i) => d === deps[i])) return;
    this._deps[name] = deps;
    fn();
  }

  // ---- top: clock, date, temperature, condition -------------------------------------------------

  /** Checks every second; touches the digit text nodes only when the minute changes. */
  _tick() {
    if (!this._el) return;
    const now = new Date();
    const t = hhmm(now);
    if (t === this._shown) return;
    this._shown = t;
    [t[0], t[1], t[3], t[4]].forEach((ch, i) => {
      if (this._el.digits[i].data !== ch) this._el.digits[i].data = ch;
    });
    const d = dateLine(now);
    const day = `${d.weekday} ${d.monthDay}`;
    if (day !== this._dayKey) {
      this._dayKey = day;
      setText(this._el.wd, d.weekday);
      setText(this._el.md, d.monthDay);
      this._el.date.setAttribute('aria-label', `${d.weekday}, ${d.monthDay}.${this._tapNote.down}`);
    }
    this._minute = t;
    this._checkStale();
    this._render();
  }

  _renderTemp() {
    const id = this._config.temperature_entity;
    const t = id ? tempText(this._hass.states[id]?.state) : '';
    setText(this._el.tempDig, t);
    this._el.temp.setAttribute('aria-label', id ? `Outside, ${t === '—' ? 'unavailable' : t.replace('°', ' degrees')}.${this._tapNote.up}` : `Temperature.${this._tapNote.up}`);
  }

  _renderCond() {
    const h = this._hass;
    const c = this._config;
    const w = h.states[c.weather_entity];
    const label = conditionLabel(w?.state);
    const first = this._forecast ? forecastRows(this._forecast.daily, new Date(), 1)[0] : null;
    const today = first?.label === 'Today' ? first : null;
    const night = h.states[c.sun_entity]?.state === 'below_horizon';
    setHTML(this._el.cond, `${label ? `${icon(conditionIcon(w.state, night))}<span>${esc(label)}</span>` : ''}${today ? `<b>↑ ${today.hi}°</b><b>↓ ${today.lo}°</b>` : ''}`);
  }

  /**
   * The hidden volume taps. volume.up / volume.down are scripts that pick their own player; the toast reads the level
   * of the first target that is on, else the last one (two targets: the first when it is on, else the second).
   * No script set: the tap does nothing. No targets: the toast says only "Volume up" or "Volume down".
   */
  async _volume(dir) {
    const c = this._config;
    const script = dir === 'up' ? c.volume.up : c.volume.down;
    if (!script) return;
    const targets = c.volume.targets;
    const on = targets.findIndex((t) => this._hass.states[t]?.state === 'on');
    const i = on >= 0 ? on : targets.length - 1;
    const target = targets[i];
    const label = c.volume.labels[i] || (target && this._hass.states[target]?.attributes?.friendly_name) || 'speaker';
    const ok = await this._call('script', 'turn_on', {}, { entity_id: script }, null, `Couldn't reach the ${label}`);
    if (!ok) return;
    await new Promise((r) => setTimeout(r, 500));
    this._toast(volumeToast(label, dir, target ? this._hass.states[target]?.attributes?.volume_level : null));
  }

  // ---- bottom: forecast and rooms ---------------------------------------------------------------

  /** Weather entities no longer carry a forecast attribute: subscribe to daily and hourly forecasts. */
  _subscribe() {
    if (this._subs || this._retryTimer || !this.isConnected || !this._hass?.connection) return;
    const entity_id = this._config.weather_entity;
    if (!entity_id) return; // no weather entity: no forecast rows, no condition line
    // Messages and results from an older subscription (unsubscribed, failed or replaced) are ignored.
    const gen = (this._subGen = (this._subGen || 0) + 1);
    const parts = { daily: null, hourly: null };
    const sub = (forecast_type) =>
      this._hass.connection.subscribeMessage((msg) => {
        if (gen !== this._subGen) return;
        parts[forecast_type] = Array.isArray(msg?.forecast) ? msg.forecast : [];
        this._forecast = { daily: parts.daily || [], hourly: parts.hourly || [] };
        this._forecastAt = Date.now();
        this._forecastFailed = false;
        this._render();
      }, { type: 'weather/subscribe_forecast', entity_id, forecast_type });
    this._subs = Promise.allSettled([sub('daily'), sub('hourly')]).then((results) => {
      const unsubs = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      if (gen !== this._subGen) {
        unsubs.forEach((fn) => fn());
        return [];
      }
      if (results.some((r) => r.status === 'rejected')) {
        // A transient not_found while HA starts up is normal: show the failure, then try again in a minute.
        console.warn('wall-horizon-card: weather/subscribe_forecast failed; retrying in 60 s', results.map((r) => r.reason).filter(Boolean));
        this._subGen++;
        this._subs = null;
        this._forecastFailed = true;
        this._forecast = null;
        unsubs.forEach((fn) => fn());
        this._retryTimer = setTimeout(() => {
          this._retryTimer = null;
          this._subscribe();
        }, FORECAST_RETRY_MS);
        this._render();
        return [];
      }
      return unsubs;
    });
  }

  /** Forecast data older than 2 h counts as failed: a re-subscribe after an HA restart can fail without an error. */
  _checkStale() {
    if (!this._forecast || !this._forecastAt || Date.now() - this._forecastAt <= FORECAST_STALE_MS) return;
    console.warn('wall-horizon-card: forecast older than 2 h; resubscribing');
    this._unsubscribe();
    this._forecast = null;
    this._forecastFailed = true;
    this._subscribe();
  }

  _unsubscribe() {
    const subs = this._subs;
    this._subs = null;
    this._subGen = (this._subGen || 0) + 1;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    subs?.then((fns) => fns.forEach((fn) => {
      try {
        fn();
      } catch {
        /* the connection may already be gone */
      }
    }));
  }

  _renderForecast() {
    if (this._forecastFailed) return setHTML(this._el.fc, '<div class="fc-msg">Forecast unavailable</div>');
    if (!this._forecast) return setHTML(this._el.fc, '');
    const rows = forecastRows(this._forecast.daily, new Date(), 4);
    if (!rows.length) return setHTML(this._el.fc, '<div class="fc-msg">Forecast unavailable</div>');
    const scale = fcScale(rows);
    const now = num(this._hass.states[this._config.temperature_entity]?.state);
    setHTML(this._el.fc, rows.map((d) => {
      const l = scalePct(d.lo, scale);
      const r = scalePct(d.hi, scale);
      const dot = d.label === 'Today' && now !== null ? `<span class="fc-now" style="left:${scalePct(now, scale).toFixed(2)}%"></span>` : '';
      return `<div class="fc-row"><span class="fc-day">${d.label}</span>${icon(conditionIcon(d.condition))}<span class="fc-lo">${d.lo}°</span><span class="fc-track"><span class="fc-bar" style="left:${l.toFixed(2)}%;width:${(r - l).toFixed(2)}%;background:linear-gradient(90deg,${tcol(d.lo)},${tcol(d.hi)})"></span>${dot}</span><span class="fc-hi">${d.hi}°</span><span class="fc-pop">${popText(d.pop)}</span></div>`;
    }).join(''));
  }

  _renderRooms() {
    setHTML(this._el.rooms, this._config.rooms.map((r, i) => {
      const s = this._hass.states[r.entity];
      const v = roomView(s);
      const name = r.name || s?.attributes?.friendly_name || r.entity;
      const said = v.temp === '—' ? 'unavailable' : v.temp.replace('°', ' degrees');
      return `<button type="button" class="room" data-act="room" data-i="${i}" data-h="${v.mode}" aria-label="${esc(name)}, ${said}${v.mode ? `, ${v.mode} mode` : ''}. Opens the thermostat."><span class="hv">${icon(r.icon || 'mdi:thermostat')}</span><span class="t">${v.temp}</span><span class="n">${esc(name)}</span></button>`;
    }).join(''));
  }

  // ---- theater ------------------------------------------------------------------------------------

  _renderTheater() {
    const c = this._config;
    const h = this._hass;
    const music = c.music ? musicView(h.states[c.music]) : null;
    if (music) {
      const pic = music.picture && h.hassUrl ? h.hassUrl(music.picture) : music.picture;
      setHTML(this._el.theater, `<div class="np">${pic ? `<img class="art" alt="" src="${esc(pic)}">` : '<span class="art"></span>'}<span class="xl"><b>${esc(music.title)}</b><span>${esc(music.artist)}</span></span><button type="button" class="pp" data-act="music" aria-label="Pause">${icon('mdi:pause')}</button></div>`);
      return;
    }
    // Each control is drawn only when its entity is set: no switch, no pill; no automation, no screen button.
    const v = xboxView(this._xbox, h.states[c.xbox.now_playing]?.state);
    const now = Date.now();
    const scr = (dir) => {
      if (!c.screen[dir]) return '';
      const running = this._screen.dir === dir;
      const other = !!this._screen.dir && !running;
      const style = running ? ` style="--dur:${c.screen.seconds}s;--dl:-${((now - this._screen.t0) / 1000).toFixed(2)}s"` : '';
      return `<button type="button" class="scr" data-act="screen" data-dir="${dir}"${other ? ' disabled' : ''}${running ? ' data-run aria-disabled="true"' : ''}${style}>${icon(dir === 'down' ? 'mdi:arrow-down' : 'mdi:arrow-up')}<span>${screenLabel(dir, running)}</span><span class="bar"></span></button>`;
    };
    const xbox = c.xbox.switch ? `<button type="button" class="xbox" data-act="xbox" data-s="${v.phase}" aria-pressed="${v.pressed}"${v.disabled ? ' disabled' : ''} aria-label="Xbox, ${esc(v.sub)}">${icon('mdi:microsoft-xbox')}</button>` : '';
    setHTML(this._el.theater, `${xbox}${scr('down')}${scr('up')}`);
  }

  _setXbox(ev, render = true) {
    const before = this._xbox;
    const { state, call } = xboxStep(before, ev);
    this._xbox = state;
    const pending = (s) => s.phase === 'starting' || s.phase === 'stopping';
    if (pending(state) && !pending(before)) {
      clearTimeout(this._xboxTimer);
      this._xboxTimer = setTimeout(() => this._setXbox({ type: 'timeout' }), XBOX_TIMEOUT_MS);
    } else if (!pending(state)) {
      clearTimeout(this._xboxTimer);
      this._xboxTimer = null;
    }
    if (call) {
      // A rejection only ends the run it belongs to: a late one from an earlier tap is ignored.
      const run = (this._xboxRun = (this._xboxRun || 0) + 1);
      this._call('switch', call, {}, { entity_id: this._config.xbox.switch }, null, "Xbox didn't respond").then((ok) => {
        if (!ok && run === this._xboxRun) this._setXbox({ type: 'error' });
      });
    }
    if (render) this._render();
  }

  _screenTap(dir) {
    const c = this._config;
    const { state, call } = screenStep(this._screen, { type: 'tap', dir }, Date.now());
    if (!call) return;
    this._screen = state;
    clearTimeout(this._screenTimer);
    this._screenTimer = setTimeout(() => this._screenEnd('done'), c.screen.seconds * 1000);
    // A rejection only ends the run it belongs to: a late one from an earlier run is ignored.
    const run = (this._screenRun = (this._screenRun || 0) + 1);
    this._call('automation', 'trigger', { skip_condition: true }, { entity_id: dir === 'down' ? c.screen.down : c.screen.up }, null, "Couldn't reach the screen").then((ok) => {
      if (!ok && run === this._screenRun) this._screenEnd('error');
    });
    this._render();
  }

  _screenEnd(type) {
    clearTimeout(this._screenTimer);
    this._screen = screenStep(this._screen, { type }, Date.now()).state;
    this._render();
  }

  // ---- taps and toasts ----------------------------------------------------------------------------

  _onClick(e) {
    const el = e.target.closest?.('[data-act]');
    if (!el || el.disabled || !this._hass) return;
    const c = this._config;
    switch (el.dataset.act) {
      case 'select':
        if (c.select.remote) this._call('remote', 'send_command', { command: c.select.command, num_repeats: c.select.num_repeats, delay_secs: c.select.delay_secs }, { entity_id: c.select.remote }, `${c.select.label}: ${this._selectName}`, `Couldn't reach the ${c.select.label}`);
        break;
      case 'vol':
        this._volume(el.dataset.dir);
        break;
      case 'room':
        this._openSheet(Number(el.dataset.i));
        break;
      case 'tab':
        this._sheet = Number(el.dataset.i);
        this._render();
        break;
      case 'close':
        this._closeSheet();
        break;
      case 'step':
        this._step(Number(el.dataset.d));
        break;
      case 'mode':
      case 'fan':
        this._chip(el.dataset.act, el.dataset.v);
        break;
      case 'xbox':
        this._setXbox({ type: 'tap' });
        break;
      case 'screen':
        this._screenTap(el.dataset.dir);
        break;
      case 'music':
        this._call('media_player', 'media_play_pause', {}, { entity_id: c.music }, null, "Couldn't reach the player");
        break;
      default:
    }
  }

  /** callService with a toast on success (optional) and on failure. Resolves true or false, never rejects. */
  async _call(domain, service, data, target, okToast, failToast) {
    try {
      await this._hass.callService(domain, service, data, target);
      if (okToast) this._toast(okToast);
      return true;
    } catch (err) {
      console.warn(`wall-horizon-card: ${domain}.${service} failed`, err);
      if (failToast) this._toast(failToast);
      return false;
    }
  }

  _toast(text) {
    this._toastEl?.remove();
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = text;
    // #over paints above the thermostat sheet, so a failure shows whether the sheet is open or not.
    this._el.over.appendChild(t);
    this._toastEl = t;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.remove(), 2000);
  }

  // ---- thermostat sheet ---------------------------------------------------------------------------

  _roomName(entity) {
    const r = this._config.rooms.find((x) => x.entity === entity);
    return r?.name || this._hass?.states[entity]?.attributes?.friendly_name || entity;
  }

  /** Feeds a room's state object into its three fields once per change (HA replaces the object when it changes). */
  _feedClimate(entity, so) {
    const c = this._clim[entity];
    if (c && c.so === so) return;
    const vals = { temp: num(so?.attributes?.temperature), mode: so?.state ?? null, fan: so?.attributes?.fan_mode ?? null };
    if (!c) {
      this._clim[entity] = { so, temp: climateInit(vals.temp, CLIMATE_DEBOUNCE_MS), mode: climateInit(vals.mode), fan: climateInit(vals.fan) };
      return;
    }
    c.so = so;
    for (const f of FIELDS) this._climStep(entity, f, { type: 'entity', value: vals[f] });
  }

  /** One event through one field: sends, toasts and the next tick. The caller renders. */
  _climStep(entity, field, ev) {
    const c = this._clim[entity];
    const { state, send, toast } = climateStep(c[field], ev, Date.now());
    c[field] = state;
    if (send) this._climSend(entity, field, send);
    if (toast) this._toast(climateToast(this._roomName(entity)));
    this._climSchedule();
  }

  _climSend(entity, field, { value, run }) {
    const [service, key] = SERVICES[field];
    // A rejection only counts for the send it belongs to: climateStep ignores a superseded run.
    this._call('climate', service, { [key]: value }, { entity_id: entity }, null, null).then((ok) => {
      if (ok) return;
      this._climStep(entity, field, { type: 'error', run });
      this._render();
    });
  }

  /** One timer for every room: the earliest debounce end or confirmation timeout. */
  _climSchedule() {
    let due = null;
    for (const c of Object.values(this._clim)) {
      for (const f of FIELDS) {
        const d = climateDue(c[f]);
        if (d !== null && (due === null || d < due)) due = d;
      }
    }
    clearTimeout(this._climTimer);
    this._climTimer = due === null || !this.isConnected ? null : setTimeout(() => this._climTick(), Math.max(0, due - Date.now()));
  }

  _climTick() {
    this._climTimer = null;
    for (const entity of Object.keys(this._clim)) for (const f of FIELDS) this._climStep(entity, f, { type: 'tick' });
    this._render();
  }

  _openSheet(i) {
    this._sheet = i;
    this._el.sheet.hidden = false;
    this._el.root.classList.add('sheet-open');
    this._sheetIdle();
    this._render();
  }

  /** Closing sends any setpoint still waiting out its debounce; sends in flight keep their timeouts. */
  _closeSheet() {
    if (this._sheet === null) return;
    this._sheet = null;
    this._drag = null;
    this._el.sheet.hidden = true;
    this._el.root.classList.remove('sheet-open');
    clearTimeout(this._idleTimer);
    for (const entity of Object.keys(this._clim)) this._climStep(entity, 'temp', { type: 'flush' });
    this._render();
  }

  /** 30 s after the last touch the sheet closes; a finger still on the dial keeps it open. */
  _sheetIdle(delay = SHEET_IDLE_MS) {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this._idleFire(), delay);
  }

  /**
   * The idle close. A finger still dragging keeps the sheet open, but only while it moves: a drag with no pointermove
   * for SHEET_IDLE_MS has lost its pointerup, so it ends (up), and the close flushes its setpoint.
   */
  _idleFire() {
    const d = this._drag;
    if (d) {
      const quiet = Date.now() - d.moved;
      if (quiet < SHEET_IDLE_MS) return this._sheetIdle(SHEET_IDLE_MS - quiet);
      this._drag = null;
      this._climStep(d.entity, 'temp', { type: 'up' });
    }
    this._closeSheet();
  }


  /** The open room: its entity, fields and what the sheet shows. */
  _sheetView() {
    const entity = this._config.rooms[this._sheet].entity;
    const so = this._hass.states[entity];
    const c = this._clim[entity];
    const available = !!so && so.state !== 'unavailable' && so.state !== 'unknown';
    const mode = c.mode.shown;
    const target = c.temp.shown;
    return { entity, so, c, available, mode, target, current: num(so?.attributes?.current_temperature), range: dialRange(so?.attributes), live: dialLive(mode, available, target) };
  }

  _step(d) {
    const v = this._sheetView();
    if (!v.live) return;
    const t = Math.min(v.range.max, Math.max(v.range.min, Math.round(v.target) + d));
    if (t === v.target) return;
    this._climStep(v.entity, 'temp', { type: 'input', value: t });
    this._render();
  }

  _chip(field, value) {
    const v = this._sheetView();
    if (!v.available) return;
    this._climStep(v.entity, field, { type: 'input', value });
    this._render();
  }

  _dialXY(e) {
    const b = this._el.shSvg.getBoundingClientRect();
    return { x: ((e.clientX - b.left) / b.width) * DIAL.size, y: ((e.clientY - b.top) / b.height) * DIAL.size };
  }

  /** Any touch on the sheet restarts the idle close. On the dial: the handle starts a drag, the track jumps there first. */
  _onPointerDown(e) {
    if (this._sheet === null || !this._el?.sheet.contains(e.target)) return;
    this._sheetIdle();
    if (!this._el.shSvg.contains(e.target) || this._drag) return;
    const v = this._sheetView();
    if (!v.live) return;
    const p = this._dialXY(e);
    const h = dialPoint(dialAngle(v.target, v.range));
    const value = Math.hypot(p.x - h.x, p.y - h.y) <= 40 ? v.target : dialTap(p.x, p.y, v.range);
    if (value === null) return;
    e.preventDefault();
    this._el.shSvg.setPointerCapture?.(e.pointerId);
    this._drag = { entity: v.entity, range: v.range, id: e.pointerId, moved: Date.now() };
    this._climStep(v.entity, 'temp', { type: 'down' });
    if (value !== v.target) this._climStep(v.entity, 'temp', { type: 'input', value });
    this._paintDial();
  }

  /** A drag touches only the handle transform, the arc paths and the number; the rest renders on release. */
  _onDrag(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    if (e.type === 'pointermove') {
      d.moved = Date.now();
      const p = this._dialXY(e);
      const shown = this._clim[d.entity].temp.shown;
      const value = dialDrag(p.x, p.y, d.range, shown);
      if (value === shown) return;
      this._climStep(d.entity, 'temp', { type: 'input', value });
      this._paintDial();
      return;
    }
    this._drag = null;
    this._climStep(d.entity, 'temp', { type: 'up' });
    this._sheetIdle();
    this._render();
  }


  _renderSheet() {
    const e = this._el;
    const v = this._sheetView();
    const rooms = this._config.rooms;
    setHTML(e.shTabs, rooms.map((r, i) => {
      const so = this._hass.states[r.entity];
      const na = !so || so.state === 'unavailable' || so.state === 'unknown';
      return `<button type="button" class="tab" data-act="tab" data-i="${i}" aria-pressed="${i === this._sheet}"${na ? ' data-na' : ''}>${esc(this._roomName(r.entity))}</button>`;
    }).join(''));
    setText(e.shName, this._roomName(v.entity));
    e.sheet.style.setProperty('--mc', modeColor(v.mode, v.available));
    e.shDial.dataset.live = String(v.live);
    setText(e.dStatus, dialStatus({ mode: v.mode, target: v.target, current: v.current, available: v.available }));
    for (const b of e.steps) b.disabled = !v.live;
    const { min, max } = v.range;
    const key = `${min}-${max}`;
    if (e.dTrack.dataset.range !== key) {
      e.dTrack.dataset.range = key;
      e.dTrack.setAttribute('d', arcPath(-135, 135));
      e.dTicks.setAttribute('d', tickPath(v.range));
      for (const [el, t] of [[e.dMin, min], [e.dMax, max]]) {
        const p = dialPoint(dialAngle(t, v.range));
        el.setAttribute('x', p.x.toFixed(1));
        el.setAttribute('y', (p.y + 38).toFixed(1));
        el.textContent = String(t);
      }
    }
    const cur = v.current === null ? null : Math.min(max, Math.max(min, Math.round(v.current)));
    // Within 2° of the target the label would sit under the handle; the status line already says "· now C°".
    const tgt = num(v.target);
    const showNow = cur !== null && !(tgt !== null && Math.abs(Math.round(v.current) - tgt) <= 2);
    e.dNow.style.display = showNow ? '' : 'none';
    if (showNow) {
      const a = dialAngle(cur, v.range);
      const p = dialPoint(a);
      const q = dialPoint(a, DIAL.r + 26);
      const anchor = a > 20 ? 'start' : a < -20 ? 'end' : 'middle';
      e.dNow.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
      e.dNowT.setAttribute('text-anchor', anchor);
      setText(e.dNowT, `${Math.round(v.current)}° now`);
      // Outside the arc the label can run off the left edge (around 66°) or toward the right column (around 85°):
      // shift it so its box stays within NOW_X, measured in dial units.
      const w = e.dNowT.getComputedTextLength?.() || 0;
      const left = anchor === 'end' ? q.x - w : anchor === 'middle' ? q.x - w / 2 : q.x;
      const shift = left < NOW_X[0] ? NOW_X[0] - left : left + w > NOW_X[1] ? NOW_X[1] - (left + w) : 0;
      e.dNowT.setAttribute('x', (q.x + shift - p.x).toFixed(1));
      e.dNowT.setAttribute('y', (q.y - p.y).toFixed(1));
    }
    e.dRing.classList.toggle('sending', !!v.c.temp.pending);
    // Unavailable entities report no lists: show every chip, disabled, so the column keeps its shape.
    const chip = (act, [val, label], f, color) => `<button type="button" class="chip" data-act="${act}" data-v="${esc(val)}" aria-pressed="${val === f.shown}"${f.pending?.value === val ? ' data-pending' : ''}${v.available ? '' : ' disabled'} style="--c:${color}">${act === 'mode' ? '<i></i>' : ''}${label}</button>`;
    const modes = v.available ? chipsFor(MODE_CHIPS, v.so.attributes?.hvac_modes) : MODE_CHIPS;
    const fans = v.available ? chipsFor(FAN_CHIPS, v.so.attributes?.fan_modes) : FAN_CHIPS;
    setHTML(e.shModes, modes.map((ch) => chip('mode', ch, v.c.mode, MODE_COLORS[ch[0]])).join(''));
    setHTML(e.shFans, fans.map((ch) => chip('fan', ch, v.c.fan, '#f3f6fb')).join(''));
    this._paintDial();
  }

  _paintDial() {
    const e = this._el;
    const v = this._sheetView();
    const t = num(v.target);
    e.dHandle.style.display = t === null ? 'none' : '';
    if (t !== null) {
      const p = dialPoint(dialAngle(Math.min(v.range.max, Math.max(v.range.min, t)), v.range));
      e.dHandle.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    }
    const fill = v.live ? fillPath(v.current, t, v.range) : '';
    e.dFill.setAttribute('d', fill);
    e.dGlow.setAttribute('d', fill);
    // No target in Off, Dry or Fan: the room temperature, dimmed; else the target or "—".
    const centre = dialCentre(v.mode, t, v.current);
    setText(e.dNum, centre.text);
    e.dNum.classList.toggle('room', centre.room);
  }

  // ---- callout and calm mode -----------------------------------------------------------------------

  _onRadar() {
    const el = this._radar;
    if (!el) return;
    const ds = { ...el.dataset };
    this._el.scrims?.classList.toggle('sat', strongScrim(ds));
    // show_attribution: false on the card, or in its radar: block, turns the credit line off.
    const credited = this._config.show_attribution !== false && this._config.radar.show_attribution !== false;
    setText(this._el.credit, credited ? ds.credits || '' : '');
    const summary = readRadar(ds);
    const key = JSON.stringify(summary);
    if (key !== this._radarKey) {
      this._radarKey = key;
      this._radarSummary = summary;
      this._render();
    }
    const echoes = newestObservedEchoes(ds);
    if (echoes !== undefined && echoes !== this._echoes) {
      this._echoes = echoes;
      this._updateCalm();
    }
    if (!this._radarSupportsHome && 'homeDbz' in ds) {
      this._radarSupportsHome = true;
      this._layoutGeo();
    }
  }

  _layoutGeo() {
    if (!this._size || !this._el) return;
    const hp = this._config.radar.home_position;
    const valid = Array.isArray(hp) && hp.length === 2 && hp.every((v) => Number.isFinite(Number(v)));
    const home = homePoint(this._radarSupportsHome && valid ? hp.map(Number) : [0.5, 0.5], this._size.W, this._size.H);
    const g = calloutGeometry(home);
    const px = (v) => `${v.toFixed(1)}px`;
    Object.assign(this._el.home.style, { left: px(home.x), top: px(home.y) });
    Object.assign(this._el.lead.style, { left: px(g.lead.x), top: px(g.lead.y), width: px(g.lead.len), transform: `rotate(${g.lead.angle.toFixed(2)}deg)` });
    Object.assign(this._el.call.style, { left: px(g.cx), top: px(g.cy) });
    this._el.callTxt.style.maxWidth = px(g.maxText);
  }

  _renderCallout() {
    const h = this._hass;
    const c = this._config;
    const sun = h.states[c.sun_entity];
    const state = {
      now: new Date(),
      radar: this._radarSummary,
      condition: h.states[c.weather_entity]?.state ?? null,
      forecast: this._forecastFailed ? null : this._forecast,
      rainWindow: c.rain_window ? parseRainWindow(h.states[c.rain_window]?.state) : null,
      sun: {
        up: sun?.state === 'above_horizon' ? true : sun?.state === 'below_horizon' ? false : null,
        nextRising: toDate(sun?.attributes?.next_rising),
        nextSetting: toDate(sun?.attributes?.next_setting),
      },
      thresholds: this._thresholds,
    };
    const r = callout(state);
    this._rule = r.rule;
    this.dataset.rule = String(r.rule);
    setText(this._el.callHead, r.head);
    setText(this._el.callSub, r.sub);
    const ic = calloutIcon(r.rule, state.condition);
    if (this._el.callIcon.getAttribute('icon') !== ic) this._el.callIcon.setAttribute('icon', ic);
    this._updateCalm();
  }

  _updateCalm() {
    if (!this._el) return;
    const calm = isCalm({ radar: this._radarSummary, echoes: this._echoes, rule: this._rule, floor: this._config.calm_echo_floor });
    const drift = calm && this._config.calm_drift !== false && !reducedMotion();
    this._el.root.classList.toggle('calm', calm);
    this._el.root.classList.toggle('drifting', drift);
    this.dataset.calm = calm ? (drift ? 'drift' : 'still') : '';
  }
}

// A second copy (e.g. the resource listed under two ?v= values) must not throw.
if (!customElements.get('wall-horizon-card')) {
  customElements.define('wall-horizon-card', WallHorizonCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'wall-horizon-card',
    name: 'Wall Horizon Card',
    description: 'A wall display: a full-screen radar with the clock, weather, rooms and TV controls around its edges.',
  });
}

export { WallHorizonCard };
