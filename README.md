# radar-dash

A weather-radar wall display for Home Assistant: two Lovelace custom cards, plain JavaScript, no build step,
no API keys.

- **`wall-radar-card`** loops live NEXRAD radar over a dark or satellite basemap, with a short-range forecast and
  NWS warning outlines. This is the supported part. One line of YAML is enough to run it.
- **`wall-horizon-card`** is the full-screen wall layout built around it: clock, date, outside temperature, forecast,
  room thermostats and a few household controls. It ships **as-is, adapt it**: it was drawn for one 1280 x 800
  tablet, and every household feature is optional.

**United States only.** The radar (NEXRAD, MRMS), the forecast (HRRR) and the warnings (NWS) cover the US.
Elsewhere the basemap draws and the radar stays empty.

![wall-radar-card: a radar loop over a dark hillshade basemap](screenshots/radar-card.png)

![wall-horizon-card: the full-screen wall layout](screenshots/horizon-card.png)

Both screenshots show Oklahoma City with placeholder entities and made-up readings.

## Install with Claude Code

If you use [Claude Code](https://claude.com/claude-code) or another coding agent, paste this:

```
Clone https://github.com/rall-digital/radar-dash and follow AGENTS.md to install it on my Home Assistant.
```

Before you start the agent, set your Home Assistant URL and a long-lived access token in your terminal (`HA_URL`
and `HA_TOKEN`; AGENTS.md step 1 has the exact lines). The agent never needs the token pasted into the chat. It
finds your weather, temperature and climate entities, installs the files, and adds the radar as a **new view**. It takes a backup first, shows you the
YAML, and writes only when you say yes. [AGENTS.md](AGENTS.md) is the full procedure, including rollback.

## Install with HACS

1. In HACS, open the three-dot menu, choose **Custom repositories**, add
   `https://github.com/rall-digital/radar-dash` with type **Dashboard**.
2. Find **radar-dash** in HACS and download it. HACS registers the resource
   `/hacsfiles/radar-dash/wall-radar-card.js` for you.
3. Add a card to a dashboard:
   ```yaml
   type: custom:wall-radar-card
   ```
4. Only if you want the Horizon layout: add a second resource by hand under **Settings > Dashboards > three-dot menu
   > Resources**: URL `/hacsfiles/radar-dash/wall-horizon-card.js`, type **JavaScript module**. HACS registers
   one file per repository, and that one is the radar card.

The card loads Leaflet, its stylesheet, the Horizon library and two fonts from the folder it was loaded from.
HACS downloads the whole `dist/` folder, so they sit next to it. If the map area stays blank after a HACS install,
check that `/hacsfiles/radar-dash/leaflet.js` opens in your browser; if it does not, use the manual install below.

## Install by hand

1. Copy everything in `dist/` (the `fonts/` folder included) to `/config/www/radar-dash/` on your Home Assistant.
2. **Settings > Dashboards > three-dot menu > Resources > Add resource**: URL
   `/local/radar-dash/wall-radar-card.js`, type **JavaScript module**. For the Horizon layout add
   `/local/radar-dash/wall-horizon-card.js` the same way.
3. Reload the browser, then add the card as above.

When you update the files later, add or change a `?v=2` suffix on the resource URL so browsers fetch the new copy.
The card passes its own suffix on to the files it loads.

## wall-radar-card

```yaml
type: custom:wall-radar-card
```

With nothing else set, the card centres on your Home Assistant location (Settings > System > General) and uses the
nearest NEXRAD radar. More examples are in [examples/](examples/); every option is in
[docs/options.md](docs/options.md). The ones people change most:

| option | default | meaning |
|---|---|---|
| `height` | `525px` | Card height. `100vh` for a full-screen panel view. |
| `center_latitude` / `center_longitude` | your Home Assistant location | Map centre. Set both or neither. |
| `zoom_level` | `8` | Map zoom. Fractions work. |
| `site` | nearest NEXRAD radar | A site ID such as `DMX`, if you want a different radar. |
| `source` | `hybrid` | `hybrid`: one radar's high-resolution data (250 m) near it, MRMS (1 km) in its gaps and beyond. `site`: that radar only. `composite`: the national mosaic. |
| `basemap` | `hillshade_dark_coast` | Also `hillshade_dark`, `satellite`, `ink`, `night`, or `auto` (day/night by `sun.sun`). |
| `day_basemap` / `night_basemap` | `ink` / `night` | What `basemap: auto` shows. |
| `palette` | `smooth` | Also `nws`, `universal_blue`, `twc`, `n0q`. |
| `frame_count` | `15` | Observed frames, from the last 60 minutes. |
| `frame_delay` | `400` | Milliseconds per frame. |
| `forecast_hours` | `2` | HRRR forecast frames after "now", drawn desaturated. `0` turns them off. |
| `warnings` | `true` | NWS warning outlines: tornado red, severe thunderstorm yellow, flash flood green, special marine orange. |
| `show_labels` | `false` | Place names. |
| `show_attribution` | `true` | The data-source credit line on the map. See "Data sources" before turning it off. |
| `show_status` | `false` | A small chip when the data is stale or the radar site is offline. |
| `watchdog` | `true` | Self-healing for a page that is never reloaded. See below. |

The map is static: no dragging, zooming or controls. It is meant to be looked at, not operated.

### How it behaves

- Every frame preloads hidden, three at a time, and the loop starts when the set has loaded. New scans join as
  they appear and the oldest drops out.
- Every radar pixel is decoded back to dBZ and recoloured in a canvas, so the palette, the fade and the smoothing
  are the card's own.
- If the radar site's newest scan is more than 20 minutes old, or the site is offline, the card switches to the
  national composite and switches back when the site returns.
- On a failed poll the card keeps the frames it has and backs off (2 minutes, doubling to 30).
- A tile that fails is retried once; a hole left in a loaded frame is asked for again on later polls, a few times.
- A card detached for 60 seconds frees its map and rebuilds when re-attached.

### Watchdog

A wall tablet's page can run for weeks without a reload, so the card heals itself (`watchdog`, on by default):

- Every 60 seconds it checks that polling is alive, and restarts it if not.
- No successful poll for `watchdog_restart_min` (20) rebuilds the card. For `watchdog_reload_min` (45) it reloads
  the page, at most once per 2 hours. If the browser's storage is unavailable it never reloads, so it cannot loop.
- A dry sky is healthy: a poll the network answered counts as successful, echoes or not.
- When the page becomes visible again or the network returns, it polls at once. Time spent asleep is not counted
  as failing.

Set `watchdog: false` to turn all of it off, or either minute value to `0` to turn that step off.

## wall-horizon-card (as-is, adapt it)

```yaml
type: custom:wall-horizon-card
temperature_entity: sensor.outdoor_temperature
weather_entity: weather.forecast_home
rooms:
  - entity: climate.living_room
    name: Living room
```

This is a household display that was built for one home and then made configurable. What that means in practice:

- The layout is a fixed 1280 x 800 design, scaled to fit the screen. It suits a landscape tablet in a panel view.
  It is not responsive and not meant for phones.
- It needs both resources registered: `wall-radar-card.js` and `wall-horizon-card.js`.
- **24-hour clock, English, Fahrenheit.** The clock is always `HH:MM` in 24-hour form and the date is in US
  English. Temperatures are shown as whole numbers with a degree sign and no unit conversion: the forecast bar
  colours (cool below about 62, warm above) and the thermostat's fallback range (61 to 88) assume °F. With a
  Celsius system the numbers are right but the colours and that fallback range are not.
- The data-source credit line runs along the bottom edge (`show_attribution`, on by default). The embedded map's
  own credit would sit under the layout's bottom shade, so Horizon draws it instead.
- Every entity is optional. Anything you do not configure is not drawn. With only `type` set you get the radar,
  the clock and the date.
- Up to 3 `climate` rooms. Tapping one opens a thermostat sheet (target, mode, fan).
- A "callout" next to your location says what the radar and forecast mean right now: rain starting or ending, a
  warning over you, or a quiet line about the day.
- The household controls are specific: a switch drawn as an "Xbox" pill, two projector-screen buttons that each
  trigger an automation, hidden volume taps on the date and the temperature, a hidden "select" tap on the clock,
  and a now-playing pill. Each needs entities, scripts or automations that you provide. They are not created for
  you. [examples/horizon.yaml](examples/horizon.yaml) shows all of them with placeholder entities, and
  [examples/packages/scene_switch.yaml](examples/packages/scene_switch.yaml) is one way to make the switch.

| option | default | needs | meaning |
|---|---|---|---|
| `radar` | `{}` | | Options for the embedded radar card. |
| `temperature_entity` | unset | `sensor` | Outside temperature. |
| `weather_entity` | unset | `weather` | Condition line, 4-day forecast, callout. |
| `sun_entity` | `sun.sun` | `sun` | Day/night. |
| `rooms` | `[]` | `climate` (up to 3) | Room temperatures and thermostat sheet. |
| `music` | unset | `media_player` | Now-playing pill. |
| `show_attribution` | `true` | | The credit line along the bottom edge. |
| `xbox` | unset | `switch` (+ optional `sensor`) | The scene toggle. |
| `screen` | unset | two `automation`s | Screen down / up buttons. |
| `volume` | unset | two `script`s, `media_player` targets | Hidden volume taps. |
| `select` | unset | `remote` | Hidden clock tap. |
| `rain_window` | unset | `input_text` | Optional rain timing you supply yourself. |

Full types and defaults: [docs/options.md](docs/options.md). If you want something different, fork it: the card is
one file of plain JavaScript plus a library of pure functions.

## Kiosk tips

- Use a **panel** view so the card fills the screen, and a kiosk browser such as Fully Kiosk Browser, or any
  browser in full-screen mode.
- Give the wall device its own Home Assistant user, without admin rights.
- Keep the screen on and let the watchdog handle stale data. You should not need a scheduled page reload.
- Older or slower tablets: lower `frame_count`, set `forecast_hours: 0`, keep `radar_retina: false`.
  The defaults hold about 23 frames of canvases in memory.
- After updating the card files, reload the page once on the wall device.

## Data sources

All sources are free and need no key. The cards call them straight from the browser; nothing goes through a
server of ours, and the cards send no analytics. Please keep the credit line on (`show_attribution`), or credit
the providers elsewhere on your display.

| what | provider | credit shown on the map |
|---|---|---|
| NEXRAD site radar, MRMS, national composite, HRRR forecast tiles, NWS warning polygons, radar site list | [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) (IEM), Iowa State University, serving NOAA / National Weather Service data | `Radar, forecast and warnings: NOAA/NWS via Iowa Environmental Mesonet (IEM)` |
| Satellite imagery (`satellite`, `ink`, and half of `hillshade_dark_coast`) | [Esri](https://www.esri.com/) World Imagery | `Imagery: Esri, Vantor, Earthstar Geographics, and the GIS User Community` |
| Hillshade (`hillshade_dark`, `hillshade_dark_coast`) | Esri World Hillshade Dark | `Hillshade: Esri, Vantor, Airbus DS, USGS, NGA, NASA, CGIAR, N Robinson, NCEAS, NLS, OS, NMA, Geodatastyrelsen, Rijkswaterstaat, GSA, Geoland, FEMA, Intermap, and the GIS user community` |
| Night basemap (`night`) | [NASA GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api), VIIRS Black Marble 2016 | `Night lights: NASA Black Marble via NASA GIBS` |
| Place labels (only with `show_labels`) | [CARTO](https://carto.com/attributions) basemaps, built on [OpenStreetMap](https://www.openstreetmap.org/copyright) data (ODbL) | `Labels: © OpenStreetMap contributors, © CARTO` |

The Esri lines are each service's own copyright text as it read on 2026-09-30. The credits are plain text, not
links: on a wall display a tapped link would navigate the kiosk away from the dashboard. The links are here instead.
The same text is on the element as `data-credits`, whether or not it is drawn.

These are volunteer-run or public services. IEM in particular is a university project that serves this data to
everyone for free: keep the default poll rates, and if you build something heavier on top, read
[their terms](https://mesonet.agron.iastate.edu/disclaimer.php) and talk to them first. The basemap providers have
their own terms of use, and Esri's and CARTO's in particular set conditions on who may use their tiles and how;
you are responsible for meeting them on your display. IEM says its material is in the public domain and that
attribution "would be appreciated"; NWS data is in the public domain; NASA asks to be acknowledged as the source.

Bundled: Leaflet 1.9.4 (BSD 2-Clause) and the Figtree and Fredoka fonts (SIL Open Font License). See
[LICENSES/](LICENSES/).

## Troubleshooting

| symptom | check |
|---|---|
| "Custom element doesn't exist: wall-radar-card" | The resource is not registered, or the browser has a stale copy. Check Settings > Dashboards > Resources, then hard-reload. |
| Card area stays empty | Home Assistant has no location set and the card has no `center_latitude`/`center_longitude`. Set either. |
| Basemap draws, no radar | Outside the US, or no rain: the radar layer is transparent when it is dry. Set `show_status: true` to see whether data is arriving. |
| Horizon card missing | `wall-horizon-card.js` needs its own resource entry (see install step 4). |
| Want to see what the card is doing | Inspect the element: `data-status`, `data-mode`, `data-site`, `data-frames` (see docs/options.md). |

## Development

There is no build. `dist/` is the product: edit the files and reload. This repository is generated from a private
working tree by an export script, so pull requests cannot be merged directly, but issues and patches are welcome
and get applied upstream.

`tools/lovelace-ws.mjs` is a small Home Assistant websocket helper (Node 22+, no dependencies) used by the agent
install: read-only inspection, a dashboard backup, and a few guarded writes that refuse without `--confirm-write`.
Its local files (backups, the view being added) go to `radar-dash-work/`, which `.gitignore` covers.

## License

MIT. Copyright (c) 2026 RALL DIGITAL LLC. See [LICENSE](LICENSE).

Not affiliated with Home Assistant, NOAA, the National Weather Service, Iowa State University, Esri, NASA or CARTO.
This is a hobby display, not a safety tool: do not rely on it for warnings.

---

Made by [Rall Digital](https://rall.digital). Contact: eric@rall.digital
