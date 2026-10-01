# Changelog

## 1.1.0

- New card: `custom:wall-thermostat-card`, a thermostat dial for one `climate` entity that works on any dashboard.
  Drag, tap or step the target temperature; change the hvac mode and the fan mode. It shares its dial and send
  logic with the Horizon card's thermostat sheet (`wall-horizon-lib.js`). It needs its own resource entry:
  `wall-thermostat-card.js`.
- `tools/lovelace-ws.mjs` knows the third card: `add-resource`, `remove-resource`, `verify` and the by-type lookup
  accept it, and `verify` no longer asks for the radar card's resource on a dashboard that holds only the
  thermostat card.
- `AGENTS.md`: a thermostat-only install path.
- No change to `wall-radar-card` or `wall-horizon-card`.

## 1.0.0 (2026-10-01)

- First public release: `custom:wall-radar-card` (NEXRAD radar loop, US only) and `custom:wall-horizon-card`
  (the full-screen wall layout, as-is), the agent install procedure and `tools/lovelace-ws.mjs`.
