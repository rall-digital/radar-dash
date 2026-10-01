# Changelog

## 1.1.1

- `wall-thermostat-card` honours the precision of the entity's `target_temp_step`: a 0.25 step shows and sends
  21.25, not 21.3, and every value it sends lands on the step grid. Steps of 1 and 0.5 behave exactly as before.
- HACS resource order: HACS rewrites the first `/hacsfiles/radar-dash/` resource to the radar card on every update,
  so the Horizon and thermostat resources must be added after the HACS download. README and `AGENTS.md` say so and
  explain how to check and fix an existing install; `tools/lovelace-ws.mjs` `inspect` reports it under `warnings`
  and `verify` prints a `WARN:` line.
- `tools/lovelace-ws.mjs inspect` lists a `wall-thermostat-card` resource wherever it is registered.
- README: the "United States only" note applies to the radar and Horizon cards; the thermostat card works anywhere.
- Tests: `npm test` (Node 22+, no dependencies) runs the card and tool tests against `dist/`.

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
