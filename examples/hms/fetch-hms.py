#!/usr/bin/env python3
"""Copy NOAA's Hazard Mapping System smoke and fire data where wall-radar-card can read it (`hms_url`).

NOAA HMS (satellite analysts at NESDIS) maps smoke plumes as light / medium / heavy polygons a few times a day,
and lists every satellite fire detection. Its server sends no CORS headers, so a browser cannot fetch it. Run this
on the Home Assistant host (hms.yaml in this folder does it every 20 minutes) and it writes trimmed copies to
/config/www/hms/, which Home Assistant serves at /local/hms/: set `hms_url: /local/hms` on the card.

    smoke.json  {"at": iso, "features": [{"d": "Light|Medium|Heavy", "rings": [[[lon, lat], ...]]}]}
    fires.json  {"at": iso, "points": [[lon, lat, frp_mw, minutes_ago], ...]}  the last 12 h, merged
                to 0.01 deg (one per ~1 km cell, the strongest), newest time kept

Both cover the whole US and hold nothing about your home (/local is served without a login). A file NOAA has not
changed since the last run is not downloaded again (If-Modified-Since). Python 3 standard library only.

    python3 fetch-hms.py [--out /config/www/hms]
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request

BASE = "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS"
FIRE_HOURS = 12


def get(url, state):
    """The body of url, or None when it's unchanged since last time (or not there yet)."""
    req = urllib.request.Request(url, headers={"User-Agent": "radar-dash/hms-fetch"})
    if url in state:
        req.add_header("If-Modified-Since", state[url])
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            if r.headers.get("Last-Modified"):
                state[url] = r.headers["Last-Modified"]
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code in (304, 404):
            return None
        raise


def day_url(kind, day):
    if kind == "smoke":
        return f"{BASE}/Smoke_Polygons/KML/{day:%Y/%m}/hms_smoke{day:%Y%m%d}.kml"
    return f"{BASE}/Fire_Points/Text/{day:%Y/%m}/hms_fire{day:%Y%m%d}.txt"


def parse_smoke(kml):
    out = []
    # each density is a folder of placemarks: <Folder><name>Smoke (Light)</name> ... </Folder>
    for density, body in re.findall(r"<Folder>\s*<name>Smoke \((\w+)\)</name>(.*?)</Folder>", kml, re.S):
        for pm in re.findall(r"<Placemark>(.*?)</Placemark>", body, re.S):
            rings = []
            for coords in re.findall(r"<coordinates>(.*?)</coordinates>", pm, re.S):
                ring = []
                for xyz in coords.split():
                    p = xyz.split(",")
                    pt = [round(float(p[0]), 3), round(float(p[1]), 3)]
                    if not ring or ring[-1] != pt:
                        ring.append(pt)
                if len(ring) >= 4:
                    rings.append(ring)
            if rings:
                out.append({"d": density, "rings": rings})
    return out


def parse_fires(text, now):
    """[lon, lat, frp, minutes_ago] for detections in the last FIRE_HOURS, from one day's text file."""
    rows = []
    for line in text.splitlines()[1:]:
        p = [x.strip() for x in line.split(",")]
        if len(p) < 8:
            continue
        try:
            lon, lat, yday, hhmm, frp = float(p[0]), float(p[1]), p[2], p[3], float(p[7])
            t = dt.datetime.strptime(yday + hhmm.zfill(4), "%Y%j%H%M").replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
        age = (now - t).total_seconds() / 60
        if 0 <= age <= FIRE_HOURS * 60:
            rows.append((lon, lat, max(frp, 0), age))
    return rows


def merge_fires(rows):
    cells = {}
    for lon, lat, frp, age in rows:
        k = (round(lon, 2), round(lat, 2))
        c = cells.get(k)
        if c is None:
            cells[k] = [k[0], k[1], frp, age]
        else:
            c[2] = max(c[2], frp)
            c[3] = min(c[3], age)
    return [[x, y, round(f, 1), round(a)] for x, y, f, a in cells.values()]


def write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/config/www/hms")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    state_path = os.path.join(args.out, ".state.json")
    try:
        state = json.load(open(state_path))
    except (OSError, ValueError):
        state = {}
    now = dt.datetime.now(dt.timezone.utc)
    today, yesterday = now.date(), now.date() - dt.timedelta(days=1)
    at = now.isoformat(timespec="seconds")

    # smoke: today's analysis, or yesterday's until today's first one is out
    smoke_path = os.path.join(args.out, "smoke.json")
    for day in (today, yesterday):
        kml = get(day_url("smoke", day), state)
        if kml is not None:
            write(smoke_path, {"at": at, "day": day.isoformat(), "features": parse_smoke(kml)})
            break
        if os.path.exists(smoke_path) and json.load(open(smoke_path)).get("day") == day.isoformat():
            break  # unchanged since the last run

    # fires: the last 12 h can span yesterday's file. Day texts are cached here so an unchanged file
    # (304) still counts; detections age out on every run.
    rows, changed = [], False
    for day in (yesterday, today):
        url = day_url("fire", day)
        cache = os.path.join(args.out, f".fire-{day:%Y%m%d}.txt")
        text = get(url, state)
        if text is not None:
            open(cache, "w").write(text)
            changed = True
        elif os.path.exists(cache):
            text = open(cache).read()
        if text:
            rows += parse_fires(text, now)
    for name in os.listdir(args.out):  # drop day caches older than yesterday
        m = re.match(r"\.fire-(\d{8})\.txt$", name)
        if m and m.group(1) < f"{yesterday:%Y%m%d}":
            os.remove(os.path.join(args.out, name))
    points = merge_fires(rows)
    write(os.path.join(args.out, "fires.json"), {"at": at, "points": points})

    write(state_path, state)
    smoke = json.load(open(smoke_path))["features"] if os.path.exists(smoke_path) else []
    print(f"smoke {len(smoke)} areas, fires {len(points)} cells (last {FIRE_HOURS} h){'' if changed else ', no new detections file'}")


if __name__ == "__main__":
    sys.exit(main())
