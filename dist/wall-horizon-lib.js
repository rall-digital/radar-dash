// wall-horizon-lib: the pure logic behind wall-horizon-card. No DOM and no Home Assistant objects:
// every function takes plain values, so it can be tested without a browser.

// ---- values and time ------------------------------------------------------------------------

export const two = (n) => String(n).padStart(2, '0');

/** A finite number from a number or numeric string, else null ("", "unavailable", null, NaN). */
export function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A valid Date from a Date or an ISO string, else null. */
export function toDate(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** 24-hour local time, "HH:MM". */
export function hhmm(date) {
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The one-line date: { weekday: 'Wednesday', monthDay: 'September 23' }, en-US, local time. */
export function dateLine(date) {
  return {
    weekday: date.toLocaleDateString('en-US', { weekday: 'long' }),
    monthDay: date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
  };
}

export const weekdayLong = (date) => date.toLocaleDateString('en-US', { weekday: 'long' });
export const weekdayShort = (date) => date.toLocaleDateString('en-US', { weekday: 'short' });

/** Local calendar day as an integer: two times on the same local day give the same number. */
export function localDay(date) {
  return Math.floor((date.getTime() - date.getTimezoneOffset() * 60000) / 86400000);
}

/** "67°" (rounded), or "—" when the value is missing or not a number. */
export function tempText(v) {
  const n = num(v);
  return n === null ? '—' : `${Math.round(n)}°`;
}

// ---- weather conditions ---------------------------------------------------------------------

const CONDITIONS = {
  'clear-night': ['Clear', 'mdi:weather-night'],
  cloudy: ['Cloudy', 'mdi:weather-cloudy'],
  exceptional: ['Unusual weather', 'mdi:alert-circle-outline'],
  fog: ['Fog', 'mdi:weather-fog'],
  hail: ['Hail', 'mdi:weather-hail'],
  lightning: ['Thunderstorms', 'mdi:weather-lightning'],
  'lightning-rainy': ['Thunderstorms', 'mdi:weather-lightning-rainy'],
  partlycloudy: ['Partly cloudy', 'mdi:weather-partly-cloudy'],
  pouring: ['Pouring', 'mdi:weather-pouring'],
  rainy: ['Rain', 'mdi:weather-rainy'],
  snowy: ['Snow', 'mdi:weather-snowy'],
  'snowy-rainy': ['Sleet', 'mdi:weather-snowy-rainy'],
  sunny: ['Sunny', 'mdi:weather-sunny'],
  windy: ['Windy', 'mdi:weather-windy'],
  'windy-variant': ['Windy', 'mdi:weather-windy-variant'],
};

/** Display text for a Home Assistant weather state; '' for unknown states. */
export function conditionLabel(state) {
  return CONDITIONS[state]?.[0] ?? '';
}

/** mdi icon for a weather state; at night, partly cloudy and sunny use the night variants. */
export function conditionIcon(state, night = false) {
  if (night && state === 'partlycloudy') return 'mdi:weather-night-partly-cloudy';
  if (night && state === 'sunny') return 'mdi:weather-night';
  return CONDITIONS[state]?.[1] ?? 'mdi:weather-cloudy';
}

// ---- forecast rows --------------------------------------------------------------------------

const COOL = [112, 186, 255]; // #70baff at 42 °F or below
const MID = [205, 212, 224]; // #cdd4e0 at 62 °F
const WARM = [255, 180, 88]; // #ffb458 at 76 °F or above

/** Diverging bar colour around 62 °F, as "rgb(r g b)". */
export function tcol(t) {
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const c = t <= 62 ? mix(MID, COOL, Math.min(1, (62 - t) / 20)) : mix(MID, WARM, Math.min(1, (t - 62) / 14));
  return `rgb(${c.join(' ')})`;
}

/** One scale for every bar: the lowest low minus 2 to the highest high plus 2. */
export function fcScale(rows) {
  return [Math.min(...rows.map((d) => d.lo)) - 2, Math.max(...rows.map((d) => d.hi)) + 2];
}

/** Position of t on a scale, in percent, clamped to the track. */
export function scalePct(t, [a, b]) {
  if (!(b > a)) return 50;
  return Math.max(0, Math.min(100, ((t - a) / (b - a)) * 100));
}

/** Rain chance text, shown only at 30% or more. */
export function popText(pop) {
  const n = num(pop);
  return n !== null && n >= 30 ? `${Math.round(n)}%` : '';
}

/**
 * The daily rows: forecast entries from today's local date on, at most n.
 * Each row: { date, label ('Today' or 'Thu'), lo, hi, pop (number or null), condition }.
 * An entry for a past day (a list fetched before midnight) is skipped.
 */
export function forecastRows(daily, now, n = 4) {
  const today = localDay(now);
  const rows = [];
  for (const d of daily || []) {
    const date = toDate(d?.datetime);
    const hi = num(d?.temperature);
    if (!date || hi === null || localDay(date) < today) continue;
    const lo = num(d.templow) ?? hi;
    rows.push({
      date,
      label: localDay(date) === today ? 'Today' : weekdayShort(date),
      lo: Math.round(lo),
      hi: Math.round(hi),
      pop: num(d.precipitation_probability),
      condition: d.condition || '',
    });
    if (rows.length === n) break;
  }
  return rows;
}

/** Lowest hourly temperature from this hour until `until` (the next sunrise), rounded; null if none. */
export function overnightLow(hourly, now, until) {
  if (!until) return null;
  let low = null;
  for (const h of hourly || []) {
    const t = toDate(h?.datetime);
    const v = num(h?.temperature);
    if (!t || v === null || t.getTime() <= now.getTime() - 3600000 || t > until) continue;
    low = low === null ? v : Math.min(low, v);
  }
  return low === null ? null : Math.round(low);
}

// ---- layout ---------------------------------------------------------------------------------

/** Design-space fit: the 1280 x 800 overlay scaled by min(W/1280, H/800) and centred in a W x H card. */
export function designFit(W, H) {
  const s = Math.min(W / 1280, H / 800);
  return { s, ox: (W - 1280 * s) / 2, oy: (H - 800 * s) / 2 };
}

/** The radar's home point in design px, for home_position fractions of a W x H card. */
export function homePoint(hp, W, H) {
  const { s, ox, oy } = designFit(W, H);
  return { x: (hp[0] * W - ox) / s, y: (hp[1] * H - oy) / s };
}

/**
 * Callout geometry: the pill's top-left 58 px right of and 38 px below the home point, a leader from the
 * dot to the pill's left edge, and the widest the pill's text may be so the pill ends by `rightLimit`.
 * 1254 keeps the night headline on one line:
 * "Clear tonight, N° by morning" measures at most 385.4 px in Wall Fredoka for N from 0 to 99 (22° is the widest), so
 * 1254 - 778 - 90 = 386 fits every one. Past it (a negative low, a long warning) the text wraps.
 */
export function calloutGeometry(home, rightLimit = 1254) {
  const cx = home.x + 58;
  const cy = home.y + 38;
  const x = home.x + 6;
  const y = home.y + 6;
  const dx = cx - x;
  const dy = cy + 36 - y;
  return {
    cx,
    cy,
    lead: { x, y, len: Math.hypot(dx, dy), angle: (Math.atan2(dy, dx) * 180) / Math.PI },
    maxText: Math.max(200, rightLimit - cx - 90), // 90 = 16 + 24 padding, 34 icon, 14 gap, 2 border
  };
}

/**
 * Font metrics in em from canvas measurements at 100 px: the widest digit, the
 * colon's box, the digit height (actualBoundingBoxAscent) and the line-box top to digit top at line-height 1.
 */
export function fontMetrics({ digitWidths, colonWidth, ascent, fontAscent, fontDescent }) {
  const cap = ascent || 72;
  const asc = fontAscent || 92;
  const desc = fontDescent || 24;
  return {
    dw: Math.max(...digitWidths) / 100,
    cw: Math.min(Math.max(colonWidth * 1.1, 22), 40) / 100,
    cap: cap / 100,
    top: ((100 - asc - desc) / 2 + asc - cap) / 100,
  };
}

/** The clock: the largest digit height up to `cap` whose four digit boxes and colon fit `maxw`. */
export function fitClock(m, cap, maxw) {
  const size = Math.min(cap / m.cap, maxw / (4 * m.dw + m.cw));
  return { size, digitH: m.cap * size, width: (4 * m.dw + m.cw) * size, shift: m.top * size };
}

/** A number at a fixed digit height. */
export function fitNumber(m, cap) {
  const size = cap / m.cap;
  return { size, digitH: cap, shift: m.top * size };
}

// ---- radar layer config ---------------------------------------------------------------------

/** The embedded wall-radar-card's config: the radar: block plus the layout's fixed keys. */
export function radarConfig(radar) {
  return { ...radar, type: 'custom:wall-radar-card', height: '100%', show_color_bar: false, show_progress: false };
}

/** An older wall-radar-card rejects ink, night and auto: retry on its default basemap. */
export function radarFallback(cfg) {
  if (!['ink', 'night', 'auto'].includes(cfg.basemap)) return null;
  const { basemap, day_basemap, night_basemap, ...rest } = cfg;
  return rest;
}

/** HTML-escape text for innerHTML. */
export const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// ---- rain timing ----------------------------------------------------------------------------

/**
 * The optional rain_window helper (an input_text you fill from your own automation) as "phase|start|end|misses":
 * phase is none, soon or raining; start and end are ISO times of the hours at 60% or more.
 */
export function parseRainWindow(state) {
  const [phase, start, end] = String(state ?? '').split('|');
  if (phase !== 'soon' && phase !== 'raining') return { phase: 'none', start: null, end: null };
  return { phase, start: toDate(start), end: toDate(end) };
}

/**
 * The first run of hourly entries in the next `hours` (this hour included) with a rain chance at or
 * above `min`: { start, end, pop } where end is the hour after the run and pop its highest chance.
 */
export function rainRun(hourly, now, min, hours = 12) {
  const from = now.getTime() - 3600000;
  const to = now.getTime() + hours * 3600000;
  let run = null;
  for (const h of hourly || []) {
    const t = toDate(h?.datetime);
    const pop = num(h?.precipitation_probability);
    if (!t || pop === null) continue;
    const ms = t.getTime();
    if (!run) {
      if (ms > from && ms <= to && pop >= min) run = { start: t, end: new Date(ms + 3600000), pop };
    } else if (pop >= min && ms === run.end.getTime()) {
      run.end = new Date(ms + 3600000);
      run.pop = Math.max(run.pop, pop);
    } else if (ms >= run.end.getTime()) {
      break;
    }
  }
  return run && { ...run, pop: Math.round(run.pop) };
}

/** Highest hourly rain chance from the hour containing `start` up to `end` (or one hour); null if none. */
export function maxPop(hourly, start, end) {
  const from = start.getTime() - (start.getTime() % 3600000);
  const to = end ? end.getTime() : from + 3600000;
  let best = null;
  for (const h of hourly || []) {
    const t = toDate(h?.datetime);
    const p = num(h?.precipitation_probability);
    if (!t || p === null || t.getTime() < from || t.getTime() >= to) continue;
    best = best === null ? p : Math.max(best, p);
  }
  return best === null ? null : Math.round(best);
}

/** The first day after today, up to six days out, with a rain chance at or above `min`. */
export function wetDay(daily, now, min) {
  const today = localDay(now);
  for (const d of daily || []) {
    const date = toDate(d?.datetime);
    const pop = num(d?.precipitation_probability);
    if (!date || pop === null) continue;
    const ahead = localDay(date) - today;
    if (ahead >= 1 && ahead <= 6 && pop >= min) return { date, pop: Math.round(pop) };
  }
  return null;
}

// ---- radar card attributes ------------------------------------------------------------------

// The attributes wall-radar-card adds for Horizon. Absent or '' means unknown; a number string is a measurement.
const RADAR_KEYS = ['nowDbz', 'rainAt', 'rainPeakDbz', 'homeWarnings', 'echoes', 'homeDbz'];

/**
 * The radar card's summary numbers from its dataset (a plain-object copy), or null when it publishes none of them
 * (an older wall-radar-card). Absent or '' means unknown:
 *   nowDbz, peakDbz: number or null (a dry home reads about -10);  rainAt: Date or null ('' = no forecast rain);
 *   rainKnown: the summaries have been written;  forecastFrames: number;
 *   warnings: null while data-home-warnings is absent (the feed has not answered, so rule 1 is skipped),
 *   [] when it is '' (nothing covers home), else [{ phenomena, expire_utc }].
 */
export function readRadar(ds) {
  if (!ds || !RADAR_KEYS.some((k) => k in ds)) return null;
  let warnings = null;
  if ('homeWarnings' in ds) {
    try {
      const w = ds.homeWarnings ? JSON.parse(ds.homeWarnings) : [];
      warnings = Array.isArray(w) ? w : null;
    } catch {
      warnings = null;
    }
  }
  return {
    nowDbz: num(ds.nowDbz),
    rainAt: toDate(ds.rainAt),
    rainKnown: 'rainAt' in ds,
    peakDbz: num(ds.rainPeakDbz),
    warnings,
    forecastFrames: num(ds.forecastFrames) ?? 0,
  };
}

/** Whether the top-right scrim is strengthened: while the radar card shows the satellite basemap (data-basemap),
 * whose bright, busy terrain competes with the temperature and condition. Ink, night and unknown keep the usual one. */
export function strongScrim(ds) {
  return ds?.basemap === 'satellite';
}

/** data-echoes while the newest observed frame is on screen; undefined for any other frame. */
export function newestObservedEchoes(ds) {
  if (!ds || ds.frameKind !== 'observed' || !('echoes' in ds)) return undefined;
  const frame = num(ds.frame);
  const frames = num(ds.frames);
  const fc = num(ds.forecastFrames) ?? 0;
  if (frame === null || frames === null || frame !== frames - fc - 1) return undefined;
  return num(ds.echoes) ?? undefined;
}

// ---- rain callout ---------------------------------------------------------------------------

export const CALLOUT_DEFAULTS = { rain_dbz: 20, heavy_dbz: 45, moderate_dbz: 30, hourly_pop: 60, daily_pop: 50 };
const WARNING_NAMES = { TO: 'Tornado warning', SV: 'Severe thunderstorm warning', FF: 'Flash flood warning', MA: 'Marine warning' };
const SEVERITY = ['TO', 'SV', 'FF', 'MA'];
const WET = ['rainy', 'pouring', 'lightning-rainy'];
const RAIN_IMMINENT_MS = 30 * 60000;

/** The most severe unexpired warning; among equals, the one that runs longest. */
function pickWarning(list, now) {
  let best = null;
  for (const w of list) {
    const rank = SEVERITY.indexOf(w?.phenomena);
    if (rank < 0) continue;
    const expire = toDate(w.expire_utc);
    if (expire && expire <= now) continue;
    const t = expire ? expire.getTime() : -Infinity;
    if (!best || rank < best.rank || (rank === best.rank && t > best.t)) best = { phenomena: w.phenomena, expire, rank, t };
  }
  return best;
}

/**
 * The rain callout: the first rule that matches wins.
 * state = {
 *   now: Date,
 *   radar: readRadar() result, or null when the radar numbers are missing,
 *   condition: the weather entity's state, or null,
 *   forecast: { daily: [], hourly: [] }, or null when the subscription failed or has not answered,
 *   rainWindow: parseRainWindow() result, or null,
 *   sun: { up: true | false | null, nextRising: Date | null, nextSetting: Date | null },
 *   thresholds: CALLOUT_DEFAULTS (rain_dbz is the radar card's echo_dbz),
 * }
 * Returns { head, sub, rule }.
 */
export function callout(state) {
  const { now, radar = null, condition = null, forecast = null, rainWindow = null } = state;
  const sun = state.sun || {};
  const th = { ...CALLOUT_DEFAULTS, ...(state.thresholds || {}) };

  // 1. A warning covers home.
  const warning = radar?.warnings ? pickWarning(radar.warnings, now) : null;
  if (warning) {
    const until = warning.expire ? ` until ${hhmm(warning.expire)}` : '';
    return { head: `${WARNING_NAMES[warning.phenomena]}${until}`, sub: '', rule: 1 };
  }

  // 2. Raining at home now. Without a radar reading at home ('' or absent: unknown), the weather entity's condition decides.
  if (radar && radar.nowDbz !== null) {
    if (radar.nowDbz >= th.rain_dbz) {
      return { head: radar.nowDbz >= th.heavy_dbz ? 'Heavy rain now' : 'Raining now', sub: '', rule: 2 };
    }
  } else if (WET.includes(condition)) {
    return { head: condition === 'pouring' ? 'Heavy rain now' : 'Raining now', sub: '', rule: 2 };
  }

  // 3. Rain soon, from the HRRR frames. None are listed when v2 hides a stale run. rainAt stays in the past until the
  // radar's next forecast poll (2 min, up to 30 under backoff): up to 30 min past it is imminent, beyond that stale.
  if (radar && radar.forecastFrames > 0 && radar.rainAt && now - radar.rainAt <= RAIN_IMMINENT_MS) {
    const p = radar.peakDbz;
    const sub = p === null ? '' : p >= th.heavy_dbz ? 'Heavy at times' : p < th.moderate_dbz ? 'Light' : 'Moderate';
    return { head: radar.rainAt > now ? `Rain from about ${hhmm(radar.rainAt)}` : 'Rain any minute', sub, rule: 3 };
  }

  if (forecast) {
    // 4. Rain later today. The rain_window helper's window, when it has one, wins over the hourly scan.
    const run = rainRun(forecast.hourly, now, th.hourly_pop, 12);
    const win = rainWindow?.start && (!rainWindow.end || rainWindow.end > now) ? rainWindow : null;
    const start = win ? win.start : run?.start;
    if (start) {
      const end = win ? win.end : run.end;
      const pop = maxPop(forecast.hourly, start, end) ?? run?.pop ?? null;
      const head = start > now ? `Rain likely from ${hhmm(start)}` : end ? `Rain likely until ${hhmm(end)}` : 'Rain likely now';
      return { head, sub: pop === null ? '' : `${pop}% chance`, rule: 4 };
    }
    // 5. Rain later this week.
    const day = wetDay(forecast.daily, now, th.daily_pop);
    if (day) return { head: `Rain likely ${weekdayLong(day.date)}`, sub: `${day.pop}% chance`, rule: 5 };
  }

  // 6. Night.
  if (sun.up === false) {
    const sub = sun.nextRising ? `Sunrise ${hhmm(sun.nextRising)}` : '';
    if (condition === 'clear-night' || condition === 'sunny') {
      const low = forecast ? overnightLow(forecast.hourly, now, sun.nextRising) : null;
      return { head: low === null ? 'Clear tonight' : `Clear tonight, ${low}° by morning`, sub, rule: 6 };
    }
    const label = conditionLabel(condition);
    return { head: label ? `${label} tonight` : 'Tonight', sub, rule: 6 };
  }

  // 7. Otherwise. With no radar reading, no known condition and no forecast there is nothing to call dry.
  if (!(radar && radar.nowDbz !== null) && !conditionLabel(condition) && !forecast) {
    return { head: 'Weather unavailable', sub: '', rule: 7 };
  }
  const rows = forecast ? forecastRows(forecast.daily, now, 4) : [];
  const last = rows[rows.length - 1];
  const head = !last ? 'Dry for now' : rows.length === 1 ? 'Dry today' : `Dry through ${weekdayLong(last.date)}`;
  return { head, sub: sun.nextSetting ? `Sunset ${hhmm(sun.nextSetting)}` : '', rule: 7 };
}

/** The callout's icon for a rule. */
export function calloutIcon(rule, condition) {
  if (rule === 1) return 'mdi:alert';
  if (rule === 2) return 'mdi:weather-pouring';
  if (rule === 3) return 'mdi:weather-rainy';
  if (rule === 4 || rule === 5) return 'mdi:umbrella-outline';
  if (rule === 6) return condition === 'clear-night' || condition === 'sunny' ? 'mdi:weather-night' : conditionIcon(condition, true);
  return conditionIcon(condition, false);
}

/**
 * Calm mode: the radar summaries are known and show no forecast rain at home, the newest observed
 * frame has at most `floor` echo pixels (the field as drawn is not reliably 0 on a dry day: 0 in 11 of 14 dry frames,
 * up to 40), and the callout is on rule 6 or 7. rainAt '' means both "unknown" and "none", so calm also waits until a
 * forecast tile has rendered (peakDbz known), unless there are no forecast frames at all.
 */
export function isCalm({ radar, echoes, rule, floor = 50 }) {
  return !!radar && radar.rainKnown && !radar.rainAt && (radar.forecastFrames === 0 || radar.peakDbz !== null)
    && typeof echoes === 'number' && echoes <= floor && (rule === 6 || rule === 7);
}

// ---- theater --------------------------------------------------------------------------------

export const XBOX_TIMEOUT_MS = 30000;
const confirmedOf = (v) => (v === 'on' || v === 'off' ? v : 'unavailable');

/** The Xbox toggle's state for the xbox.switch entity's state string. */
export function xboxInit(entityState) {
  const c = confirmedOf(entityState);
  return { phase: c, confirmed: c, note: '' };
}

/**
 * One event through the Xbox toggle. phase: off | starting | on | stopping | unavailable.
 * ev: { type: 'entity', value } | { type: 'tap' } | { type: 'timeout' } | { type: 'error' }.
 * Returns { state, call } where call is 'turn_on', 'turn_off' or null.
 */
export function xboxStep(s, ev) {
  const keep = { state: s, call: null };
  switch (ev.type) {
    case 'entity': {
      const c = confirmedOf(ev.value);
      if (c === 'unavailable') return { state: { phase: c, confirmed: c, note: '' }, call: null };
      if (s.phase === 'starting') return { state: c === 'on' ? { phase: 'on', confirmed: c, note: '' } : { ...s, confirmed: c }, call: null };
      if (s.phase === 'stopping') return { state: c === 'off' ? { phase: 'off', confirmed: c, note: '' } : { ...s, confirmed: c }, call: null };
      return { state: { phase: c, confirmed: c, note: c === s.confirmed ? s.note : '' }, call: null };
    }
    case 'tap':
      if (s.phase === 'off') return { state: { ...s, phase: 'starting', note: '' }, call: 'turn_on' };
      if (s.phase === 'on') return { state: { ...s, phase: 'stopping', note: '' }, call: 'turn_off' };
      return keep;
    case 'timeout':
      if (s.phase === 'starting') return { state: { ...s, phase: 'off', note: "Didn't start. Tap to try again" }, call: null };
      if (s.phase === 'stopping') return { state: { ...s, phase: 'on', note: "Didn't turn off. Tap to try again" }, call: null };
      return keep;
    case 'error':
      if (s.phase === 'starting' || s.phase === 'stopping') return { state: { ...s, phase: s.confirmed, note: '' }, call: null };
      return keep;
    default:
      return keep;
  }
}

/** What the Xbox pill shows: { phase, sub, disabled, pressed }. nowPlaying is the gamertag sensor's state. */
export function xboxView(s, nowPlaying) {
  const game = typeof nowPlaying === 'string' && nowPlaying && !['unknown', 'unavailable'].includes(nowPlaying) ? nowPlaying : '';
  const sub = {
    unavailable: 'Unavailable',
    starting: 'Starting…',
    stopping: 'Turning off…',
    off: s.note || 'Off',
    on: s.note || game || 'On',
  }[s.phase];
  return { phase: s.phase, sub, disabled: s.phase === 'unavailable', pressed: s.phase === 'on' };
}

/**
 * The two screen buttons: { dir: null | 'down' | 'up', t0 }. A tap starts a run only when neither runs.
 * ev: { type: 'tap', dir } | { type: 'done' } | { type: 'error' }. Returns { state, call } (call is the dir or null).
 */
export function screenStep(s, ev, now) {
  if (ev.type === 'tap') return s.dir ? { state: s, call: null } : { state: { dir: ev.dir, t0: now }, call: ev.dir };
  if (ev.type === 'done' || ev.type === 'error') return { state: { dir: null, t0: 0 }, call: null };
  return { state: s, call: null };
}

export function screenLabel(dir, running) {
  if (dir === 'down') return running ? 'Lowering…' : 'Screen down';
  return running ? 'Raising…' : 'Screen up';
}

/** Toast after a volume tap: the target's level, or the direction when it reports none. */
export function volumeToast(label, dir, level) {
  const n = num(level);
  return n === null ? (dir === 'up' ? 'Volume up' : 'Volume down') : `${label} volume ${Math.round(n * 100)}%`;
}

/** A room readout from a climate state object: { temp: '73°' | '—', mode: 'cool' | 'heat' | '' }. */
export function roomView(stateObj) {
  if (!stateObj || stateObj.state === 'unavailable' || stateObj.state === 'unknown') return { temp: '—', mode: '' };
  return {
    temp: tempText(stateObj.attributes?.current_temperature),
    mode: stateObj.state === 'cool' || stateObj.state === 'heat' ? stateObj.state : '',
  };
}

/** The now-playing pill, or null unless the player is playing. */
export function musicView(stateObj) {
  if (stateObj?.state !== 'playing') return null;
  const a = stateObj.attributes || {};
  return { title: a.media_title || '', artist: a.media_artist || '', picture: a.entity_picture || '' };
}

// ---- thermostat dial --------------------------------------------------------------------------
// Dial units are the SVG viewBox,
// 460 square, drawn 560 design px square. Angles are degrees clockwise from 12 o'clock.

export const DIAL = { size: 460, cx: 230, cy: 230, r: 200, band: 28 };

/** The target range from a climate entity's min_temp and max_temp, in whole degrees; 61-88 when missing or inverted. */
export function dialRange(attrs) {
  const lo = num(attrs?.min_temp);
  const hi = num(attrs?.max_temp);
  if (lo === null || hi === null || !(Math.floor(hi) > Math.ceil(lo))) return { min: 61, max: 88 };
  return { min: Math.ceil(lo), max: Math.floor(hi) };
}

/** The arc's angle for a temperature: min at -135 (lower left), max at +135 (lower right), the gap at the bottom. */
export function dialAngle(t, { min, max }) {
  return -135 + ((t - min) / (max - min)) * 270;
}

/** The dial-unit point at an angle and radius. */
export function dialPoint(angle, r = DIAL.r) {
  const a = (angle * Math.PI) / 180;
  return { x: DIAL.cx + r * Math.sin(a), y: DIAL.cy - r * Math.cos(a) };
}

/** The angle of a dial-unit point, in (-180, 180]: 0 at 12 o'clock, 90 at 3 o'clock, 180 straight down. */
export function pointAngle(x, y) {
  const a = (Math.atan2(x - DIAL.cx, DIAL.cy - y) * 180) / Math.PI;
  return a === -180 ? 180 : a;
}

/** The whole degree at an angle on the arc, clamped to the range; null in the gap. */
function degreeAt(angle, { min, max }) {
  if (Math.abs(angle) > 135) return null;
  return Math.min(max, Math.max(min, Math.round(min + ((angle + 135) / 270) * (max - min))));
}

/** A tap at a dial-unit point: the degree under it on the track, or null off the track or in the gap. */
export function dialTap(x, y, range) {
  if (Math.abs(Math.hypot(x - DIAL.cx, y - DIAL.cy) - DIAL.r) > DIAL.band) return null;
  return degreeAt(pointAngle(x, y), range);
}

/**
 * A drag to a dial-unit point: the degree at its angle. In the gap a drag stays at the end it last reached (prev), so
 * the handle never jumps across the gap; from elsewhere it goes to the nearer end. Two guards against jumps:
 *   - within DRAG_DEAD * r of the centre the angle swings wildly, so a drag there keeps prev;
 *   - at an end, a degree in the far half of the range means the finger went round the gap (past 61, across the
 *     bottom and up the right side), so the drag keeps the end until the finger comes back to the near half.
 */
const DRAG_DEAD = 0.4;
export function dialDrag(x, y, range, prev) {
  if (Math.hypot(x - DIAL.cx, y - DIAL.cy) < DRAG_DEAD * DIAL.r) return prev;
  const angle = pointAngle(x, y);
  const t = degreeAt(angle, range);
  const atEnd = prev === range.min || prev === range.max;
  if (t !== null) return atEnd && Math.abs(t - prev) > (range.max - range.min) / 2 ? prev : t;
  if (atEnd) return prev;
  return angle < 0 ? range.min : range.max;
}

const f1 = (v) => v.toFixed(1);

/** An SVG arc clockwise from angle a to angle b at radius r; '' unless b > a. */
export function arcPath(a, b, r = DIAL.r) {
  if (!(b > a)) return '';
  const p = dialPoint(a, r);
  const q = dialPoint(b, r);
  return `M${f1(p.x)} ${f1(p.y)} A${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${f1(q.x)} ${f1(q.y)}`;
}

/** The fill between the current temperature (rounded, clamped to the range) and the target; '' when either is unknown or they are equal. */
export function fillPath(current, target, range) {
  const c = num(current);
  const t = num(target);
  if (c === null || t === null) return '';
  const cc = Math.min(range.max, Math.max(range.min, Math.round(c)));
  const [a, b] = [dialAngle(cc, range), dialAngle(t, range)].sort((x, y) => x - y);
  return arcPath(a, b);
}

/** One short radial tick per whole degree, inside the track, as one SVG path. */
export function tickPath(range, r0 = DIAL.r - 27, r1 = DIAL.r - 19) {
  let d = '';
  for (let t = range.min; t <= range.max; t++) {
    const a = dialAngle(t, range);
    const p = dialPoint(a, r0);
    const q = dialPoint(a, r1);
    d += `M${f1(p.x)} ${f1(p.y)}L${f1(q.x)} ${f1(q.y)}`;
  }
  return d;
}

/** A temperature rounded for display: whole degrees by default (digits 0), else to `digits` decimals. */
const roundTo = (v, digits) => (digits ? Number(v.toFixed(digits)) : Math.round(v));

/**
 * The status line under the dial's number; digits (default 0: whole degrees) is the decimals shown and compared. mode is the climate state; target and current are
 * numbers or null. It never claims the unit is running, since nothing reports that. Also: with no
 * current temperature Cool and Heat read "Cool to T°" and "Heat to T°", and with no target "Cool", "Heat" or "Auto".
 */
export function dialStatus({ mode, target, current, available = true, digits = 0 }) {
  if (!available) return 'Unavailable';
  const c = num(current);
  const C = c === null ? null : roundTo(c, digits);
  const t = num(target);
  const T = t === null ? null : roundTo(t, digits);
  const now = C === null ? '' : ` · now ${C}°`;
  const to = (verb) => (T === null ? `${verb}${now}` : `${verb} to ${T}°${now}`);
  switch (mode) {
    case 'cool':
      if (T !== null && C !== null) return C > T ? `Cooling to ${T}°${now}` : `Holding ${T}°${now}`;
      return to('Cool');
    case 'heat':
      if (T !== null && C !== null) return C < T ? `Heating to ${T}°${now}` : `Holding ${T}°${now}`;
      return to('Heat');
    case 'heat_cool':
      return to('Auto');
    case 'dry':
      return `Drying${now}`;
    case 'fan_only':
      return `Fan only${now}`;
    case 'off':
      return `Off${now}`;
    default:
      return 'Unavailable';
  }
}

export const MODE_COLORS = { heat: '#ff9a4a', cool: '#5aa9ff', heat_cool: '#7fd6b0', dry: '#e6c86e', fan_only: '#b9c3d6', off: '#9aa3b2' };

/** The mode's colour; grey for Off, unavailable and anything unknown. */
export const modeColor = (mode, available = true) => (available && MODE_COLORS[mode]) || MODE_COLORS.off;

// [service value, label], in the sheet's order: the mode grid reads Off Auto Heat / Cool Dry Fan.
export const MODE_CHIPS = [['off', 'Off'], ['heat_cool', 'Auto'], ['heat', 'Heat'], ['cool', 'Cool'], ['dry', 'Dry'], ['fan_only', 'Fan']];
export const FAN_CHIPS = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra high', 'Ultra']];

/** The chips whose value is in the entity's list (hvac_modes or fan_modes). */
export const chipsFor = (chips, listed) => chips.filter(([v]) => Array.isArray(listed) && listed.includes(v));

/**
 * The number in the dial's centre: the target. With no target in Off, Dry or Fan (some units report none there)
 * it shows the room temperature instead, dimmed (room: true); with no
 * room temperature either, "—". A Heat, Cool or Auto mode still waiting for its target keeps "—".
 */
export function dialCentre(mode, target, current, digits = 0) {
  const t = num(target);
  if (t !== null) return { text: `${roundTo(t, digits)}°`, room: false };
  const c = num(current);
  if (c !== null && ['off', 'dry', 'fan_only'].includes(mode)) return { text: `${roundTo(c, digits)}°`, room: true };
  return { text: '—', room: false };
}

/** The dial takes input only in Heat, Cool and Auto, on an available entity with a target to show. */
export const dialLive = (mode, available, target) => !!available && ['heat', 'cool', 'heat_cool'].includes(mode) && num(target) !== null;

// ---- thermostat sends ---------------------------------------------------------------------------

export const CLIMATE_DEBOUNCE_MS = 1000;
export const CLIMATE_TIMEOUT_MS = 10000;
export const SHEET_IDLE_MS = 30000;

/** The failure toast, e.g. "Bedroom didn't respond". */
export const climateToast = (name) => `${name} didn't respond`;

/**
 * One field of one room (setpoint, mode or fan). wait is the debounce: CLIMATE_DEBOUNCE_MS for the setpoint, 0 for
 * mode and fan (a chip sends at once).
 * { confirmed, shown, draft, down, due, run, pending, wait }:
 *   confirmed: the entity's last reported value;  shown: what the sheet shows (optimistic);
 *   draft: shown waits out the debounce;  down: a finger is on the dial;  due: when the debounce ends (ms);
 *   run: the last run id;  pending: null or { value, run, until }, the send waiting for the entity.
 */
export function climateInit(value, wait = 0) {
  return { confirmed: value ?? null, shown: value ?? null, draft: false, down: false, due: null, run: 0, pending: null, wait };
}

/**
 * One event through a field, at time now (ms). Returns { state, send, toast }: send is null or { value, run }, and the
 * caller reports that call's rejection as { type: 'error', run }; toast is true when a send failed.
 * ev: { type: 'entity', value } | { type: 'input', value } | { type: 'down' } | { type: 'up' } | { type: 'tick' }
 *   | { type: 'error', run } | { type: 'flush' }.
 * A newer input supersedes the send in flight: from then on its rejection and timeout are ignored, and its
 * confirmation only updates confirmed. Nothing is sent when the value is already confirmed and nothing is in flight.
 */
export function climateStep(s, ev, now) {
  const out = (state, send = null, toast = false) => ({ state, send, toast });
  const release = (st) => {
    const b = { ...st, draft: false, down: false, due: null };
    if (b.shown === b.confirmed && !b.pending) return out(b);
    const run = b.run + 1;
    return out({ ...b, run, pending: { value: b.shown, run, until: now + CLIMATE_TIMEOUT_MS } }, { value: b.shown, run });
  };
  const snapBack = (st) => out({ ...st, shown: st.confirmed, pending: null }, null, true);
  const busy = s.draft || s.down;
  switch (ev.type) {
    case 'entity': {
      const value = ev.value ?? null;
      const pending = s.pending && s.pending.value === value ? null : s.pending;
      return out({ ...s, confirmed: value, pending, shown: busy || pending ? s.shown : value });
    }
    case 'input':
      if (!s.wait) return release({ ...s, shown: ev.value });
      return out({ ...s, shown: ev.value, draft: true, due: now + s.wait });
    case 'down':
      return out({ ...s, down: true, due: null });
    case 'up':
      return out({ ...s, down: false, due: s.draft ? now + s.wait : null });
    case 'tick':
      if (s.down) return out(s);
      if (s.draft) return s.due !== null && now >= s.due ? release(s) : out(s);
      return s.pending && now >= s.pending.until ? snapBack(s) : out(s);
    case 'error':
      if (!s.pending || s.pending.run !== ev.run) return out(s);
      // Drop quietly only when a newer value is waiting (draft); a finger resting without moving still shows the
      // rejected value, so that snaps back with the toast like any other rejection.
      return s.draft ? out({ ...s, pending: null }) : snapBack(s);
    case 'flush':
      return s.draft ? release(s) : out({ ...s, down: false });
    default:
      return out(s);
  }
}

/** When the caller should next send { type: 'tick' }: the debounce's end, else the pending send's timeout; null for none. */
export function climateDue(s) {
  if (s.down) return null;
  if (s.draft) return s.due;
  return s.pending ? s.pending.until : null;
}

// ---- standalone thermostat (wall-thermostat-card) -------------------------------------------------
// One climate entity on an ordinary dashboard. The dial above works in whole units, so this card feeds it STEPS
// instead of degrees: a 0.5° step makes 21.5° unit 43. Range, step and numbers are the entity's own.

/** The setpoint step and the decimals to show: target_temp_step, else 0.5 in °C and 1 otherwise. */
export function thermostatStep(attrs, unit) {
  const s = num(attrs?.target_temp_step);
  const step = s !== null && s > 0 ? s : unit === '°C' ? 0.5 : 1;
  return { step, digits: Number.isInteger(step) ? 0 : 1 };
}

/** Degrees to dial units (steps) and back, without float dust. */
export const toUnits = (t, step) => Number((t / step).toFixed(6));
export const fromUnits = (u, step, digits) => Number((u * step).toFixed(Math.max(digits, 0)));

/** The dial's range in steps, from min_temp and max_temp; 7-35 °C or 45-95 otherwise when missing or inverted. */
export function thermostatRange(attrs, unit, step) {
  const [dmin, dmax] = unit === '°C' ? [7, 35] : [45, 95];
  const lo = num(attrs?.min_temp);
  const hi = num(attrs?.max_temp);
  const of = (a, b) => ({ min: Math.ceil(toUnits(a, step)), max: Math.floor(toUnits(b, step)) });
  const r = lo === null || hi === null ? null : of(lo, hi);
  return r && r.max > r.min ? r : of(dmin, dmax);
}

const label = (v) => {
  const t = String(v).replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * Everything the standalone card shows for one climate state object. unit is hass.config.unit_system.temperature.
 *   mode: the entity's state;  logicMode: the same, with "auto" treated as heat_cool by the dial logic;
 *   range: in steps;  target / low / high / current: degrees or null;
 *   dual: heat_cool with a low and a high target and no single one: shown, not adjustable (the dial has one handle);
 *   modes / fans: [[value, label]] from the entity's own hvac_modes and fan_modes, empty when unavailable.
 */
export function thermostatView(stateObj, unit) {
  const a = stateObj?.attributes || {};
  const available = !!stateObj && stateObj.state !== 'unavailable' && stateObj.state !== 'unknown';
  const mode = stateObj?.state ?? null;
  const logicMode = mode === 'auto' ? 'heat_cool' : mode;
  const { step, digits } = thermostatStep(a, unit);
  const target = available ? num(a.temperature) : null;
  const low = available ? num(a.target_temp_low) : null;
  const high = available ? num(a.target_temp_high) : null;
  const current = available ? num(a.current_temperature) : null;
  const dual = available && target === null && low !== null && high !== null;
  const modesListed = available && Array.isArray(a.hvac_modes) ? a.hvac_modes : [];
  const twoAutos = modesListed.includes('auto') && modesListed.includes('heat_cool');
  const modeLabels = { ...Object.fromEntries(MODE_CHIPS), auto: 'Auto', ...(twoAutos ? { heat_cool: 'Heat/Cool' } : {}) };
  const fanLabels = Object.fromEntries(FAN_CHIPS);
  const now = current === null ? '' : ` · now ${roundTo(current, digits)}°`;
  return {
    available, mode, logicMode, step, digits, target, low, high, current, dual,
    range: thermostatRange(a, unit, step),
    live: dialLive(logicMode, available, target),
    color: modeColor(logicMode, available),
    status: dual ? `Auto ${roundTo(low, digits)}° to ${roundTo(high, digits)}°${now}` : dialStatus({ mode: logicMode, target, current, available, digits }),
    centre: dual ? (current === null ? { text: '—', room: false } : { text: `${roundTo(current, digits)}°`, room: true }) : dialCentre(logicMode, target, current, digits),
    modes: modesListed.map((m) => [m, modeLabels[m] ?? label(m)]),
    fans: (available && Array.isArray(a.fan_modes) ? a.fan_modes : []).map((f) => [f, fanLabels[f] ?? label(f)]),
  };
}

const THERMOSTAT_SERVICES = { temp: ['set_temperature', 'temperature'], mode: ['set_hvac_mode', 'hvac_mode'], fan: ['set_fan_mode', 'fan_mode'] };

/** The one service call for a field of the configured entity: [domain, service, data, target] for hass.callService. */
export function thermostatCall(entity, field, value) {
  if (typeof entity !== 'string' || !entity.startsWith('climate.')) throw new Error('wall-thermostat-card: not a climate entity');
  const def = THERMOSTAT_SERVICES[field];
  if (!def) throw new Error(`wall-thermostat-card: unknown field ${field}`);
  return ['climate', def[0], { [def[1]]: value }, { entity_id: entity }];
}
