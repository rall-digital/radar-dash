# Options

Every option of the three cards: name, type, default, and the entity domain it needs (if any). This file is the
reference for a person or a coding agent mapping a Home Assistant setup onto the cards without reading the source.

Rules that hold for all three cards:

- An option that is left out takes its default. "unset" in the default column means there is no default.
- No option names a personal entity by default. A feature whose entity is unset is not drawn and does nothing.
- Entity options take an entity ID as a string. "domain" says which kind of entity works.

## wall-radar-card

`type: custom:wall-radar-card` is the only required line.

### Location and source

| option | type | default | entity domain | meaning |
|---|---|---|---|---|
| `center_latitude` | number | unset: Home Assistant's own latitude (`hass.config`) | none | Map centre. Set both centre options or neither. |
| `center_longitude` | number | unset: Home Assistant's own longitude | none | Map centre. |
| `zoom_level` | number | `8` | none | Map zoom. Fractions work. |
| `home_position` | `[x, y]`, each 0..1 | `[0.5, 0.5]` | none | Where the centre is drawn, as fractions of the map area. Kept there on resize. |
| `site` | string (NEXRAD ID, e.g. `DMX`) | unset: the site nearest the centre, from IEM's NEXRAD site list | none | The radar used for high-resolution data. The pick is exposed as `data-site`. |
| `site_latitude` / `site_longitude` | number | unset: looked up from the site list | none | Override the site's own coordinates (used for the hybrid blend range). |
| `source` | `hybrid` \| `site` \| `composite` | `hybrid` | none | `hybrid`: the site's N0B (250 m) within `site_range_km`, MRMS (1 km) in its gaps and beyond. `site`: N0B only. `composite`: the national n0q composite (no site needed). |
| `site_range_km` | number | `150` | none | Hybrid: site data out to this range. |
| `blend_km` | number | `40` | none | Hybrid: blended into MRMS over this distance past `site_range_km`. |
| `clutter_dbz` | number | `20` | none | Hybrid: drop site echoes below this that have no MRMS echo nearby. `-32` turns it off. |
| `clutter_radius_px` | number | `16` | none | Hybrid: "nearby", in source pixels. |

### Look

| option | type | default | entity domain | meaning |
|---|---|---|---|---|
| `height` | CSS length | `525px` | none | Card height, colour bar included. `100vh` for a full-screen panel view. |
| `basemap` | `hillshade_dark_coast` \| `hillshade_dark` \| `satellite` \| `ink` \| `night` \| `auto` | `hillshade_dark_coast` | `auto` reads `sun.sun` (optional) | `auto` shows `day_basemap` while the sun is up and `night_basemap` after sunset. A missing `sun.sun` counts as day. |
| `day_basemap` | any basemap except `auto` | `ink` | none | Used by `basemap: auto`. |
| `night_basemap` | any basemap except `auto` | `night` | none | Used by `basemap: auto`. |
| `palette` | `smooth` \| `nws` \| `universal_blue` \| `twc` \| `n0q` \| `neon` | `neon` | none | Radar colours. `neon` (the default since 1.2.8; before that `smooth`) runs from plum through magenta, pink, orange and yellow to white: brighter means heavier. |
| `smooth` | boolean | `true` | none | Blur the dBZ field before colouring, for soft edges. |
| `min_dbz` | number or `false` | `5` | none | Transparent below this. `false` shows everything. |
| `fade_dbz` | number or `false` | `15` | none | Alpha ramps from `min_dbz` to full here. Equal to `min_dbz` gives a hard cut. |
| `satellite_fade_dbz` | number or `false` | `8` | none | Over the `satellite` basemap the fade starts here instead, so faint rain does not blend into green land. |
| `opacity` | number 0..1 | `0.8` | none | Radar opacity. |
| `detail` | integer | `1` | none | Tiles are requested at `zoom + detail`. |
| `radar_retina` | boolean | `false` | none | Request radar at retina zoom on HiDPI screens (4x the tiles and memory). |
| `show_color_bar` | boolean | `true` | none | The 8 px dBZ strip across the top. |
| `show_progress` | boolean | `true` | none | A 2 px loop-position line: solid for observed frames, dotted for forecast. |
| `show_labels` | boolean | `false` | none | Place names (CARTO). Off means those tiles are never requested. |
| `show_attribution` | boolean | `true` | none | The data-source credit line on the map: the basemap's providers, OpenStreetMap and CARTO when labels are on, and NOAA/NWS via IEM. The providers' terms ask for it; if you turn it off, credit them elsewhere on the display. |
| `show_status` | boolean | `false` | none | A small chip when data is stale or the site is offline. The text is always in `data-status`. |

### Loop

| option | type | default | entity domain | meaning |
|---|---|---|---|---|
| `frame_count` | integer | `15` | none | Observed frames (newest N scans of the last 60 min). The composite has at most 12. |
| `frame_delay` | number (ms) | `400` | none | Time per frame. |
| `transition_ms` | number (ms) | `400` | none | Crossfade between frames. `0` = hard cuts. |
| `now_hold_ms` | number (ms) | `1500` | none | Hold on the newest observed frame. |
| `restart_delay` | number (ms) | `800` | none | Hold on the last frame before the loop restarts. |
| `forecast_hours` | number | `2` | none | HRRR forecast after "now", 15-minute steps, drawn desaturated. `0` = off. |
| `forecast_max_age_h` | number | `4` | none | Hide the forecast when the newest HRRR run is older than this (capped at 8). |
| `echo_dbz` | number | `20` | none | Threshold for `data-echoes` and `data-rain-at`. |
| `warnings` | boolean | `true` | none | NWS warning outlines: tornado red, severe thunderstorm yellow, flash flood green, special marine orange. |

### Watchdog

| option | type | default | entity domain | meaning |
|---|---|---|---|---|
| `watchdog` | boolean | `true` | none | Self-healing for a page that is never reloaded. `false` turns all of it off. |
| `watchdog_restart_min` | number | `20` | none | No successful poll for this long: rebuild the card. `0` = never. |
| `watchdog_reload_min` | number | `45` | none | No successful poll for this long: reload the page, at most once per 2 h. `0` = never. |

### Development

| option | type | default | entity domain | meaning |
|---|---|---|---|---|
| `warnings_url` | URL | IEM | none | Override the warnings feed (for fixtures). |
| `forecast_meta_url` | URL | IEM | none | Override the HRRR run metadata (for fixtures). |

### Outputs (`data-*` attributes on the element)

The card fires no events. A parent card, a test or an installer reads these. Absent or empty means unknown.

| attribute | value |
|---|---|
| `data-status` | Status text: empty when healthy, else e.g. `Radar unavailable`, `DMX offline · composite 3:10 PM`, `Radar 2:40 PM · 31 min old`. |
| `data-mode` | `site`, `hybrid` or `composite`: what is on screen now. |
| `data-site` | The NEXRAD site in use (configured or auto-picked). Absent until the first poll resolves it, and in `source: composite`. |
| `data-frames`, `data-frame`, `data-forecast-frames` | Frames in the loop, the one on screen, forecast frames among them. `data-frames` of 1 or more means radar is drawing. |
| `data-frame-time`, `data-frame-kind` | The frame on screen: ISO time, and `observed` or `forecast`. |
| `data-basemap` | The basemap on screen (`auto` resolved). |
| `data-credits` | The credit text for what is on screen, whether or not `show_attribution` draws it. |
| `data-warnings` | Warning outlines drawn. |
| `data-echoes` | Frame on screen: radar pixels in view at or above `echo_dbz`. |
| `data-home-dbz`, `data-now-dbz` | dBZ at the centre: frame on screen, and newest observed frame. |
| `data-rain-at`, `data-rain-peak-dbz` | First forecast frame at or above `echo_dbz` at the centre (ISO time), and the highest forecast dBZ there. |
| `data-home-warnings` | JSON list of warnings covering the centre: `[{"phenomena":"TO","expire_utc":"..."}]`. |
| `data-watchdog` | The watchdog's last action and time. Absent until it acts. |
| `data-holes` | Debugging: tiles missing from loaded frames and their retries. |

## wall-horizon-card

`type: custom:wall-horizon-card`. As-is: a 1280 x 800 design scaled to fit, with a 24-hour clock, English text
and temperatures treated as °F (see the README). Loaded by the `wall-radar-card.js`
resource; it needs no resource of its own. With nothing but `type` it shows the radar, the clock and the date.

| option | type | default | entity domain | meaning |
|---|---|---|---|---|
| `height` | CSS length | `100vh` | none | Card height. |
| `radar` | mapping | `{}` | none | Options passed to the embedded `wall-radar-card` (any of them except `height`, `show_color_bar`, `show_progress`, which the layout sets, and `show_attribution`, which here controls Horizon's own credit line). `radar.echo_dbz` is also the rain threshold for the callout. |
| `temperature_entity` | entity | unset: no temperature shown | `sensor` (numeric state) | The large outside temperature, top right. |
| `weather_entity` | entity | unset: no condition line, no forecast rows | `weather` (must support daily and hourly forecasts) | Condition (with `show_condition`), today's high/low (with `show_high_low`), a 4-day forecast, and input to the callout. |
| `sun_entity` | entity | `sun.sun` | `sun` | Day/night icon and the callout's "clear tonight" line. |
| `rooms` | list of up to 3 `{ entity, icon, name }` | `[]` | `climate` | Room temperatures along the bottom; a tap opens a thermostat sheet (target, mode, fan). `icon` (an `mdi:` name) and `name` are optional; a name with spaces is shown on two lines, split at the space nearest the middle. |
| `music` | entity | unset: no pill | `media_player` | While it is `playing`: a now-playing pill with a pause button, in place of the `xbox`/`screen` controls. |
| `xbox.switch` | entity | unset: no button | `switch` | A toggle drawn as a round Xbox-logo button, with no label or status text: gray when off, green when on. `turn_on`/`turn_off` are called; its state confirms. |
| `xbox.now_playing` | entity | unset | `sensor` (text state) | Read out by screen readers while the switch is on; not drawn. |
| `screen.down` / `screen.up` | entity | unset: that button is not drawn | `automation` | Each is an arrow-only button (up, then down) beside a two-line "Projector Screen" label; it triggers its automation (`automation.trigger`, conditions skipped). |
| `screen.seconds` | number > 0 | `45` | none | How long the button's progress bar runs. |
| `volume.down` / `volume.up` | entity | unset: the tap does nothing | `script` | Hidden taps: the date runs `volume.down`, the temperature runs `volume.up`. |
| `volume.targets` | list of entities, any length | `[]` | `media_player` | Whose `volume_level` the toast reads: the first target that is `on`, else the last. Empty: the toast says only "Volume up/down". |
| `volume.labels` | list of strings, one per target | `[]` | none | Names for the toast. Missing: the target's friendly name. |
| `select.remote` | entity | unset: the tap does nothing | `remote` | Hidden tap on the clock: `remote.send_command`. |
| `select.command` | string | `select` | none | The command sent. |
| `select.num_repeats` / `select.delay_secs` | number | `1` / `0.4` | none | Passed to `remote.send_command`. |
| `select.label` | string | `Apple TV` | none | Device name in the toast. |
| `rain_window` | entity | unset: the callout uses the hourly forecast instead | `input_text` | A helper you fill from your own automation with `phase\|start\|end\|misses`: phase is `none`, `soon` or `raining`; start and end are ISO times; the fourth field is ignored by the card. Nothing in this project writes it. Most installs leave it unset. |
| `show_callout` | boolean | `false` | none | The weather bubble beside the home dot (with its lead line). Off by default. The callout is still worked out while hidden, because calm mode uses it. |
| `show_condition` | boolean | `false` | none | The current condition (icon and words) under the temperature, top right. Off by default. |
| `show_high_low` | boolean | `false` | none | Today's high and low (↑ / ↓) after the current condition, top right. Off by default; the 4-day forecast still shows them. |
| `callout.heavy_dbz` / `callout.moderate_dbz` | number | `45` / `30` | none | Radar thresholds for "heavy" and "moderate" in the callout. |
| `callout.hourly_pop` / `callout.daily_pop` | number (percent) | `60` / `50` | none | Forecast rain-chance thresholds for the callout. |
| `show_attribution` | boolean | `true` | none | The data-source credit line along the bottom edge (the embedded map's own credit would sit under the layout's shade, so Horizon draws it). `false` here, or `show_attribution: false` inside `radar:`, turns it off; then credit the providers elsewhere on the display. |
| `calm_drift` | boolean | `true` | none | With no rain in view, the map drifts slowly. Off under `prefers-reduced-motion`. |
| `calm_echo_floor` | number >= 0 | `50` | none | Echo pixels at or under this count as "no rain in view". |

### Minimum useful Horizon config

```yaml
type: custom:wall-horizon-card
temperature_entity: sensor.outdoor_temperature
weather_entity: weather.forecast_home
```

### What an installer should map

| card option | look for |
|---|---|
| radar centre | nothing to do if Home Assistant's location is set; else `center_latitude` / `center_longitude` |
| `weather_entity` | the `weather.*` entity the household already uses; if several, ask |
| `temperature_entity` | a `sensor.*` with `device_class: temperature` that is outdoors; if unclear, ask, or leave unset |
| `rooms` | up to 3 `climate.*` entities; if more than 3, ask which |
| `music` | a `media_player.*` the household plays music on; optional |
| everything under `xbox`, `screen`, `volume`, `select`, `rain_window` | leave unset unless the human asks for it and names the entities |

## wall-thermostat-card

`type: custom:wall-thermostat-card`. One `climate` entity, any dashboard, ordinary card sizes. Loaded by the
`wall-radar-card.js` resource (it needs no resource of its own, and does not use the radar); it loads
`wall-horizon-lib.js` from the same folder.

| option | type | default | entity domain | meaning |
|---|---|---|---|---|
| `entity` | entity | required | `climate` | The thermostat. |
| `name` | string | the entity's friendly name, else the entity ID | none | The card's title. |

What it reads from the entity: `state` (the hvac mode), `temperature`, `target_temp_low` / `target_temp_high`,
`current_temperature`, `min_temp`, `max_temp`, `target_temp_step`, `hvac_modes`, `fan_mode`, `fan_modes`,
`friendly_name`; and `hass.config.unit_system.temperature` for the defaults below.

| behaviour | rule |
|---|---|
| step | `target_temp_step`; else 0.5 in °C, 1 otherwise |
| range | `min_temp` to `max_temp`; else 7 to 35 in °C, 45 to 95 otherwise |
| adjustable | modes `heat`, `cool`, `heat_cool`, `auto`, with a single `temperature` target |
| not adjustable | `off`, `dry`, `fan_only` (room temperature shown dimmed); unavailable; a `heat_cool` low/high pair (shown read-only) |
| services | `climate.set_temperature` (`temperature`), `climate.set_hvac_mode`, `climate.set_fan_mode`, on `entity` only |
| sending | a target is sent about 1 s after the last change; a chip at once; a failure or no confirmation within 10 s puts the old value back and says "<name> didn't respond" |

Installer mapping: one `climate.*` entity found, use it; several, ask which (one card per entity is fine).
