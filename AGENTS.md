# AGENTS.md: installing radar-dash on someone's Home Assistant

You are a coding agent. A person asked you to install radar-dash on their Home Assistant. You have this
repository and nothing else. This file is the whole procedure. Follow the steps in order.

radar-dash is three Lovelace custom cards: `custom:wall-radar-card` (a NEXRAD radar loop, US only),
`custom:wall-horizon-card` (a full-screen wall layout around it, shipped as-is) and `custom:wall-thermostat-card`
(a thermostat dial for one climate entity; it does not need the radar). The product is the `dist/` folder.
There is no build step and nothing to compile.

## Rules that hold for the whole install

These exist because the dashboard you are touching is someone's home. Breaking any of them is a failed install,
even if the card ends up working.

1. **The token is a secret.** It reaches the tool only through the environment (`HA_TOKEN`, or `HA_TOKEN_FILE`
   naming a file the human made). You never write it to a file, never put it in a command line, never echo or
   print it, never include it in a summary, and never ask the human to paste it into the chat. Step 1 has the
   exact flow, including what to do if they paste it anyway.
2. **No write without a yes.** Before each write to Home Assistant, show the human exactly what will change and
   wait for an explicit yes to that change. A yes to one write is not a yes to the next.
3. **Back up before every dashboard write**, and keep the backup files until the human says the install is fine.
   The backup covers the dashboard only. Registering a resource (step 3) happens before it, is additive (it
   changes no dashboard and no existing resource), is not in any backup, and is undone with `remove-resource`.
4. **Add a new view. Never edit, reorder or replace an existing view, and never save a whole dashboard you
   assembled yourself.** The only whole-dashboard write allowed is `restore` from a backup file, as a rollback.
5. **Read back after every write** and compare it with what you intended.
6. **Do not guess entities.** Map what is unambiguous, ask about what is not, and leave a feature unset when
   nothing fits. An unset feature is simply not drawn.
7. Do not restart Home Assistant, do not edit `configuration.yaml`, and do not install anything else, unless the
   human asks for a feature that needs it and says yes to that specific step.

The radar data covers the United States only. Step 1 checks the country; do not skip that check for an install
that includes the radar or Horizon. A thermostat-only install does not depend on the country.

Local files: the tool writes backups to `./radar-dash-work/` (created on first use, covered by this repo's
`.gitignore`). Put the `view.json` you write there too. Those files describe the human's home: do not commit them,
do not copy them elsewhere, and do not paste their contents into a summary.

## Step 1: get access

The tool needs two things in its environment: `HA_URL` (for example `http://homeassistant.local:8123`) and the
token. Your shell may be a fresh process for every command, so a variable you export in one command is gone in the
next. That is why the human sets them, not you. First check whether they already did:

```sh
node tools/lovelace-ws.mjs inspect
```

If that prints JSON, access works; go on. If it says `REFUSED: set HA_URL ...`, ask the human to do ONE of these,
in this order of preference. Give them the text; do not run it for them.

**A. Before launching you (preferred).** They quit this session, run this in their own terminal, then start you
again from that same terminal, so every command you run inherits both values:

```sh
export HA_URL=http://homeassistant.local:8123
read -rs HA_TOKEN && export HA_TOKEN     # paste the token, press Enter; nothing is shown
```

**B. A token file (no restart needed).** In their own terminal, outside this clone:

```sh
umask 077 && mkdir -p ~/.config/radar-dash
read -rs T && printf '%s' "$T" > ~/.config/radar-dash/token && unset T     # paste the token, press Enter
```

Then you prefix each command with the two variables, which hold a URL and a path, not the secret:

```sh
HA_URL=http://homeassistant.local:8123 HA_TOKEN_FILE=$HOME/.config/radar-dash/token node tools/lovelace-ws.mjs inspect
```

The tool refuses a token file that other users can read (`chmod 600` fixes it). Never `cat` that file.

The token is a long-lived access token: in Home Assistant, the human's profile (bottom left) > Security >
Long-lived access tokens > Create token. Suggest the name "radar-dash install" so they can find it again.

**If the human pastes the token into the chat anyway:** say plainly that it is now stored in this conversation's
transcript, that you will use it for this install only, and that they must delete that token in Home Assistant
when the install is done (end of step 5). Do not repeat it back, and do not put it on a command line yourself:
there is no exception to rule 1. Ask them to do B with that token in their own terminal, then carry on with
`HA_TOKEN_FILE`.

The tool needs Node 22 or later (`node --version`) and has no dependencies.

`inspect` only reads. It prints:

| field | meaning |
|---|---|
| `version` | Home Assistant version |
| `location_set` | whether Home Assistant has a latitude and longitude (the coordinates are not printed). The radar centres there by default. |
| `country` | the country code set in Home Assistant, or `null` |
| `hacs_installed` | whether HACS is present |
| `resource_count` | how many dashboard resources are registered in total. Note it: after you register one it must be exactly one higher, and nothing else may change. |
| `resources` | radar-dash resources already registered |
| `warnings` | problems the next HACS update would cause (empty when fine); see step 3 |
| `dashboards` | every dashboard: its `dashboard` name (the url_path you pass to other commands, `default` for Overview), `mode`, its views, and any of the three cards found on it |

Exit code 2 with `auth_invalid` means the token is wrong; a connection failure means the URL is wrong.

**Country check** (radar and Horizon only). If `country` is anything other than `US`, stop and tell the human: the radar, forecast and
warnings are US-only data, and outside the US the map will draw with no radar on it. Go on only if they say they
still want it (for example a US location with the country unset). If `country` is `null`, ask where the location is.

Stop and tell the human if `inspect` shows one of the cards is already on a dashboard, or a radar-dash resource
is already registered. Ask whether they want a second view, or only updated files. If `warnings` is not empty, read
it to the human and offer the fix under "Resource order" in step 3.

## Step 2: discover and map

```sh
node tools/lovelace-ws.mjs entities weather sensor climate media_player sun
```

Each line is `entity_id`, friendly name, device class and unit. It never prints an entity's state, and it lists
only temperature sensors: states and other sensors can hold addresses, network names and people's whereabouts,
which have no business in your transcript. Do not fetch states another way. If the human asks for a sensor that
is not a temperature sensor, `--all-sensors` lists the rest (still without states). Read [docs/options.md](docs/options.md): it
lists every option of the three cards with its type, default and the entity domain it needs.

Decide with the human which install they want:

- **Radar only** (recommended, and the default if they did not say): no entity mapping is needed at all. If
  `inspect` reported `location_set: true`, the card config is the single line `type: custom:wall-radar-card`. If
  it is false, ask the human for a latitude and longitude and set `center_latitude` and `center_longitude`.
- **Horizon** (the full wall layout): map these, and only these, unless the human asks for more:

  | option | how to choose |
  |---|---|
  | `weather_entity` | the `weather.*` entity. One: use it. Several: ask. None: leave unset. |
  | `temperature_entity` | a `sensor.*` with device class `temperature` that is clearly outdoors. Unclear: ask. None: leave unset. |
  | `rooms` | up to 3 `climate.*` entities. More than 3: ask which. None: leave it out. |
  | `music` | optional; only if the human names a `media_player.*`. |

  Leave `xbox`, `screen`, `volume`, `select` and `rain_window` out. They need switches, automations and scripts
  that this project does not create. Add one only if the human asks for it and names the entities;
  `examples/horizon.yaml` shows the shape.
- **Thermostat** (a dial for one climate entity; can be installed alone, or next to the radar): pick the entity.
  One `climate.*` entity listed: use it. Several: ask which (one card per entity is fine if they want several).
  None: this card cannot be installed; say so. The only other option is `name`; leave it out unless asked.
  `examples/thermostat.yaml` shows the card. It needs only its own resource, `wall-thermostat-card.js`.

Tell the human what you mapped and what you left out, in a short list, before going on.

## Step 3: install the files and register the resource

This step comes before the dashboard backup, and the backup does not cover it. A resource is an entry in Home
Assistant's list of dashboard scripts. Adding one is additive: no dashboard and no existing resource changes, and
`remove-resource` takes exactly that entry out again (step 6). `inspect`'s `resource_count` must go up by exactly
one per resource you register.

Choose one path. If both are possible and the human has no preference, use HACS (it also handles updates).

**A. HACS** (when `inspect` shows `hacs_installed: true`). HACS has no API you should drive. Ask the human to do
this in the HACS screen, then confirm with `inspect`:

1. HACS > three-dot menu > Custom repositories > add `https://github.com/rall-digital/radar-dash`, type Dashboard.
2. Open radar-dash in HACS and download it.

HACS registers `/hacsfiles/radar-dash/wall-radar-card.js` itself. Horizon and the thermostat card each need one
more resource. Register them only AFTER the download, and only once `inspect` lists the HACS radar entry, even for a
thermostat-only install: see "Resource order" below. Each is a write, so show it and get a yes first:

```sh
node tools/lovelace-ws.mjs add-resource /hacsfiles/radar-dash/wall-horizon-card.js --confirm-write      # Horizon
node tools/lovelace-ws.mjs add-resource /hacsfiles/radar-dash/wall-thermostat-card.js --confirm-write   # thermostat
```

**Resource order.** On every update, HACS rewrites the FIRST resource whose URL starts with `/hacsfiles/radar-dash/`
to the radar card file. The radar entry must therefore come first; a Horizon or thermostat entry before it (or with
no radar entry at all) is turned into a second radar entry by the next update, and that card stops loading.
`inspect` reports this under `warnings` and `verify` prints a `WARN:` line. The fix, each step a write with its own
yes: `remove-resource` each `/hacsfiles/radar-dash/` entry that is not the first radar entry, have the human
redownload radar-dash in HACS if no radar entry is left, then `add-resource` the extra entries again (new entries go
to the end of the list). Check with `inspect` that `warnings` is empty. Never remove the HACS radar entry itself.
If an update already left two entries with the SAME radar URL, `remove-resource` refuses (`found 2`): ask the human
to delete the later of the two under Settings > Dashboards > three-dot menu > Resources, then run `verify` again.

**B. By hand** (no HACS, or the human prefers it). The files must end up in `/config/www/radar-dash/` on the Home
Assistant machine, with the `fonts/` folder inside it. You probably cannot reach that filesystem; do not look for
a way around that. Ask the human to copy the contents of `dist/` there using whatever they already use (the Samba
or File editor add-on, the Studio Code Server add-on, or scp if they have SSH set up). If you do have a mounted
path or SSH that the human gave you for this purpose, show the copy command and get a yes before running it.

Then register the resources. Each is a write: show it, get a yes, run it.

```sh
node tools/lovelace-ws.mjs add-resource /local/radar-dash/wall-radar-card.js --confirm-write
node tools/lovelace-ws.mjs add-resource /local/radar-dash/wall-horizon-card.js --confirm-write   # Horizon only
node tools/lovelace-ws.mjs add-resource /local/radar-dash/wall-thermostat-card.js --confirm-write   # thermostat only
```

Register only what the install uses: a thermostat-only install needs just the last line, not the radar's.
`add-resource` refuses anything but these three files, and refuses to register a file twice. If Home Assistant
answers that resources cannot be managed (a YAML-mode setup), stop: tell the human to add the lines under
`lovelace: resources:` in their configuration themselves, and continue when they have.

If the files were copied into a brand-new `/config/www/` folder, Home Assistant must be restarted once before
`/local/` is served. That is the human's call; ask.

## Step 4: add the view

Below, `<dashboard>` is the name `inspect` printed in each entry's `dashboard` field: a url_path such as
`wall-radar`, or `default` for Overview.

1. **Choose the dashboard with the human.** Rules:
   - A dashboard in `yaml` mode cannot be written by the tool. Give the human the YAML to paste and stop here.
   - The default Overview dashboard with "no stored config" is auto-generated. Do not write to it: saving would
     replace everything Home Assistant shows there. The tool refuses this.
   - **If the human says "you pick", or has no preference: create a NEW dashboard.** It touches nothing that
     exists. It is a write, so show it and ask:
     ```sh
     node tools/lovelace-ws.mjs create-dashboard wall-radar "Wall radar" --confirm-write
     ```
     The first argument is the url-path (lower-case words joined by hyphens). From here on, that same word is
     your `<dashboard>`: `wall-radar` in this example.
2. **Write the view to `radar-dash-work/view.json`** (create the folder if `backup` has not yet). One view object,
   not a dashboard. Start from `examples/radar-panel-view.yaml` or `examples/horizon.yaml`, converted to JSON,
   with the entities you mapped. Radar only:
   ```json
   {
     "title": "Radar",
     "path": "radar",
     "type": "panel",
     "cards": [{ "type": "custom:wall-radar-card", "height": "100vh", "basemap": "auto" }]
   }
   ```
   Thermostat only (an ordinary view, not a panel, so the card keeps its normal size):
   ```json
   {
     "title": "Climate",
     "path": "climate",
     "cards": [{ "type": "custom:wall-thermostat-card", "entity": "climate.<the one you mapped>" }]
   }
   ```
3. **Back up the dashboard.** This only reads Home Assistant. It prints the path of the file it wrote, named with
   the time; it never overwrites a file. Note the path: it is your `<backup>` below.
   ```sh
   node tools/lovelace-ws.mjs backup <dashboard>
   ```
4. **Plan.** This only reads. It prints the view and says what `add-view` would do, or why it would refuse.
   ```sh
   node tools/lovelace-ws.mjs plan-view <dashboard> radar-dash-work/view.json
   ```
5. **Show the human** the view as YAML, name the dashboard, and say that it will be added as a new view and that
   existing views are not touched. Wait for a yes.
6. **Write.**
   ```sh
   node tools/lovelace-ws.mjs add-view <dashboard> radar-dash-work/view.json <backup> --confirm-write
   ```
   `add-view` refuses unless the backup file matches the dashboard as it is at that moment, so a backup always
   exists and nothing changed in between. It appends one view, reads the dashboard back, and checks that there is
   exactly one more view and that every earlier view is identical to before. On success it prints
   `view added at index N ...; M existing view(s) unchanged (read back)`.
   - `READBACK MISMATCH`: go to Rollback now.
   - `THE WRITE WAS SENT ... reading the dashboard back failed`: the write probably happened. Do NOT run
     `add-view` again. Run `readback <dashboard>` and look before doing anything else.

If `add-view` says the dashboard changed since the backup, somebody edited it. Take a fresh backup, plan again,
show the human again.

## Step 5: verify

```sh
node tools/lovelace-ws.mjs verify <dashboard>
```

Exit 0 means: the card is on the dashboard, its resource is registered, and the card file plus the files it loads
(Leaflet for the radar; the library and fonts for Horizon; the library for the thermostat) are really served by Home Assistant (HTTP 200, fetched without
the token). If it reports a file as not served, the files are not where the resource URL points: fix step 3.

That proves the configuration and the files, not the picture. Ask the human to open the new view and tell you what
they see, or look yourself if you have a browser tool. The address is `<HA_URL>/<dashboard>/<view path>`, for
example `http://homeassistant.local:8123/wall-radar/radar`. For the `default` dashboard the first part is
`lovelace`: `<HA_URL>/lovelace/radar`.

- The map draws within a few seconds and the radar loop starts within about 20 seconds. If it is dry, the radar
  layer is empty; that is normal.
- In the browser's developer tools, the `wall-radar-card` element carries `data-frames` (1 or more once radar
  frames have loaded), `data-mode` (`hybrid`, `site` or `composite`), `data-site` (the radar it picked) and
  `data-status` (empty when healthy; text when something is degraded).
- The thermostat card shows the entity's name, its target in the middle of the dial and its modes underneath.
  It sends nothing until someone touches it; do not touch it to test it.
- "Custom element doesn't exist" means the browser has not loaded the resource: hard-reload the page.

Then tell the human to **reload the page once on the wall device** (the tablet or screen that will show it), so it
picks up the new resource.

Finish with a short summary: which dashboard and view, which entities were mapped, what was left unset, where the
backup file is, and the rollback commands below with their real arguments filled in. Do not include the token.

**Last step, always:** tell the human to delete the long-lived token now (profile > Security > Long-lived access
tokens), and the token file if they made one (`rm ~/.config/radar-dash/token`). The cards do not need it; it was
only for this install. If they want to keep it for a later rollback, that is their choice to make, knowingly.

## Step 6: rollback

Each of these is a write: show it, get a yes, run it. Use them in this order and stop as soon as the human is happy.

1. Remove only the view you added. Take a fresh backup first (`backup <dashboard>`); `remove-view` refuses
   without one that matches the live dashboard. The view must still equal `view.json` exactly, and it must hold
   one of this project's cards; if the human edited it since, ask them to delete it in the dashboard editor.
   ```sh
   node tools/lovelace-ws.mjs remove-view <dashboard> radar-dash-work/view.json <fresh backup> --confirm-write
   ```
2. Unregister a resource you added (the exact URL you registered). It only accepts this project's three card
   files. Resources HACS registered are removed by removing radar-dash in HACS.
   ```sh
   node tools/lovelace-ws.mjs remove-resource /local/radar-dash/wall-radar-card.js --confirm-write
   ```
3. Last resort, if a readback mismatched or the dashboard looks wrong: put the whole dashboard back from the
   backup taken in step 4. Anything changed on that dashboard after that backup is lost, so say that first. The
   tool saves the dashboard as it is now to `radar-dash-work/pre-restore-<dashboard>-<time>.json` before writing.
   ```sh
   node tools/lovelace-ws.mjs restore <dashboard> <backup> --confirm-write
   ```
4. A dashboard you created with `create-dashboard` is deleted by the human under Settings > Dashboards. Files in
   `/config/www/radar-dash/` can be deleted the same way they were copied.

## Tool reference

`node tools/lovelace-ws.mjs <mode>`; `<dashboard>` is a url_path, or `default`.

| mode | writes? | what it does |
|---|---|---|
| `inspect` | no | version, country, location set or not, HACS, resource count, resources, dashboards, cards found by type |
| `entities [domain ...] [--all-sensors]` | no | names, device class and unit of entities; never states |
| `backup <dashboard> [out.json]` | no (local file only) | saves the dashboard config to a new, timestamped file |
| `plan-view <dashboard> <view.json>` | no | what `add-view` would do |
| `readback <dashboard> [out.json]` | no (local file only) | saves the dashboard config as it is now |
| `verify <dashboard>` | no | exit 0 if a card and its resource are present and the files are served |
| `add-resource <url>` | yes | registers one of the three card files |
| `create-dashboard <url-path> <title>` | yes | a new, empty dashboard |
| `add-view <dashboard> <view.json> <backup.json>` | yes | appends one view; needs a current backup; reads back |
| `remove-view <dashboard> <view.json> <backup.json>` | yes | removes the one view equal to the file; needs a current backup |
| `remove-resource <url>` | yes | unregisters that exact URL; only this project's card files |
| `restore <dashboard> <backup.json>` | yes | whole dashboard from a backup, after a pre-restore snapshot |

Every write mode exits 2 without `--confirm-write`, before any connection is opened. Cards are located by their
`type`, never by a view's path or position, because people rearrange their dashboards.

The tool never overwrites a local file. Each request to Home Assistant has its own 20-second timeout.

Exit codes: 0 done; 1 the tool refused for a stated reason or Home Assistant returned an error (read the message,
do not retry blindly); 2 missing `--confirm-write`, missing `HA_URL` or token, an unreadable or too-open token file,
an unknown mode, or a rejected token.
