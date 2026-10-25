# Trip Weather (PWA)

Static, dependency-free PWA: enter **From**, **To** and a **departure time**, get a driving route with
~6–10 places along the way, each with ETA and the hourly forecast nearest to that ETA
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
node test/fallback-test.mjs                               # reverse-geocode fallbacks + error paths
```

Regenerate icons: `python3 icons/make_icons.py` (Pillow).

## How it works

| Step | API | Notes |
|---|---|---|
| Autocomplete / place lookup | Open-Meteo Geocoding `geocoding-api.open-meteo.com/v1/search` | debounced 250 ms; if no suggestion picked, first hit is used |
| Use my location | `navigator.geolocation` + reverse geocode | |
| Route | OSRM demo `router.project-osrm.org/route/v1/driving` | `overview=full&geometries=geojson`; endpoint snapped >5 km from a road → "no driving route" |
| Sampling | — | interval `clamp(distance/8, 15, 60)` km along the geometry; last via dropped if within 0.4·interval of destination |
| ETA | — | `departure + duration × (cumulative geometry km / total geometry km)` |
| Place names | Nominatim reverse (`zoom=10`) → BigDataCloud client reverse → `"lat, lon"` | sequential, ≥1.1 s between Nominatim calls; cached in `localStorage` per ~1 km cell (`tw:rev:<lat2>,<lon2>`) |
| Weather | Open-Meteo forecast, **one multi-location request** | `hourly=temperature_2m,precipitation,precipitation_probability,cloud_cover,weather_code&timezone=auto&timeformat=unixtime&forecast_days=16` |

Time handling: the departure `datetime-local` is interpreted in the device's zone. Forecast slots are
requested as Unix timestamps (`timeformat=unixtime`) so matching ETA → nearest hour is exact, including
across DST changes; ETAs and slot times are displayed in each point's own IANA zone (`timezone` from the
response, `utc_offset_seconds` as fallback). An ETA more than 90 min outside the returned hourly window is
shown as *out of range (in the past)* or *no forecast available (beyond 16-day horizon)*.

Map: Leaflet 1.9.4 from unpkg (SRI-pinned), OSM tiles; loaded lazily and hidden if it fails — the app works without it.

Security: every API-derived string goes through `textContent` / DOM nodes (Leaflet tooltips get DOM nodes, not HTML strings). No `innerHTML`.

PWA: `manifest.webmanifest`, 192/512 + maskable + apple-touch icons, `sw.js`:
app shell stale-while-revalidate; Leaflet lib cache-first; APIs and tiles network-only (never cached).
Offline: shell loads, an "offline" badge shows, and requests fail with a clear message.
Bump `VERSION` in `sw.js` when shipping changes.

## Files

```
index.html  styles.css  app.js (UI)  lib.js (logic + API wrappers, also require()-able in Node)
sw.js  manifest.webmanifest  icons/  test/route-test.mjs  test/fallback-test.mjs
```

## Limitations

- Driving only; OSRM public demo server: no traffic, no ferries timing guarantees, fair-use/rate limits, no SLA.
- Nominatim usage policy: ≤1 req/s and an identifying Referer/UA (browser sends these). Long routes
  (60 km cap → e.g. 2000 km ≈ 33 stops) take ~1 s per uncached name. For heavy use, self-host or switch provider.
- `zoom=10` names are municipality-level, so two adjacent stops can share a name.
- Forecast resolution is hourly and per ~1–11 km grid cell; precipitation is the hour's sum (mm).
- Departure time is entered in device-local time, not the start location's zone.
- No breaks/stops are modelled in the ETA.

## Hosting

The GitHub repo is private, so free GitHub Pages is not available. Options (all static, no config needed):
- **Cloudflare Pages** – connect the repo or `npx wrangler pages deploy .`
- **Netlify** – drag-and-drop the folder at app.netlify.com/drop, or connect the repo
- **Vercel** – `npx vercel --prod` (static)
- Any HTTPS static host / your own nginx/Caddy. HTTPS (or localhost) is required for the service worker and geolocation.
