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
   * Geometry vertex index of each waypoint (incl. start/end) on the full multi-leg polyline.
   * OSRM's snapped waypoint location is a vertex of the overview=full geometry; for robustness against
   * routes that pass the same spot twice (out-and-back vias) we pick, among vertices within 50 m of the
   * snapped location, the one whose along-geometry km is closest to the km expected from the leg distances.
   */
  function legBoundaries(coords, cum, legs, waypoints) {
    const last = coords.length - 1;
    const geomKm = cum[last] || 1e-9;
    const routeKm = legs.reduce((a, l) => a + l.km, 0) || 1e-9;
    const idx = [0];
    let legKm = 0;
    for (let w = 1; w < legs.length; w++) {
      legKm += legs[w - 1].km;
      const expect = (legKm / routeKm) * geomKm;
      const loc = waypoints && waypoints[w] && waypoints[w].location;
      const prev = idx[idx.length - 1];
      let best = -1;
      if (loc) {
        let bestScore = Infinity, nearest = -1, nearestD = Infinity;
        for (let i = prev; i <= last; i++) {
          const d = haversineKm(coords[i], loc);
          if (d < nearestD) { nearestD = d; nearest = i; }
          if (d <= 0.05) { const sc = Math.abs(cum[i] - expect); if (sc < bestScore) { bestScore = sc; best = i; } }
        }
        if (best < 0) best = nearest;
      }
      if (best < 0) { // no location: fall back to expected km
        best = prev;
        while (best < last && cum[best] < expect) best++;
      }
      idx.push(Math.max(prev, best));
    }
    idx.push(last);
    return idx;
  }

  /**
   * Sample stops along the (multi-leg) route geometry.
   *   rt: {coords, km, durationS, legs:[{km, durationS}], legIdx:[vertex index per waypoint]} (from route())
   *   opts.stayS: array (one per via) of dwell seconds added after arriving at that via.
   * km = leg-start km + within-leg geometry share × leg km; ETA likewise uses the leg's OSRM duration, plus the
   * dwell times of all vias already passed. A via's ETA is its arrival time.
   * Returns [{lon, lat, km, frac, etaMs, kind:'start'|'sample'|'via'|'end', viaIndex?, stayS?, departMs?}].
   * Legacy call sampleRoute(coords, routeKm, durationS, departMs) is still supported (single leg).
   */
  function sampleRoute(rt, departMs, opts) {
    if (Array.isArray(rt)) { // legacy (coords, routeKm, durationS, departMs)
      const [coords, routeKm, durationS, dep] = arguments;
      rt = { coords, km: routeKm, durationS, legs: [{ km: routeKm, durationS }], legIdx: [0, coords.length - 1] };
      departMs = dep; opts = undefined;
    }
    const { coords, legs } = rt;
    const cum = cumulativeKm(coords);
    const legIdx = rt.legIdx || legBoundaries(coords, cum, legs, rt.waypoints);
    const stayS = (opts && opts.stayS) || [];
    const routeKm = rt.km;
    const step = sampleIntervalKm(routeKm);

    // Per-leg accumulators: route-km and time offset (incl. dwell) at the start of each leg.
    const legStartKm = [], legStartS = [];
    let accKm = 0, accS = 0;
    legs.forEach((l, i) => {
      legStartKm.push(accKm); legStartS.push(accS);
      accKm += l.km; accS += l.durationS + (i < legs.length - 1 ? Math.max(0, stayS[i] || 0) : 0);
    });

    // Position at route-km k → point on geometry + time offset.
    const at = (leg, kInLeg) => {
      const l = legs[leg];
      const g0 = cum[legIdx[leg]], g1 = cum[legIdx[leg + 1]];
      const share = l.km > 0 ? Math.min(1, Math.max(0, kInLeg / l.km)) : 0;
      const [lon, lat] = pointAtKm(coords, cum, g0 + share * (g1 - g0));
      return { lon, lat, km: legStartKm[leg] + share * l.km, etaMs: departMs + (legStartS[leg] + share * l.durationS) * 1000 };
    };
    const stops = [];
    const add = (p, kind, extra) => stops.push(Object.assign(p, { frac: routeKm > 0 ? p.km / routeKm : 0, kind }, extra));

    add(at(0, 0), 'start');
    for (let leg = 0; leg < legs.length; leg++) {
      const l = legs[leg];
      const kStart = legStartKm[leg], kEnd = kStart + l.km;
      // Global grid k = step, 2·step, … ; skip samples within 0.4·step of either leg end (a via/end is there).
      for (let k = Math.ceil((kStart + 1e-9) / step) * step; k < kEnd - step * 0.4; k += step) {
        if (k - kStart < step * 0.4) continue;
        add(at(leg, k - kStart), 'sample');
      }
      if (leg < legs.length - 1) {
        const p = at(leg, l.km);
        const s = Math.max(0, stayS[leg] || 0);
        add(p, 'via', { viaIndex: leg, stayS: s, departMs: p.etaMs + s * 1000 });
      }
    }
    add(at(legs.length - 1, legs[legs.length - 1].km), 'end');
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
    const o = Object.assign({ weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, opts || {});
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

  // ---------- weather codes (WMO) → Font Awesome solid icon ----------
  // [dayIcon, nightIcon, description, tone]; tone is a CSS class suffix (wx-<tone>) for the icon colour.
  const WMO = {
    0: ['sun', 'moon', 'Clear', 'clear'], 1: ['sun', 'moon', 'Mainly clear', 'clear'],
    2: ['cloud-sun', 'cloud-moon', 'Partly cloudy', 'partly'], 3: ['cloud', 'cloud', 'Overcast', 'cloud'],
    45: ['smog', 'smog', 'Fog', 'fog'], 48: ['smog', 'smog', 'Rime fog', 'fog'],
    51: ['cloud-sun-rain', 'cloud-moon-rain', 'Light drizzle', 'rain'], 53: ['cloud-rain', 'cloud-rain', 'Drizzle', 'rain'],
    55: ['cloud-rain', 'cloud-rain', 'Dense drizzle', 'rain'],
    56: ['icicles', 'icicles', 'Freezing drizzle', 'ice'], 57: ['icicles', 'icicles', 'Freezing drizzle', 'ice'],
    61: ['cloud-sun-rain', 'cloud-moon-rain', 'Light rain', 'rain'], 63: ['cloud-rain', 'cloud-rain', 'Rain', 'rain'],
    65: ['cloud-showers-heavy', 'cloud-showers-heavy', 'Heavy rain', 'heavy'],
    66: ['icicles', 'icicles', 'Freezing rain', 'ice'], 67: ['icicles', 'icicles', 'Freezing rain', 'ice'],
    71: ['snowflake', 'snowflake', 'Light snow', 'snow'], 73: ['snowflake', 'snowflake', 'Snow', 'snow'],
    75: ['snowflake', 'snowflake', 'Heavy snow', 'snow'], 77: ['snowflake', 'snowflake', 'Snow grains', 'snow'],
    80: ['cloud-sun-rain', 'cloud-moon-rain', 'Rain showers', 'rain'], 81: ['cloud-showers-heavy', 'cloud-showers-heavy', 'Rain showers', 'heavy'],
    82: ['cloud-showers-heavy', 'cloud-showers-heavy', 'Violent showers', 'heavy'],
    85: ['snowflake', 'snowflake', 'Snow showers', 'snow'], 86: ['snowflake', 'snowflake', 'Heavy snow showers', 'snow'],
    95: ['cloud-bolt', 'cloud-bolt', 'Thunderstorm', 'storm'], 96: ['cloud-bolt', 'cloud-bolt', 'Thunderstorm, hail', 'storm'],
    99: ['cloud-bolt', 'cloud-bolt', 'Thunderstorm, hail', 'storm'],
  };
  /** weather_code (+ is_day 0/1, default day) → {icon, desc, tone}; icon is a Font Awesome solid name. */
  function weatherInfo(code, isDay) {
    const w = WMO[code];
    if (!w) return { icon: 'circle-question', desc: 'Unknown', tone: 'unknown' };
    const night = isDay === 0 || isDay === false;
    return { icon: night ? w[1] : w[0], desc: w[2], tone: night && w[3] === 'clear' ? 'night' : w[3] };
  }

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

  const MAX_VIAS = 8;
  const SNAP_MAX_M = 5000;

  /**
   * OSRM driving route through all points in order (one request: "from;via1;…;to").
   * route(points[]) or legacy route(from, to). Points: {lat, lon}.
   * Returns {coords:[[lon,lat]...], km, durationS, legs:[{km,durationS}], waypoints, legIdx}.
   */
  async function route(points, maybeTo) {
    const pts = Array.isArray(points) ? points : [points, maybeTo];
    if (pts.length < 2) throw new ApiError('Route needs at least a start and a destination.', 'input');
    const path = pts.map((p) => `${(+p.lon).toFixed(6)},${(+p.lat).toFixed(6)}`).join(';');
    const url = `${API.osrm}${path}?overview=full&geometries=geojson&steps=false`;
    let data;
    try { data = await getJson(url, { timeoutMs: 25000 }); }
    catch (e) { throw new ApiError(`Routing failed: ${e.message}`, e.kind); }
    if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
      throw new ApiError(data.code === 'NoRoute' ? 'No driving route found between these places.' : `Routing failed (${data.code || 'unknown'}${data.message ? ': ' + data.message : ''})`, 'route');
    }
    // OSRM snaps every waypoint to the nearest road; a far snap means there is no real road route (e.g. across an ocean).
    const wps = data.waypoints || [];
    wps.forEach((w, i) => {
      const d = w.distance || 0;
      if (d > SNAP_MAX_M) {
        const which = i === 0 ? 'start' : i === wps.length - 1 ? 'destination' : `via ${i}${pts[i] && pts[i].name ? ` (${pts[i].name})` : ''}`;
        throw new ApiError(`No driving route: ${which} is ${Math.round(d / 1000)} km from the nearest routable road.`, 'route');
      }
    });
    const r = data.routes[0];
    const coords = r.geometry.coordinates;
    const legs = (r.legs && r.legs.length === pts.length - 1)
      ? r.legs.map((l) => ({ km: l.distance / 1000, durationS: l.duration }))
      : [{ km: r.distance / 1000, durationS: r.duration }];
    const out = { coords, km: r.distance / 1000, durationS: r.duration, legs, waypoints: wps };
    out.legIdx = legBoundaries(coords, cumulativeKm(coords), legs, legs.length > 1 ? wps : null);
    return out;
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
      `&hourly=temperature_2m,precipitation,precipitation_probability,cloud_cover,weather_code,is_day` +
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
      cloud: val(h.cloud_cover), code: val(h.weather_code), isDay: val(h.is_day),
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
      km: rt.km, durationS: rt.durationS, stops: rows.length,
      stayS: rows.reduce((a, r) => a + (r.kind === 'via' ? r.stayS || 0 : 0), 0), withForecast: w.length,
      tMin: temps.length ? Math.min(...temps) : null, tMax: temps.length ? Math.max(...temps) : null,
      precipMax: precs.length ? Math.max(...precs) : null, probMax: probs.length ? Math.max(...probs) : null,
    };
  }

  const TW = {
    API, MAX_VIAS, haversineKm, cumulativeKm, sampleIntervalKm, pointAtKm, legBoundaries, sampleRoute, nearestHourIndex,
    formatLocal, formatDuration, weatherInfo, geocode, route, reverseGeocode, forecastMulti,
    pickWeather, rangeReason, summarize, ApiError,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = TW;
  else root.TW = TW;
})(typeof globalThis !== 'undefined' ? globalThis : this);
