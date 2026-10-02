// Format, forecast and layout helpers of wall-horizon-lib.js.
// Run: TZ=America/New_York node --test test/format.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  num, toDate, hhmm, dateLine, weekdayShort, localDay, tempText, conditionLabel, conditionIcon,
  tcol, fcScale, scalePct, popText, forecastRows, overnightLow, designFit, homePoint, calloutGeometry,
  fontMetrics, fitClock, fitNumber, radarConfig, radarFallback, esc, strongScrim, twoLines,
} from '../dist/wall-horizon-lib.js';

process.env.TZ = 'America/New_York';
const at = (iso) => new Date(iso);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} != ${b}`);

test('num and toDate reject blanks, words and NaN', () => {
  assert.equal(num('66.614'), 66.614);
  assert.equal(num(0), 0);
  for (const v of ['', '  ', 'unavailable', null, undefined, NaN]) assert.equal(num(v), null);
  assert.equal(toDate('2026-09-23T21:45:00Z').toISOString(), '2026-09-23T21:45:00.000Z');
  for (const v of ['', 'soon', null, undefined, new Date(NaN)]) assert.equal(toDate(v), null);
});

test('hhmm is 24-hour local time with leading zeros', () => {
  assert.equal(hhmm(at('2026-09-23T17:45:00-04:00')), '17:45');
  assert.equal(hhmm(at('2026-09-24T06:05:00-04:00')), '06:05');
  assert.equal(hhmm(at('2026-09-23T00:00:00-04:00')), '00:00');
});

test('dateLine gives the weekday and the month and day', () => {
  assert.deepEqual(dateLine(at('2026-09-23T09:00:00-04:00')), { weekday: 'Wednesday', monthDay: 'September 23' });
  assert.deepEqual(dateLine(at('2026-09-30T09:00:00-04:00')), { weekday: 'Wednesday', monthDay: 'September 30' });
  assert.equal(weekdayShort(at('2026-09-24T12:00:00-04:00')), 'Thu');
});

test('localDay groups by the local calendar day', () => {
  assert.equal(localDay(at('2026-09-23T00:30:00-04:00')), localDay(at('2026-09-23T23:30:00-04:00')));
  assert.equal(localDay(at('2026-09-24T00:30:00-04:00')) - localDay(at('2026-09-23T23:30:00-04:00')), 1);
});

test('tempText rounds and shows a dash when missing', () => {
  assert.equal(tempText('66.614'), '67°');
  assert.equal(tempText(-3.4), '-3°');
  assert.equal(tempText('unavailable'), '—');
  assert.equal(tempText(undefined), '—');
});

test('conditions have labels and icons, with night variants', () => {
  assert.equal(conditionLabel('partlycloudy'), 'Partly cloudy');
  assert.equal(conditionLabel('lightning-rainy'), 'Thunderstorms');
  assert.equal(conditionLabel('unavailable'), '');
  assert.equal(conditionIcon('partlycloudy'), 'mdi:weather-partly-cloudy');
  assert.equal(conditionIcon('partlycloudy', true), 'mdi:weather-night-partly-cloudy');
  assert.equal(conditionIcon('sunny', true), 'mdi:weather-night');
  assert.equal(conditionIcon('nonsense'), 'mdi:weather-cloudy');
});

test('tcol diverges around 62 and clamps at 42 and 76', () => {
  assert.equal(tcol(62), 'rgb(205 212 224)');
  assert.equal(tcol(42), 'rgb(112 186 255)');
  assert.equal(tcol(30), 'rgb(112 186 255)');
  assert.equal(tcol(76), 'rgb(255 180 88)');
  assert.equal(tcol(90), 'rgb(255 180 88)');
  assert.equal(tcol(52), 'rgb(159 199 240)');
});

test('fcScale pads the extremes by 2 and scalePct clamps to the track', () => {
  const rows = [{ lo: 55, hi: 67 }, { lo: 52, hi: 65 }, { lo: 55, hi: 71 }, { lo: 60, hi: 72 }];
  assert.deepEqual(fcScale(rows), [50, 74]);
  assert.equal(scalePct(62, [50, 74]), 50);
  assert.equal(scalePct(40, [50, 74]), 0);
  assert.equal(scalePct(80, [50, 74]), 100);
  assert.equal(scalePct(60, [60, 60]), 50);
});

test('popText shows a rain chance only at 30% or more', () => {
  assert.equal(popText(29), '');
  assert.equal(popText(30), '30%');
  assert.equal(popText('80'), '80%');
  assert.equal(popText(null), '');
});

const DAILY = [
  { datetime: '2026-09-22T16:00:00+00:00', temperature: 70, templow: 58, precipitation_probability: 0, condition: 'sunny' },
  { datetime: '2026-09-23T16:00:00+00:00', temperature: 67, templow: 55, precipitation_probability: 80, condition: 'pouring' },
  { datetime: '2026-09-24T16:00:00+00:00', temperature: 65.4, templow: 52, precipitation_probability: 20, condition: 'cloudy' },
  { datetime: '2026-09-25T16:00:00+00:00', temperature: 71, templow: 55, precipitation_probability: 0, condition: 'partlycloudy' },
  { datetime: '2026-09-26T16:00:00+00:00', temperature: 72, templow: null, precipitation_probability: 10, condition: 'partlycloudy' },
  { datetime: '2026-09-27T16:00:00+00:00', temperature: 69, templow: 58, precipitation_probability: 60, condition: 'rainy' },
];

test('forecastRows starts at today, labels it, and skips a stale past day', () => {
  const rows = forecastRows(DAILY, at('2026-09-23T14:47:00-04:00'), 4);
  assert.deepEqual(rows.map((r) => r.label), ['Today', 'Thu', 'Fri', 'Sat']);
  assert.deepEqual(rows.map((r) => [r.lo, r.hi]), [[55, 67], [52, 65], [55, 71], [72, 72]]);
  assert.equal(rows[0].pop, 80);
  assert.equal(rows[0].condition, 'pouring');
});

test('forecastRows labels a list without today by weekday', () => {
  const rows = forecastRows(DAILY.slice(2), at('2026-09-23T14:47:00-04:00'), 4);
  assert.equal(rows[0].label, 'Thu');
});

test('overnightLow takes the lowest hour until sunrise', () => {
  const hourly = [
    { datetime: '2026-09-24T02:00:00Z', temperature: 58 },
    { datetime: '2026-09-24T06:00:00Z', temperature: 53.6 },
    { datetime: '2026-09-24T10:00:00Z', temperature: 52 },
    { datetime: '2026-09-24T12:00:00Z', temperature: 49 },
  ];
  assert.equal(overnightLow(hourly, at('2026-09-23T22:47:00-04:00'), at('2026-09-24T10:45:40Z')), 52);
  assert.equal(overnightLow(hourly, at('2026-09-23T22:47:00-04:00'), null), null);
  assert.equal(overnightLow([], at('2026-09-23T22:47:00-04:00'), at('2026-09-24T10:45:40Z')), null);
});

test('designFit scales by the smaller ratio and centres', () => {
  assert.deepEqual(designFit(960, 600), { s: 0.75, ox: 0, oy: 0 });
  const wide = designFit(1200, 600);
  assert.equal(wide.s, 0.75);
  assert.equal(wide.ox, 120);
  assert.equal(wide.oy, 0);
});

test('homePoint maps home_position to design px, including letterboxing', () => {
  const h = homePoint([0.5625, 0.49], 960, 600);
  near(h.x, 720);
  near(h.y, 392);
  const p = homePoint([0.5, 0.5], 1200, 600);
  near(p.x, 640);
  near(p.y, 400);
});

test('calloutGeometry puts the pill 58 right and 38 below home and caps its text', () => {
  const g = calloutGeometry({ x: 720, y: 392 });
  assert.equal(g.cx, 778);
  assert.equal(g.cy, 430);
  assert.equal(g.maxText, 1254 - 778 - 90);
  assert.equal(g.lead.x, 726);
  assert.equal(g.lead.y, 398);
  assert.ok(Math.abs(g.lead.len - Math.hypot(52, 68)) < 1e-9);
  assert.equal(calloutGeometry({ x: 1200, y: 392 }).maxText, 200);
});

test('fontMetrics and fitClock reproduce the mockup fit', () => {
  const m = fontMetrics({ digitWidths: [55, 40, 52, 52, 54, 52, 53, 50, 53, 53], colonWidth: 24, ascent: 70, fontAscent: 95, fontDescent: 23 });
  near(m.dw, 0.55);
  near(m.cw, 0.264);
  near(m.cap, 0.7);
  near(m.top, 0.16);
  const clock = fitClock(m, 208, 680);
  near(clock.width, 680, 'width-bound');
  near(clock.digitH, (0.7 * 680) / (4 * 0.55 + 0.264));
  near(clock.shift, 0.16 * clock.size);
  near(fitClock(m, 100, 680).digitH, 100, 'cap-bound');
  const temp = fitNumber(m, 150);
  near(temp.digitH, 150);
  near(temp.size, 150 / 0.7);
});

test('fontMetrics falls back when the canvas reports no metrics', () => {
  const m = fontMetrics({ digitWidths: [60], colonWidth: 50, ascent: 0, fontAscent: 0, fontDescent: 0 });
  near(m.dw, 0.6);
  near(m.cw, 0.4);
  near(m.cap, 0.72);
  near(m.top, 0.12);
});

test('radarConfig forces the layout keys and radarFallback drops the new basemaps', () => {
  const cfg = radarConfig({ zoom_level: 8, basemap: 'auto', day_basemap: 'satellite', night_basemap: 'ink', height: '525px', show_progress: true });
  assert.deepEqual(cfg, { zoom_level: 8, basemap: 'auto', day_basemap: 'satellite', night_basemap: 'ink', type: 'custom:wall-radar-card', height: '100%', show_color_bar: false, show_progress: false });
  assert.deepEqual(radarFallback(cfg), { zoom_level: 8, type: 'custom:wall-radar-card', height: '100%', show_color_bar: false, show_progress: false });
  assert.equal(radarFallback(radarConfig({ basemap: 'satellite' })), null);
  assert.equal(radarFallback(radarConfig({})), null);
});

test('esc escapes markup and quotes', () => {
  assert.equal(esc(`<b a="1">'&`), '&lt;b a=&quot;1&quot;&gt;&#39;&amp;');
});

test('calloutGeometry: the leader angle is atan2(dy, dx) in degrees', () => {
  near(calloutGeometry({ x: 720, y: 392 }).lead.angle, (Math.atan2(68, 52) * 180) / Math.PI);
});

test('overnightLow ignores hours that ended more than an hour ago', () => {
  const hourly = [
    { datetime: '2026-09-24T01:00:00Z', temperature: 40 }, // 21:00 local, before now - 1 h
    { datetime: '2026-09-24T06:00:00Z', temperature: 53.6 },
    { datetime: '2026-09-24T10:00:00Z', temperature: 52 },
  ];
  assert.equal(overnightLow(hourly, at('2026-09-23T22:47:00-04:00'), at('2026-09-24T10:45:40Z')), 52);
});

test('localDay and forecastRows hold across the fall-back change (2026-11-01)', () => {
  assert.equal(localDay(at('2026-11-01T00:30:00-04:00')), localDay(at('2026-11-01T23:30:00-05:00')));
  assert.equal(localDay(at('2026-11-02T00:30:00-05:00')) - localDay(at('2026-11-01T23:30:00-05:00')), 1);
  const daily = [
    { datetime: '2026-11-01T17:00:00+00:00', temperature: 58, templow: 45, condition: 'sunny' },
    { datetime: '2026-11-02T17:00:00+00:00', temperature: 55, templow: 44, condition: 'cloudy' },
  ];
  assert.deepEqual(forecastRows(daily, at('2026-11-01T23:30:00-05:00'), 4).map((r) => r.label), ['Today', 'Mon']);
});

test('strongScrim: only while the radar card shows the satellite basemap', () => {
  assert.equal(strongScrim({ basemap: 'satellite' }), true);
  for (const ds of [{ basemap: 'ink' }, { basemap: 'night' }, { basemap: 'hillshade_dark_coast' }, {}, null, undefined]) assert.equal(strongScrim(ds), false, JSON.stringify(ds));
});

test('twoLines splits a room name at the space nearest the middle', () => {
  assert.deepEqual(twoLines('Great Room'), ['Great', 'Room']);
  assert.deepEqual(twoLines('Suites'), ['Suites']);
  assert.deepEqual(twoLines('  Primary   Bed Room '), ['Primary', 'Bed Room']);
  assert.deepEqual(twoLines('Kids Bonus Room'), ['Kids Bonus', 'Room']);
  assert.deepEqual(twoLines('climate.den'), ['climate.den']);
});
