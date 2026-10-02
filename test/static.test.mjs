// The spec's performance rules, checked in the card's source: no backdrop-filter anywhere, and every animation and
// transition moves only transform or opacity. Run: node --test test/static.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../dist/wall-horizon-card.js', import.meta.url), 'utf8');

test('no backdrop-filter', () => {
  assert.equal(/backdrop-filter/.test(src), false);
});

test('keyframes animate only transform and opacity', () => {
  for (const [, name, body] of src.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)) {
    const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    assert.ok(props.length, `${name} has properties`);
    for (const p of props) assert.ok(p === 'transform' || p === 'opacity', `@keyframes ${name} animates ${p}`);
  }
});

test('transitions move only transform or opacity', () => {
  for (const [, value] of src.matchAll(/transition:\s*([^;]+);/g)) {
    for (const part of value.split(',')) {
      const prop = part.trim().split(/\s+/)[0];
      assert.ok(prop === 'transform' || prop === 'opacity', `transition on ${prop}`);
    }
  }
});

test('no blur filter: the dial\'s glow is a wider translucent stroke (dial spec, Performance)', () => {
  assert.equal(/feGaussianBlur|filter\s*:\s*blur|<filter\b/.test(src), false);
});

test('the pending ring and the pending chip hold still under prefers-reduced-motion', () => {
  const blocks = [...src.matchAll(/@media \(prefers-reduced-motion: reduce\) \{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)].map((m) => m[1]).join('\n');
  assert.match(blocks, /\.d-ring\.sending[^{]*\{\s*animation: none/);
  assert.match(blocks, /\.chip\[data-pending\]::after[^{]*\{\s*animation: none/);
});

test('the weather bubble is off by default, and show_callout: true brings it back', () => {
  assert.match(src, /^\s*show_callout: false,$/m);
  assert.match(src, /#root\.nocall \.call, #root\.nocall \.lead \{ display: none; \}/);
  assert.match(src, /classList\.toggle\('nocall', this\._config\.show_callout !== true\)/);
});

test('the current condition is off by default, and show_condition: true brings it back', () => {
  assert.match(src, /^\s*show_condition: false,$/m);
  assert.match(src, /const label = c\.show_condition === true \? conditionLabel\(w\?\.state\) : '';/);
});

test('today\'s high and low are off by default, and show_high_low: true brings them back', () => {
  assert.match(src, /^\s*show_high_low: false,$/m);
  assert.match(src, /const today = c\.show_high_low === true && /);
});
