# Changelog

## Unreleased

- Horizon: the Xbox toggle is now a round button with the Xbox logo, gray when off and green when on (breathing
  while it starts or stops), in place of the leading icon and the sliding switch. The whole tile still taps.

## 1.2.0

- One resource loads all three cards. `wall-radar-card.js` (the file HACS registers) now loads
  `wall-horizon-card.js` and `wall-thermostat-card.js` from its own folder with its own query string, and they load
  their library, Leaflet and fonts the same way. Every HACS update (a new `?hacstag=`) therefore reaches every file,
  so screens no longer keep an old Horizon, thermostat or library for weeks, and there is no resource order to get
  wrong. The radar card never waits for the other two: if one fails to load, the radar card still works and the
  browser console gets one line. Each file still works when registered on its own.
- Upgrading from 1.1.x: remove the `wall-horizon-card.js` and `wall-thermostat-card.js` resource entries; keep the
  `wall-radar-card.js` one. While a leftover entry exists, an old copy of a card can load first; the radar card then
  names it in the browser console. README, "Upgrading from 1.1.x".
- The upgrade can leave two `wall-radar-card.js` entries (HACS rewrites a 1.1.x extra entry listed above the radar
  one into a second radar entry). The cards still load all three even if the old entry's cached copy defines the
  radar card first; README and `AGENTS.md` say to delete the later entry, and `inspect` and `verify` name it.
- `tools/lovelace-ws.mjs`: `inspect` and `verify` warn about each leftover entry (they remove nothing); `verify`
  accepts the radar resource alone for any of the three cards and fetches the files with that resource's query;
  `add-resource` refuses the other two cards once the radar file is registered.
- Manual install: one resource, `/local/radar-dash/wall-radar-card.js?v=<version>`.
- No change to how any card draws (checked pixel for pixel against 1.1.1 with the same recorded data).

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
