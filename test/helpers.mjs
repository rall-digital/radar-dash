// Shared by the test/*.test.mjs files (not a test file itself).
import { WallRadarCard } from '../dist/wall-radar-card.js';

// The card's own setConfig with a bare object standing in for the element: isConnected is false,
// so it only validates and normalises. Returns the resulting config.
export function configure(config) {
  const el = {};
  WallRadarCard.prototype.setConfig.call(el, config);
  return el._config;
}

export const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
