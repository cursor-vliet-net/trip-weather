/* Trip Weather — pure logic + API wrappers. Works in browser (window.TW) and Node (require). */
(function (root) {
  'use strict';

  const API = {
    geocode: 'https://geocoding-api.open-meteo.com/v1/search',
    osrm: 'https://router.project-osrm.org/route/v1/driving/',
    nominatim: 'https://nominatim.openstreetmap.org/reverse',
    bdc: 'https://api.bigdatacloud.net/data/reverse-geocode-client',
    forecast: 'https://api.open-meteo.com/v1/forecast',
  };
  const FORECAST_DAYS = 16;
  const NOMINATIM_MIN_INTERVAL_MS = 1100; // usage policy: max 1 req/s
  const CACHE_PREFIX = 'tw:rev:';

  // ---------- geometry ----------
  const R_KM = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;

  /** Great-circle distance in km between [lon,lat] pairs. */
  function haversineKm(a, b) {
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /** Cumulative distance (km) at each vertex of a [lon,lat] polyline. */
  function cumulativeKm(coords) {
    const out = new Array(coords.length);
    out[0] = 0;
    for (let i = 1; i < coords.length; i++) out[i] = out[i - 1] + haversineKm(coords[i - 1], coords[i]);
    return out;
  }

  /** Sampling interval: ~distance/8, clamped to [15, 60] km. */
  function sampleIntervalKm(totalKm) {
    return Math.min(60, Math.max(15, totalKm / 8));
  }

  /** Point at distance d (km) along polyline, linear interpolation between vertices. */
  function pointAtKm(coords, cum, d) {
    if (d <= 0) return coords[0].slice();
    const last = coords.length - 1;
    if (d >= cum[last]) return coords[last].slice();
    let lo = 0, hi = last;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    const seg = cum[hi] - cum[lo];
    const t = seg > 0 ? (d - cum[lo]) / seg : 0;
    return [coords[lo][0] + t * (coords[hi][0] - coords[lo][0]), coords[lo][1] + t * (coords[hi][1] - coords[lo][1])];
  }

  /**
   * Sample stops along the route geometry.
   * routeKm / durationS come from OSRM; along-geometry fraction is used for both km display and ETA.
   * Returns [{lon, lat, km, frac, etaMs, kind:'start'|'via'|'end'}].
   */
  function sampleRoute(coords, routeKm, durationS, departMs) {
    const cum = cumulativeKm(coords);
    const geomKm = cum[cum.length - 1] || 1e-9;
    const step = sampleIntervalKm(routeKm);
    const stops = [];
    const push = (geomD, kind) => {
      const frac = Math.min(1, Math.max(0, geomD / geomKm));
      const [lon, lat] = pointAtKm(coords, cum, geomD);
      stops.push({ lon, lat, km: frac * routeKm, frac, etaMs: departMs + frac * durationS * 1000, kind });
    };
    push(0, 'start');
    // Steps are in route-km; map to geometry-km proportionally.
    for (let k = step; k < routeKm - step * 0.4; k += step) push((k / routeKm) * geomKm, 'via');
    push(geomKm, 'end');
    return stops;
  }

  // ---------- time ----------
  /** Index of hourly slot nearest to t (ms), or -1 if outside forecast window (±90 min tolerance). */
  function nearestHourIndex(timesUnixS, tMs) {
    if (!timesUnixS || !timesUnixS.length) return -1;
    const t = tMs / 1000;
    const first = timesUnixS[0], last = timesUnixS[timesUnixS.length - 1];
    if (t < first - 5400 || t > last + 5400) return -1;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < timesUnixS.length; i++) {
      const d = Math.abs(timesUnixS[i] - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** Format epoch ms in an IANA zone; falls back to fixed offset if zone unknown. */
  function formatLocal(ms, timeZone, offsetS, opts) {
    const o = Object.assign({ weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }, opts || {});
    try {
      if (timeZone) return new Intl.DateTimeFormat(undefined, Object.assign({ timeZone }, o)).format(new Date(ms));
    } catch (_) { /* fall through */ }
    if (typeof offsetS === 'number') {
      return new Intl.DateTimeFormat(undefined, Object.assign({ timeZone: 'UTC' }, o)).format(new Date(ms + offsetS * 1000));
    }
    return new Intl.DateTimeFormat(undefined, o).format(new Date(ms));
  }

  function formatDuration(s) {
    const m = Math.round(s / 60);
    const h = Math.floor(m / 60);
    return h ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
  }

  // ---------- weather codes (WMO) ----------
  const WMO = {
    0: ['☀️', 'Clear'], 1: ['🌤️', 'Mainly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
    45: ['🌫️', 'Fog'], 48: ['🌫️', 'Rime fog'],
    51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Dense drizzle'],
    56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'],
    61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
    66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
    71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'],
    80: ['🌦️', 'Rain showers'], 81: ['🌧️', 'Rain showers'], 82: ['⛈️', 'Violent showers'],
    85: ['🌨️', 'Snow showers'], 86: ['❄️', 'Heavy snow showers'],
    95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm, hail'], 99: ['⛈️', 'Thunderstorm, hail'],
  };
  const weatherInfo = (code) => WMO[code] || ['❔', 'Unknown'];

  // ---------- fetch helpers ----------
  class ApiError extends Error {
    constructor(msg, kind) { super(msg); this.kind = kind || 'api'; }
  }

  async function getJson(url, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 15000;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetch(url, Object.assign({ signal: ctl && ctl.signal, headers: { Accept: 'application/json' } }, opts && opts.fetch));
    } catch (e) {
      throw new ApiError(e && e.name === 'AbortError' ? 'Request timed out' : 'Network error (offline?)', 'network');
    } finally { if (timer) clearTimeout(timer); }
    if (!res.ok) throw new ApiError(`HTTP ${res.status} from ${new URL(url).host}`, 'http');
    try { return await res.json(); } catch (_) { throw new ApiError(`Invalid JSON from ${new URL(url).host}`, 'api'); }
  }

  /** Open-Meteo geocoding search. Returns [{name, label, lat, lon, timezone}]. */
  async function geocode(query, opts) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const lang = (opts && opts.language) || 'en';
    const url = `${API.geocode}?name=${encodeURIComponent(q)}&count=${(opts && opts.count) || 6}&language=${encodeURIComponent(lang)}&format=json`;
    const data = await getJson(url, { fetch: opts && opts.signal ? { signal: opts.signal } : undefined });
    return (data.results || []).map((r) => ({
      name: r.name,
      label: [r.name, r.admin1, r.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '),
      lat: r.latitude, lon: r.longitude, timezone: r.timezone,
    }));
  }

  /** OSRM driving route. Returns {coords:[[lon,lat]...], km, durationS}. */
  async function route(from, to) {
    const url = `${API.osrm}${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=false`;
    let data;
    try { data = await getJson(url, { timeoutMs: 25000 }); }
    catch (e) { throw new ApiError(`Routing failed: ${e.message}`, e.kind); }
    if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
      throw new ApiError(data.code === 'NoRoute' ? 'No driving route found between these places.' : `Routing failed (${data.code || 'unknown'}${data.message ? ': ' + data.message : ''})`, 'route');
    }
    // OSRM snaps endpoints to the nearest road; a far snap means there is no real road route (e.g. across an ocean).
    const snap = (data.waypoints || []).map((w) => w.distance || 0);
    const SNAP_MAX_M = 5000;
    snap.forEach((d, i) => {
      if (d > SNAP_MAX_M) throw new ApiError(`No driving route: ${i ? 'destination' : 'start'} is ${Math.round(d / 1000)} km from the nearest routable road.`, 'route');
    });
    const r = data.routes[0];
    return { coords: r.geometry.coordinates, km: r.distance / 1000, durationS: r.duration };
  }

  // ---------- reverse geocoding with cache + rate limit ----------
  const memCache = new Map();
  const storage = (() => { try { return root.localStorage || null; } catch (_) { return null; } })();
  const cacheKey = (lat, lon) => `${CACHE_PREFIX}${lat.toFixed(2)},${lon.toFixed(2)}`;
  function cacheGet(k) {
    if (memCache.has(k)) return memCache.get(k);
    if (storage) { try { const v = storage.getItem(k); if (v) { memCache.set(k, v); return v; } } catch (_) {} }
    return null;
  }
  function cacheSet(k, v) {
    memCache.set(k, v);
    if (storage) { try { storage.setItem(k, v); } catch (_) {} }
  }
  let lastNominatim = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function nominatimName(d) {
    const a = d.address || {};
    const place = a.city || a.town || a.village || a.hamlet || a.municipality || d.name || a.county;
    const region = a.county && a.county !== place ? a.county : a.state;
    return [place, region].filter(Boolean).join(', ') || d.display_name || null;
  }
  function bdcName(d) {
    const place = d.city || d.locality;
    return [place, d.principalSubdivision].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ') || null;
  }

  /** Reverse geocode → {name, source}. Nominatim (≤1 req/s) → BigDataCloud → "lat, lon". */
  async function reverseGeocode(lat, lon, opts) {
    const k = cacheKey(lat, lon);
    const hit = cacheGet(k);
    if (hit) return { name: hit, source: 'cache' };
    const lang = (opts && opts.language) || 'en';
    try {
      const wait = lastNominatim + NOMINATIM_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastNominatim = Date.now();
      const extra = opts && opts.userAgent ? { headers: { Accept: 'application/json', 'User-Agent': opts.userAgent } } : undefined;
      const d = await getJson(`${API.nominatim}?format=jsonv2&zoom=10&addressdetails=1&accept-language=${encodeURIComponent(lang)}&lat=${lat}&lon=${lon}`, { timeoutMs: 10000, fetch: extra });
      const n = !d.error && nominatimName(d);
      if (n) { cacheSet(k, n); return { name: n, source: 'nominatim' }; }
    } catch (_) { /* fall back */ }
    try {
      const d = await getJson(`${API.bdc}?latitude=${lat}&longitude=${lon}&localityLanguage=${encodeURIComponent(lang)}`, { timeoutMs: 10000 });
      const n = bdcName(d);
      if (n) { cacheSet(k, n); return { name: n, source: 'bigdatacloud' }; }
    } catch (_) { /* fall back */ }
    return { name: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, source: 'coords' };
  }

  // ---------- weather ----------
  /** One multi-location Open-Meteo request; returns array aligned with points. */
  async function forecastMulti(points) {
    const lat = points.map((p) => p.lat.toFixed(4)).join(',');
    const lon = points.map((p) => p.lon.toFixed(4)).join(',');
    const url = `${API.forecast}?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,precipitation,precipitation_probability,cloud_cover,weather_code` +
      `&timezone=auto&timeformat=unixtime&forecast_days=${FORECAST_DAYS}`;
    let data;
    try { data = await getJson(url, { timeoutMs: 20000 }); }
    catch (e) { throw new ApiError(`Weather request failed: ${e.message}`, e.kind); }
    const arr = Array.isArray(data) ? data : [data];
    if (arr.length !== points.length) throw new ApiError('Weather response did not match requested points', 'api');
    return arr;
  }

  /** Pick the hourly values nearest to etaMs. Returns null when out of range. */
  function pickWeather(fc, etaMs) {
    const h = fc && fc.hourly;
    if (!h) return null;
    const i = nearestHourIndex(h.time, etaMs);
    if (i < 0) return null;
    const val = (a) => (a && a[i] != null ? a[i] : null);
    return {
      timeMs: h.time[i] * 1000,
      temp: val(h.temperature_2m), precip: val(h.precipitation), precipProb: val(h.precipitation_probability),
      cloud: val(h.cloud_cover), code: val(h.weather_code),
    };
  }

  /** Classify why a forecast is missing. */
  function rangeReason(fc, etaMs) {
    const t = fc && fc.hourly && fc.hourly.time;
    if (!t || !t.length) return 'no forecast available';
    if (etaMs / 1000 < t[0]) return 'out of range (in the past)';
    return 'no forecast available (beyond 16-day horizon)';
  }

  function summarize(rows, rt) {
    const w = rows.map((r) => r.wx).filter(Boolean);
    const temps = w.map((x) => x.temp).filter((v) => v != null);
    const precs = w.map((x) => x.precip).filter((v) => v != null);
    const probs = w.map((x) => x.precipProb).filter((v) => v != null);
    return {
      km: rt.km, durationS: rt.durationS, stops: rows.length, withForecast: w.length,
      tMin: temps.length ? Math.min(...temps) : null, tMax: temps.length ? Math.max(...temps) : null,
      precipMax: precs.length ? Math.max(...precs) : null, probMax: probs.length ? Math.max(...probs) : null,
    };
  }

  const TW = {
    API, haversineKm, cumulativeKm, sampleIntervalKm, pointAtKm, sampleRoute, nearestHourIndex,
    formatLocal, formatDuration, weatherInfo, geocode, route, reverseGeocode, forecastMulti,
    pickWeather, rangeReason, summarize, ApiError,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = TW;
  else root.TW = TW;
})(typeof globalThis !== 'undefined' ? globalThis : this);
