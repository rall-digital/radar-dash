// The rain callout (spec "Rain callout" and "Calm mode") and its inputs.
// Run: TZ=America/New_York node --test test/callout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callout, calloutIcon, isCalm, readRadar, newestObservedEchoes, parseRainWindow, rainRun, maxPop, wetDay,
} from '../dist/wall-horizon-lib.js';

process.env.TZ = 'America/New_York';
const at = (iso) => new Date(iso);
const NOW = at('2026-09-23T14:47:00-04:00'); // Wednesday afternoon
const NIGHT = at('2026-09-23T22:47:00-04:00');
const SUN_DAY = { up: true, nextRising: at('2026-09-24T06:45:40-04:00'), nextSetting: at('2026-09-23T18:50:58-04:00') };
const SUN_NIGHT = { up: false, nextRising: at('2026-09-24T06:45:40-04:00'), nextSetting: at('2026-09-24T18:49:00-04:00') };
// wall-radar-card's summaries on a dry day: a dry home reads about -10 dBZ; '' warnings = nothing covers home.
const RADAR_DRY = { nowDbz: -10, rainAt: null, rainKnown: true, peakDbz: -10, warnings: [], forecastFrames: 8 };

// Hourly entries from `from` for n hours; pops maps a local hour to its rain chance.
function hours(from, n, pops = {}, temps = {}) {
  const t0 = at(from).getTime();
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(t0 + i * 3600000);
    return { datetime: t.toISOString(), precipitation_probability: pops[t.getHours()] ?? 0, temperature: temps[t.getHours()] ?? 60 };
  });
}
// Daily entries from Wednesday 2026-09-23, one per day, noon local.
function days(pops) {
  return pops.map((p, i) => ({ datetime: new Date(Date.UTC(2026, 8, 23 + i, 16)).toISOString(), temperature: 68, templow: 55, precipitation_probability: p, condition: 'partlycloudy' }));
}
const DRY_FC = { daily: days([0, 10, 0, 10, 20, 10, 0, 0]), hourly: hours('2026-09-23T14:00:00-04:00', 48) };
const base = (over = {}) => ({ now: NOW, radar: RADAR_DRY, condition: 'partlycloudy', forecast: DRY_FC, rainWindow: parseRainWindow('none|||0'), sun: SUN_DAY, ...over });

test('rule 1: the most severe warning at home, until its own expiry', () => {
  const warnings = [
    { phenomena: 'SV', expire_utc: '2026-09-23T22:00:00Z' },
    { phenomena: 'TO', expire_utc: '2026-09-23T21:30:00Z' },
    { phenomena: 'TO', expire_utc: '2026-09-23T18:00:00Z' }, // already expired
    { phenomena: 'FL', expire_utc: '2026-09-27T00:00:00Z' }, // not a type the card draws
  ];
  assert.deepEqual(callout(base({ radar: { ...RADAR_DRY, warnings } })), { head: 'Tornado warning until 17:30', sub: '', rule: 1 });
  const sv = [{ phenomena: 'SV', expire_utc: '2026-09-23T22:00:00Z' }];
  assert.equal(callout(base({ radar: { ...RADAR_DRY, warnings: sv } })).head, 'Severe thunderstorm warning until 18:00');
  const noExpiry = [{ phenomena: 'FF', expire_utc: 'soon' }];
  assert.equal(callout(base({ radar: { ...RADAR_DRY, warnings: noExpiry } })).head, 'Flash flood warning');
});

test('rule 1: absent warnings skip the rule; a warning shows even before any frame loads', () => {
  assert.equal(callout(base({ radar: { ...RADAR_DRY, warnings: null } })).rule, 7);
  const early = readRadar({ homeWarnings: '[{"phenomena":"TO","expire_utc":"2026-09-23T21:30:00Z"}]' });
  assert.deepEqual(callout(base({ radar: early })), { head: 'Tornado warning until 17:30', sub: '', rule: 1 });
});

test('rule 2: raining at home on the newest observed frame', () => {
  assert.deepEqual(callout(base({ radar: { ...RADAR_DRY, nowDbz: 32 } })), { head: 'Raining now', sub: '', rule: 2 });
  assert.equal(callout(base({ radar: { ...RADAR_DRY, nowDbz: 45 } })).head, 'Heavy rain now');
  assert.equal(callout(base({ radar: { ...RADAR_DRY, nowDbz: 19.5 } })).rule, 7);
});

test('rule 3: rain from about the first HRRR frame at home, worded by its peak', () => {
  const radar = readRadar({ nowDbz: '-10', rainAt: '2026-09-23T21:45:00.000Z', rainPeakDbz: '48', homeWarnings: '', forecastFrames: '8' });
  assert.deepEqual(callout(base({ radar })), { head: 'Rain from about 17:45', sub: 'Heavy at times', rule: 3 });
  assert.equal(callout(base({ radar: { ...radar, peakDbz: 29 } })).sub, 'Light');
  assert.equal(callout(base({ radar: { ...radar, peakDbz: 30 } })).sub, 'Moderate');
  assert.equal(callout(base({ radar: { ...radar, forecastFrames: 0 } })).rule, 7, 'a stale run is hidden, so rule 3 is skipped');
});

test('rule 4: rain from 18:00 by the OpenWeatherMap hours', () => {
  const forecast = { ...DRY_FC, hourly: hours('2026-09-23T14:00:00-04:00', 48, { 18: 70, 19: 65 }) };
  assert.deepEqual(callout(base({ forecast })), { head: 'Rain likely from 18:00', sub: '70% chance', rule: 4 });
});

test('rule 4: a rain_window wins over the hourly scan', () => {
  const forecast = { ...DRY_FC, hourly: hours('2026-09-23T14:00:00-04:00', 48, { 18: 70, 19: 65, 20: 62 }) };
  const rainWindow = parseRainWindow('soon|2026-09-23T19:00:00-04:00|2026-09-23T21:00:00-04:00|0');
  assert.deepEqual(callout(base({ forecast, rainWindow })), { head: 'Rain likely from 19:00', sub: '65% chance', rule: 4 });
});

test('rule 4: a window already under way reads "until" its end', () => {
  const forecast = { ...DRY_FC, hourly: hours('2026-09-23T14:00:00-04:00', 48, { 14: 75, 15: 70, 16: 61 }) };
  const rainWindow = parseRainWindow('raining|2026-09-23T14:00:00-04:00|2026-09-23T17:00:00-04:00|0');
  assert.deepEqual(callout(base({ forecast, rainWindow })), { head: 'Rain likely until 17:00', sub: '75% chance', rule: 4 });
});

test('rule 4: hours beyond 12 do not count', () => {
  const forecast = { ...DRY_FC, hourly: hours('2026-09-23T14:00:00-04:00', 48, { 4: 90 }) }; // 04:00 tomorrow is 13 h out
  assert.equal(callout(base({ forecast })).rule, 7);
});

test('rule 5: the first wet day after today, up to six days out', () => {
  const forecast = { ...DRY_FC, daily: days([90, 10, 20, 60, 70, 0, 0, 0]) };
  assert.deepEqual(callout(base({ forecast })), { head: 'Rain likely Saturday', sub: '60% chance', rule: 5 });
  const nextWeek = { ...DRY_FC, daily: days([0, 0, 0, 0, 0, 0, 0, 80]) }; // next Wednesday would read as "Wednesday"
  assert.equal(callout(base({ forecast: nextWeek })).rule, 7);
});

test('rule 6: clear night with the overnight low, and cloudy night', () => {
  const hourly = hours('2026-09-23T22:00:00-04:00', 24, {}, { 23: 58, 2: 54, 5: 52, 6: 52.4, 8: 50 });
  const night = base({ now: NIGHT, sun: SUN_NIGHT, condition: 'clear-night', forecast: { ...DRY_FC, hourly } });
  assert.deepEqual(callout(night), { head: 'Clear tonight, 52° by morning', sub: 'Sunrise 06:45', rule: 6 });
  assert.deepEqual(callout({ ...night, condition: 'cloudy' }), { head: 'Cloudy tonight', sub: 'Sunrise 06:45', rule: 6 });
  assert.equal(callout({ ...night, condition: null }).head, 'Tonight');
});

test('rule 7: dry through the last forecast row, with sunset', () => {
  assert.deepEqual(callout(base()), { head: 'Dry through Saturday', sub: 'Sunset 18:50', rule: 7 });
});

test('fallback: without radar numbers, rules 1 and 3 are skipped and rule 2 uses the condition', () => {
  assert.deepEqual(callout(base({ radar: null, condition: 'rainy' })), { head: 'Raining now', sub: '', rule: 2 });
  assert.equal(callout(base({ radar: null, condition: 'pouring' })).head, 'Heavy rain now');
  assert.equal(callout(base({ radar: null, condition: 'lightning-rainy' })).head, 'Raining now');
  assert.equal(callout(base({ radar: null, condition: 'cloudy' })).rule, 7);
  assert.equal(callout(base({ radar: { ...RADAR_DRY, nowDbz: null }, condition: 'rainy' })).rule, 2, "'' at home is unknown (the tile never loaded)");
  assert.equal(callout(base({ radar: { ...RADAR_DRY, nowDbz: -10 }, condition: 'rainy' })).rule, 7, 'a dry reading wins over the condition');
});

test('fallback: a failed forecast skips rules 4 and 5 and keeps 6 and 7 honest', () => {
  const wet = parseRainWindow('soon|2026-09-23T18:00:00-04:00|2026-09-23T20:00:00-04:00|0');
  assert.deepEqual(callout(base({ forecast: null, rainWindow: wet })), { head: 'Dry for now', sub: 'Sunset 18:50', rule: 7 });
  const night = base({ now: NIGHT, sun: SUN_NIGHT, condition: 'clear-night', forecast: null });
  assert.deepEqual(callout(night), { head: 'Clear tonight', sub: 'Sunrise 06:45', rule: 6 });
});

test('fallback: with every source down the callout claims nothing', () => {
  assert.deepEqual(callout(base({ radar: null, condition: 'unavailable', forecast: null, sun: { up: null, nextRising: null, nextSetting: null } })), { head: 'Weather unavailable', sub: '', rule: 7 });
  assert.equal(callout(base({ radar: null, condition: 'unavailable', forecast: null })).head, 'Weather unavailable');
  assert.equal(callout(base({ radar: null, condition: 'cloudy', forecast: null })).head, 'Dry for now');
});

test('fallback: without sun.sun the callout stays on rule 7 with no sunset line', () => {
  assert.deepEqual(callout(base({ sun: { up: null, nextRising: null, nextSetting: null } })), { head: 'Dry through Saturday', sub: '', rule: 7 });
});

test('calloutIcon follows the rule', () => {
  assert.equal(calloutIcon(1, 'cloudy'), 'mdi:alert');
  assert.equal(calloutIcon(3, 'cloudy'), 'mdi:weather-rainy');
  assert.equal(calloutIcon(5, 'cloudy'), 'mdi:umbrella-outline');
  assert.equal(calloutIcon(6, 'clear-night'), 'mdi:weather-night');
  assert.equal(calloutIcon(6, 'partlycloudy'), 'mdi:weather-night-partly-cloudy');
  assert.equal(calloutIcon(7, 'partlycloudy'), 'mdi:weather-partly-cloudy');
});

test('isCalm: echoes at or under the floor count as none in view', () => {
  assert.equal(isCalm({ radar: RADAR_DRY, echoes: 0, rule: 7 }), true);
  assert.equal(isCalm({ radar: RADAR_DRY, echoes: 40, rule: 6 }), true);
  assert.equal(isCalm({ radar: RADAR_DRY, echoes: 50, rule: 7 }), true, 'the default floor is 50');
  assert.equal(isCalm({ radar: RADAR_DRY, echoes: 51, rule: 7 }), false);
  assert.equal(isCalm({ radar: RADAR_DRY, echoes: 51, rule: 7, floor: 100 }), true);
  assert.equal(isCalm({ radar: RADAR_DRY, echoes: 0, rule: 7, floor: 0 }), true);
});

test('isCalm needs known summaries, no forecast rain and rule 6 or 7', () => {
  assert.equal(isCalm({ radar: RADAR_DRY, echoes: 0, rule: 5 }), false);
  assert.equal(isCalm({ radar: { ...RADAR_DRY, rainAt: NOW }, echoes: 0, rule: 7 }), false);
  assert.equal(isCalm({ radar: { ...RADAR_DRY, rainKnown: false }, echoes: 0, rule: 7 }), false);
  assert.equal(isCalm({ radar: RADAR_DRY, echoes: undefined, rule: 7 }), false);
  assert.equal(isCalm({ radar: null, echoes: 0, rule: 7 }), false);
});

test('readRadar returns null without the new attributes and parses them when present', () => {
  assert.equal(readRadar({ frame: '3', frames: '22', forecastFrames: '8', frameKind: 'observed', status: '' }), null);
  const r = readRadar({ nowDbz: '23.5', rainAt: '2026-09-23T21:45:00.000Z', rainPeakDbz: '41', homeWarnings: '[{"phenomena":"TO","expire_utc":"2026-09-23T21:30:00Z"}]', forecastFrames: '8' });
  assert.deepEqual(r, { nowDbz: 23.5, rainAt: at('2026-09-23T21:45:00Z'), rainKnown: true, peakDbz: 41, warnings: [{ phenomena: 'TO', expire_utc: '2026-09-23T21:30:00Z' }], forecastFrames: 8 });
});

test("readRadar: '' is unknown, never 0; warnings absent, '' and JSON differ", () => {
  assert.deepEqual(readRadar({ nowDbz: '', rainAt: '', rainPeakDbz: '', homeWarnings: '' }), { nowDbz: null, rainAt: null, rainKnown: true, peakDbz: null, warnings: [], forecastFrames: 0 });
  assert.equal(readRadar({ nowDbz: '-10' }).nowDbz, -10);
  assert.equal(readRadar({ nowDbz: '-10' }).warnings, null, 'absent: the feed has not answered');
  assert.deepEqual(readRadar({ nowDbz: '-10', homeWarnings: '' }).warnings, [], "'': nothing covers home");
  assert.equal(readRadar({ nowDbz: '1', homeWarnings: '{not json' }).warnings, null);
  assert.equal(readRadar({ homeWarnings: '' }).rainKnown, false, 'summaries not written yet');
});

test('newestObservedEchoes reads data-echoes only on the newest observed frame', () => {
  const ds = { frame: '13', frames: '22', forecastFrames: '8', frameKind: 'observed', echoes: '0' };
  assert.equal(newestObservedEchoes(ds), 0);
  assert.equal(newestObservedEchoes({ ...ds, frame: '12' }), undefined);
  assert.equal(newestObservedEchoes({ ...ds, frame: '14', frameKind: 'forecast' }), undefined);
  assert.equal(newestObservedEchoes({ frame: '13', frames: '22', forecastFrames: '8', frameKind: 'observed' }), undefined);
});

test('parseRainWindow reads phase|start|end|misses', () => {
  assert.deepEqual(parseRainWindow('none|||0'), { phase: 'none', start: null, end: null });
  assert.deepEqual(parseRainWindow('unavailable'), { phase: 'none', start: null, end: null });
  assert.deepEqual(parseRainWindow(undefined), { phase: 'none', start: null, end: null });
  assert.deepEqual(parseRainWindow('soon|2026-09-23T18:00:00-04:00|2026-09-23T20:00:00-04:00|0'), { phase: 'soon', start: at('2026-09-23T22:00:00Z'), end: at('2026-09-24T00:00:00Z') });
  assert.deepEqual(parseRainWindow('raining|2026-09-23T18:00:00-04:00||2'), { phase: 'raining', start: at('2026-09-23T22:00:00Z'), end: null });
});

test('rainRun, maxPop and wetDay', () => {
  const h = hours('2026-09-23T14:00:00-04:00', 24, { 18: 70, 19: 65, 21: 90 });
  assert.deepEqual(rainRun(h, NOW, 60), { start: at('2026-09-23T18:00:00-04:00'), end: at('2026-09-23T20:00:00-04:00'), pop: 70 });
  assert.equal(rainRun(h, NOW, 95), null);
  assert.equal(maxPop(h, at('2026-09-23T18:30:00-04:00'), at('2026-09-23T22:00:00-04:00')), 90);
  assert.equal(maxPop(h, at('2026-09-23T18:30:00-04:00'), null), 70);
  assert.deepEqual(wetDay(days([90, 0, 55]), NOW, 50), { date: new Date(Date.UTC(2026, 8, 25, 16)), pop: 55 });
  assert.equal(wetDay(days([90, 0, 0]), NOW, 50), null);
});

test('rule 2: exactly rain_dbz counts as raining', () => {
  assert.deepEqual(callout(base({ radar: { ...RADAR_DRY, nowDbz: 20 } })), { head: 'Raining now', sub: '', rule: 2 });
});

test('rule 4: a rain_window that already ended is ignored', () => {
  const ended = parseRainWindow('soon|2026-09-23T12:00:00-04:00|2026-09-23T13:00:00-04:00|0');
  const forecast = { ...DRY_FC, hourly: hours('2026-09-23T14:00:00-04:00', 48, { 18: 70, 19: 65 }) };
  assert.deepEqual(callout(base({ forecast, rainWindow: ended })), { head: 'Rain likely from 18:00', sub: '70% chance', rule: 4 });
  assert.equal(callout(base({ rainWindow: ended })).rule, 7, 'with a dry hourly scan');
});

test('rule 1: an expired warning on its own is skipped', () => {
  const warnings = [{ phenomena: 'TO', expire_utc: '2026-09-23T18:00:00Z' }];
  assert.equal(callout(base({ radar: { ...RADAR_DRY, warnings } })).rule, 7);
});

// rainAt stays in the past until the radar's next forecast poll (2 min, up to 30 under backoff).
const pastRain = (min) => readRadar({ nowDbz: '-10', rainAt: new Date(NOW.getTime() - min * 60000).toISOString(), rainPeakDbz: '48', homeWarnings: '', forecastFrames: '8' });

test('rule 3: a first-rain time up to 30 min past reads "Rain any minute"', () => {
  assert.deepEqual(callout(base({ radar: pastRain(2) })), { head: 'Rain any minute', sub: 'Heavy at times', rule: 3 });
  assert.equal(callout(base({ radar: pastRain(30) })).head, 'Rain any minute', 'the edge: 30 min past still counts');
});

test('rule 3: a first-rain time more than 30 min past is stale and falls through', () => {
  assert.equal(callout(base({ radar: pastRain(40) })).rule, 7);
});

test('isCalm waits for a forecast tile: peakDbz unknown with forecast frames listed is not calm', () => {
  assert.equal(isCalm({ radar: { ...RADAR_DRY, peakDbz: null }, echoes: 0, rule: 7 }), false, 'forecast tiles not rendered yet');
  assert.equal(isCalm({ radar: { ...RADAR_DRY, peakDbz: null, forecastFrames: 0 }, echoes: 0, rule: 7 }), true, 'no forecast run at all');
});
