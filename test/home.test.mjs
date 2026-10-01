import test from 'node:test';
import assert from 'node:assert/strict';
import { homePosition, homeOffset } from '../dist/wall-radar-card.js';
import { configure, close } from './helpers.mjs';

test('home_position defaults to the middle and accepts two fractions', () => {
  assert.deepEqual(configure({}).home_position, [0.5, 0.5]);
  assert.deepEqual(configure({ home_position: [0.5625, 0.49] }).home_position, [0.5625, 0.49]);
  assert.deepEqual(homePosition(['0.25', 1]), [0.25, 1]);
});

test('home_position rejects anything but two fractions from 0 to 1', () => {
  for (const bad of [[1.2, 0.5], [-0.1, 0.5], [0.5], [0.5, 0.5, 0.5], '0.5,0.5', [true, 0.5], [null, 0.5], ['', 0.5], ['x', 0.5], [NaN, 0.5]]) {
    assert.throws(() => configure({ home_position: bad }), /home_position must be \[x, y\], two fractions from 0 to 1/, String(bad));
  }
});

test('homeOffset puts the centre (0.5 - fraction) x size away from home', () => {
  assert.deepEqual(homeOffset([0.5, 0.5], 960, 600), [0, 0]);
  const [dx, dy] = homeOffset([0.5625, 0.49], 960, 600);
  assert.ok(close(dx, -60) && close(dy, 6), `${dx}, ${dy}`);
  assert.deepEqual(homeOffset([0, 1], 800, 400), [400, -200]);
});
