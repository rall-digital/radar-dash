# NOAA HMS for the smoke layer

The `smoke` layer, and the satellite fire detections under the `fires` layer, come from NOAA's
[Hazard Mapping System](https://www.ospo.noaa.gov/products/land/hms.html). Its server sends no CORS headers, so the
card cannot fetch it from a browser. Instead, Home Assistant fetches it every 20 minutes and serves a trimmed copy
from `/config/www/hms/` at `/local/hms/`.

1. Copy `fetch-hms.py` to `/config/scripts/fetch-hms.py`.
2. Copy `hms.yaml` to `/config/packages/hms.yaml`. If you have no packages folder yet, add this to
   `configuration.yaml` first:

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```

3. Restart Home Assistant once (a new `shell_command` needs it). The automation runs at start, so
   `/local/hms/smoke.json` and `/local/hms/fires.json` exist a minute later.
4. On the card: `hms_url: /local/hms`, then `layers: [smoke]` or the picker (`show_layer_picker: true`).

Without `hms_url` the picker does not offer Smoke, and the fires layer shows NIFC's named fires only.

The files cover the whole US and hold nothing about your home, which matters because `/local/` is served without a
login. Smoke is about 150 KB and fires about 50 KB; a file NOAA has not changed is not downloaded again.
