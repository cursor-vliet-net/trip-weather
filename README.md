# Trip Weather (PWA)

Static, dependency-free PWA: enter **From**, optional **stops (via)**, **To** and a **departure time**, get a driving
route with ~6–10 places along the way plus your stops, each with ETA and the hourly forecast nearest to that ETA
(temperature, precipitation + probability, cloud cover, weather emoji). No build step, no API keys.

## Run

```sh
python3 -m http.server 8080      # in this directory
# open http://localhost:8080  (service worker needs http://localhost or https)
```

Tests (Node ≥ 18, live APIs):

```sh
node test/route-test.mjs                                  # Oslo → Trondheim, tomorrow 08:00 (From's tz)
node test/route-test.mjs Bergen Stavanger 2026-10-28T07:30
node test/via-test.mjs                                    # Oslo → Bergen (45 min stay) → Stavanger vs direct; 3-leg order; via at sea
node test/via-test.mjs Oslo Lillehammer Trondheim         # [from] [via] [to]
node test/fallback-test.mjs                               # reverse-geocode fallbacks + error paths
```

Regenerate icons: `python3 icons/make_icons.py` (Pillow).

## How it works

| Step | API | Notes |
|---|---|---|
| Autocomplete / place lookup | Open-Meteo Geocoding `geocoding-api.open-meteo.com/v1/search` | debounced 250 ms; if no suggestion picked, first hit is used |
| Use my location | `navigator.geolocation` + reverse geocode | |
| Route | OSRM demo `router.project-osrm.org/route/v1/driving/{from};{via1};…;{to}` | one request for all waypoints, `overview=full&geometries=geojson`; any waypoint snapped >5 km from a road → "no driving route: via N …" |
| Leg split | — | each snapped OSRM waypoint is a vertex of the full geometry; boundary = vertex within 50 m of it whose along-geometry km is closest to the km expected from `legs[].distance` (robust to out-and-back routes) |
| Sampling | — | grid every `clamp(total km/8, 15, 60)` km over the whole trip; samples within 0.4·interval of a via or the destination are dropped. Vias are always stops (`kind:'via'`, user's label, no reverse geocoding) |
| ETA | — | per leg: `departure + Σ(previous legs' OSRM duration + stay) + leg duration × (geometry share within leg)`. A via's ETA (and its weather) is the **arrival** time; its stay shifts everything after it |
| Place names | Nominatim reverse (`zoom=10`) → BigDataCloud client reverse → `"lat, lon"` | sequential, ≥1.1 s between Nominatim calls; cached in `localStorage` per ~1 km cell (`tw:rev:<lat2>,<lon2>`) |
| Weather | Open-Meteo forecast, **one multi-location request** | `hourly=temperature_2m,precipitation,precipitation_probability,cloud_cover,weather_code&timezone=auto&timeformat=unixtime&forecast_days=16` |

Time handling: the departure `datetime-local` is interpreted in the device's zone. Forecast slots are
requested as Unix timestamps (`timeformat=unixtime`) so matching ETA → nearest hour is exact, including
across DST changes; ETAs and slot times are displayed in each point's own IANA zone (`timezone` from the
response, `utc_offset_seconds` as fallback). An ETA more than 90 min outside the returned hourly window is
shown as *out of range (in the past)* or *no forecast available (beyond 16-day horizon)*.

Stops (via): "＋ Add stop" adds a row under From (same autocomplete), max 8; ↑/↓ reorder, ✕ removes; empty rows
are ignored. Order = travel order. "Stay … min" (default 0) is the dwell time at that stop. ⇅ reverses the whole trip
(From/To and stop order). From/To/stops (incl. stay) persist in `localStorage` (`tw:last`, `v:2`).

Share link: after a run the URL hash is set to
`#from=lat,lon,label&via=lat,lon,stayMin,label&…&to=lat,lon,label&t=YYYY-MM-DDTHH:MM` and a "Share trip link"
button uses `navigator.share` / clipboard. Opening such a link pre-fills the form (no API calls needed to restore);
editing the form drops the hash.

Card layout: name on its own full-width line (wraps at word boundaries only, `overflow-wrap: break-word`,
`min-width: 0`), km/ETA on a wrapping secondary line. Verified with headless Chrome at 320/360/390 px and at a
simulated 130 % Android font scale (the old one-row flex layout + `overflow-wrap: anywhere` collapsed the name to
one letter per line there).

Map: Leaflet 1.9.4 from unpkg (SRI-pinned), OSM tiles; loaded lazily and hidden if it fails — the app works without it.

Security: every API-derived string goes through `textContent` / DOM nodes (Leaflet tooltips get DOM nodes, not HTML strings). No `innerHTML`.

PWA: `manifest.webmanifest`, 192/512 + maskable + apple-touch icons, `sw.js`:
app shell stale-while-revalidate; Leaflet lib cache-first; APIs and tiles network-only (never cached).
Offline: shell loads, an "offline" badge shows, and requests fail with a clear message.
Bump `VERSION` in `sw.js` when shipping changes: the new worker precaches the shell with `cache: 'reload'`
(bypassing the HTTP cache), `skipWaiting()` + `clients.claim()` take over immediately, and the page reloads itself on
`controllerchange` (or shows a "new version — Reload" bar if results are on screen). Installed apps also call
`registration.update()` when brought to the foreground.

## Files

```
index.html  styles.css  app.js (UI)  lib.js (logic + API wrappers, also require()-able in Node)
sw.js  manifest.webmanifest  icons/  test/route-test.mjs  test/via-test.mjs  test/fallback-test.mjs
```

## Limitations

- Driving only; OSRM public demo server: no traffic, no ferries timing guarantees, fair-use/rate limits, no SLA.
- Nominatim usage policy: ≤1 req/s and an identifying Referer/UA (browser sends these). Long routes
  (60 km cap → e.g. 2000 km ≈ 33 stops) take ~1 s per uncached name. For heavy use, self-host or switch provider.
- `zoom=10` names are municipality-level, so two adjacent stops can share a name.
- Forecast resolution is hourly and per ~1–11 km grid cell; precipitation is the hour's sum (mm).
- Departure time is entered in device-local time, not the start location's zone.
- Breaks are modelled only as the per-stop "Stay" minutes you enter; no automatic rest stops.
- OSRM demo server accepts many waypoints but is rate-limited; the UI caps stops at 8.

## Hosting

GitHub Pages from `main` / root: https://cursor-vliet-net.github.io/trip-weather/ — every push to `main` redeploys
(all paths are relative, so the `/trip-weather/` subpath works). Any other HTTPS static host works too; HTTPS (or
localhost) is required for the service worker and geolocation.
