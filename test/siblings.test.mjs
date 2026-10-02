// One resource loads all three cards: dist/wall-radar-card.js (the file HACS registers) imports wall-horizon-card.js
// and wall-thermostat-card.js from its own folder with its own query string, so a HACS update (a new ?hacstag=)
// reaches every file. Each scenario runs in its own Node process, against a copy of the real wall-radar-card.js next
// to stand-in sibling files that record the URL they were loaded with. Run: node --test test/siblings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RADAR = new URL('../dist/wall-radar-card.js', import.meta.url);

// A stand-in card file: records its URL, defines its element (unless another copy did), exports its class.
const sibling = (tag, name) => `globalThis.__loaded.push(import.meta.url);
class ${name} {}
if (!customElements.get('${tag}')) customElements.define('${tag}', ${name});
export { ${name} };
`;
const SIBLINGS = {
  'wall-horizon-card.js': sibling('wall-horizon-card', 'WallHorizonCard'),
  'wall-thermostat-card.js': sibling('wall-thermostat-card', 'WallThermostatCard'),
};

/**
 * Loads the radar card (with `query`) in a fresh process and reports what loaded, what was defined and what went to
 * the console. files overrides the stand-in siblings; before runs first (e.g. to define an element early).
 */
function load(query, { files = {}, before = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-dash-siblings-'));
  fs.copyFileSync(RADAR, path.join(dir, 'wall-radar-card.js'));
  for (const [name, src] of Object.entries({ ...SIBLINGS, ...files })) if (src !== null) fs.writeFileSync(path.join(dir, name), src);
  const main = `
const defined = new Map();
globalThis.window = globalThis;
globalThis.customElements = {
  get: (n) => defined.get(n),
  define: (n, c) => { if (defined.has(n)) throw new Error('already defined: ' + n); defined.set(n, c); },
};
globalThis.__loaded = [];
const warnings = [];
console.warn = (...a) => warnings.push(a.join(' '));
console.error = (...a) => warnings.push('error: ' + a.join(' '));
${before}
const mod = await import(new URL('./wall-radar-card.js${query}', import.meta.url).href);
await mod.siblingsLoaded;
process.stdout.write(JSON.stringify({
  loaded: globalThis.__loaded.map((u) => u.slice(u.lastIndexOf('/') + 1)),
  defined: [...defined.keys()].sort(),
  radarIsOurs: defined.get('wall-radar-card') === mod.WallRadarCard,
  warnings,
}));
`;
  fs.writeFileSync(path.join(dir, 'main.mjs'), main);
  const r = spawnSync(process.execPath, [path.join(dir, 'main.mjs')], { encoding: 'utf8', timeout: 20000 });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('S1 the radar card, loaded with ?hacstag=X, loads both other cards with the same ?hacstag=X', () => {
  const r = load('?hacstag=123abc');
  assert.deepEqual(r.loaded.sort(), ['wall-horizon-card.js?hacstag=123abc', 'wall-thermostat-card.js?hacstag=123abc']);
  assert.deepEqual(r.defined, ['wall-horizon-card', 'wall-radar-card', 'wall-thermostat-card']);
  assert.equal(r.radarIsOurs, true);
  assert.deepEqual(r.warnings, []);
});

test('S2 loaded with no query string (or a manual ?v=), the siblings get exactly that', () => {
  assert.deepEqual(load('').loaded.sort(), ['wall-horizon-card.js', 'wall-thermostat-card.js']);
  assert.deepEqual(load('?v=1.2.0').loaded.sort(), ['wall-horizon-card.js?v=1.2.0', 'wall-thermostat-card.js?v=1.2.0']);
});

test('S3 a sibling that fails to load does not stop the radar card or the other sibling; one console line', () => {
  for (const files of [{ 'wall-horizon-card.js': 'throw new Error("boom");' }, { 'wall-horizon-card.js': null }]) {
    const r = load('?hacstag=9', { files });
    assert.equal(r.radarIsOurs, true, 'the radar card is defined');
    assert.deepEqual(r.defined, ['wall-radar-card', 'wall-thermostat-card']);
    assert.equal(r.warnings.length, 1, JSON.stringify(r.warnings));
    assert.match(r.warnings[0], /wall-horizon-card\.js/);
  }
  const both = load('', { files: { 'wall-horizon-card.js': null, 'wall-thermostat-card.js': null } });
  assert.equal(both.radarIsOurs, true);
  assert.equal(both.warnings.length, 1, 'still one line for two failures');
  assert.match(both.warnings[0], /wall-horizon-card\.js.*wall-thermostat-card\.js|wall-thermostat-card\.js.*wall-horizon-card\.js/);
});

test('S4 a card already defined by another resource entry (an old extra entry) is reported once, by name', () => {
  const r = load('?hacstag=2', { before: "customElements.define('wall-horizon-card', class Old {});" });
  assert.deepEqual(r.defined, ['wall-horizon-card', 'wall-radar-card', 'wall-thermostat-card']);
  assert.equal(r.warnings.length, 1, JSON.stringify(r.warnings));
  assert.match(r.warnings[0], /wall-horizon-card/);
  assert.match(r.warnings[0], /resource/);
  assert.doesNotMatch(r.warnings[0], /wall-thermostat-card/);
});

test('S5 a second copy of the radar card (already defined) loads nothing more and says nothing', () => {
  const r = load('?hacstag=3', { before: "customElements.define('wall-radar-card', class Other {});" });
  assert.deepEqual(r.loaded, []);
  assert.equal(r.radarIsOurs, false);
  assert.deepEqual(r.warnings, []);
});

test('S6 with no DOM (Node importing the helpers) nothing else is loaded', async () => {
  const mod = await import('../dist/wall-radar-card.js');
  assert.equal(await mod.siblingsLoaded, undefined);
});

test('S7 the real card files export the class the radar card compares against', () => {
  for (const [file, name] of [['wall-horizon-card.js', 'WallHorizonCard'], ['wall-thermostat-card.js', 'WallThermostatCard']]) {
    const src = fs.readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8');
    assert.match(src, new RegExp(`^export \\{[^}]*\\b${name}\\b[^}]*\\};?$`, 'm'), file);
  }
});
