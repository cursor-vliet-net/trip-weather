/* Trip Weather — UI. All API-derived text goes through textContent / DOM nodes, never innerHTML. */
(function () {
  'use strict';
  const TW = window.TW;
  const $ = (id) => document.getElementById(id);
  const LANG = (navigator.language || 'en').split('-')[0];
  const LEAFLET = {
    js: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    jsSri: 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=',
    css: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    cssSri: 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=',
  };

  /** Create element with props and children (strings become text nodes). */
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }

  // ---------- state ----------
  const sel = { from: null, to: null }; // {name,label,lat,lon}
  let runId = 0;

  // ---------- status ----------
  function status(msg, kind) {
    const s = $('status');
    if (!msg) { s.hidden = true; s.textContent = ''; return; }
    s.hidden = false; s.className = 'status' + (kind ? ' ' + kind : ''); s.textContent = msg;
  }

  // ---------- online indicator ----------
  function updateNet() { $('net').hidden = navigator.onLine; }
  addEventListener('online', updateNet); addEventListener('offline', updateNet); updateNet();

  // ---------- departure default ----------
  function toLocalInput(d) {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function nextHour() { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; }
  $('depart').value = toLocalInput(nextHour());

  // ---------- autocomplete ----------
  function setupAutocomplete(key) {
    const input = $(key), list = $(key + '-list');
    let items = [], active = -1, timer = null, ctl = null, seq = 0;

    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    const choose = (i) => {
      const it = items[i]; if (!it) return;
      sel[key] = it; input.value = it.label; close(); savePrefs();
    };
    const highlight = () => {
      [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
      if (active >= 0) list.children[active].scrollIntoView({ block: 'nearest' });
    };
    const render = () => {
      list.replaceChildren(...items.map((it, i) => {
        const li = el('li', { role: 'option', id: `${key}-opt-${i}`, 'aria-selected': 'false' },
          it.name, el('small', { text: it.label }));
        li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
        return li;
      }));
      list.hidden = !items.length; input.setAttribute('aria-expanded', String(!!items.length));
    };

    input.addEventListener('input', () => {
      sel[key] = null;
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { items = []; render(); return; }
      timer = setTimeout(async () => {
        if (ctl) ctl.abort();
        ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const my = ++seq;
        try {
          const res = await TW.geocode(q, { language: LANG, signal: ctl && ctl.signal });
          if (my !== seq) return;
          items = res; active = -1; render();
        } catch (_) { if (my === seq) { items = []; render(); } }
      }, 250);
    });
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; highlight(); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
  }
  setupAutocomplete('from');
  setupAutocomplete('to');

  // ---------- prefs ----------
  function savePrefs() {
    try { localStorage.setItem('tw:last', JSON.stringify({ from: sel.from, to: sel.to })); } catch (_) {}
  }
  try {
    const last = JSON.parse(localStorage.getItem('tw:last') || 'null');
    if (last) for (const k of ['from', 'to']) {
      const v = last[k];
      if (v && typeof v.lat === 'number' && typeof v.lon === 'number' && typeof v.label === 'string') { sel[k] = v; $(k).value = v.label; }
    }
  } catch (_) {}

  // ---------- swap / locate ----------
  $('swap').addEventListener('click', () => {
    [sel.from, sel.to] = [sel.to, sel.from];
    [$('from').value, $('to').value] = [$('to').value, $('from').value];
    savePrefs();
  });

  $('locate').addEventListener('click', () => {
    if (!('geolocation' in navigator)) { status('Geolocation is not supported by this browser.', 'error'); return; }
    const btn = $('locate'); btn.disabled = true; status('Getting your location…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      sel.from = { name: 'My location', label: 'My location', lat, lon };
      $('from').value = 'My location';
      status('');
      try {
        const r = await TW.reverseGeocode(lat, lon, { language: LANG });
        if (r.source !== 'coords') { sel.from = { name: r.name, label: `📍 ${r.name}`, lat, lon }; $('from').value = sel.from.label; }
      } catch (_) {}
      btn.disabled = false; savePrefs();
    }, (err) => {
      btn.disabled = false;
      status(err.code === 1 ? 'Location permission denied.' : 'Could not determine your location.', 'error');
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  });

  // ---------- resolve input → place ----------
  async function resolve(key) {
    if (sel[key]) return sel[key];
    const q = $(key).value.trim();
    if (!q) throw new TW.ApiError(`Please enter a “${key === 'from' ? 'From' : 'To'}” place.`, 'input');
    const res = await TW.geocode(q, { language: LANG, count: 1 });
    if (!res.length) throw new TW.ApiError(`Place not found: “${q}”.`, 'input');
    sel[key] = res[0]; $(key).value = res[0].label; savePrefs();
    return res[0];
  }

  // ---------- rendering ----------
  const fmt1 = (v) => (v == null ? '–' : (Math.round(v * 10) / 10).toFixed(1));
  const fmt0 = (v) => (v == null ? '–' : String(Math.round(v)));

  function renderSummary(sum, from, to, departMs) {
    const box = $('summary');
    const kv = (k, v) => el('div', null, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }));
    box.replaceChildren(
      kv('Distance', `${Math.round(sum.km)} km`),
      kv('Duration', TW.formatDuration(sum.durationS)),
      kv('Temp range', sum.tMin == null ? '–' : `${fmt0(sum.tMin)} … ${fmt0(sum.tMax)} °C`),
      kv('Max precip', sum.precipMax == null ? '–' : `${fmt1(sum.precipMax)} mm/h${sum.probMax != null ? ` · ${fmt0(sum.probMax)}%` : ''}`),
      el('div', { class: 'full', text:
        `${from.label} → ${to.label} · departs ${TW.formatLocal(departMs, undefined, undefined, { day: 'numeric', month: 'short' })} · ` +
        `${sum.stops} stops, ${sum.withForecast} with forecast · driving (OSRM, no traffic)` }),
    );
    box.hidden = false;
  }

  function stopNode(row) {
    const nameEl = el('span', { class: 'name', text: row.name });
    const eta = TW.formatLocal(row.etaMs, row.tz, row.offsetS, { day: 'numeric', month: 'short' });
    const head = el('div', { class: 'head' }, nameEl, el('span', { class: 'meta', text: `${Math.round(row.km)} km · ${eta}` }));
    let wxEl;
    if (row.wx) {
      const [emo, desc] = TW.weatherInfo(row.wx.code);
      wxEl = [
        el('div', { class: 'wx' },
          el('span', { class: 't', text: `${fmt1(row.wx.temp)} °C` }),
          el('span', { class: 'p', text: `💧 ${fmt1(row.wx.precip)} mm${row.wx.precipProb != null ? ` (${fmt0(row.wx.precipProb)}%)` : ''}` }),
          el('span', { text: `☁ ${fmt0(row.wx.cloud)}%` })),
        el('div', { class: 'desc', text: `${desc} · forecast for ${TW.formatLocal(row.wx.timeMs, row.tz, row.offsetS, { weekday: undefined })}` }),
      ];
      row.emoji = emo;
    } else {
      wxEl = el('div', { class: 'na', text: row.reason });
      row.emoji = '—';
    }
    const li = el('li', { class: `stop ${row.kind}` },
      el('div', { class: 'dot', 'aria-hidden': 'true', text: row.kind === 'start' ? '🟢' : row.kind === 'end' ? '🏁' : row.emoji }),
      el('div', { class: 'body' }, head, wxEl));
    row.nameEl = nameEl;
    return li;
  }

  // ---------- map (optional) ----------
  let leafletPromise = null, map = null, mapLayer = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
      const css = el('link', { rel: 'stylesheet', href: LEAFLET.css, integrity: LEAFLET.cssSri, crossorigin: '' });
      document.head.append(css);
      const s = el('script', { src: LEAFLET.js, integrity: LEAFLET.jsSri, crossorigin: '' });
      s.onload = () => (window.L ? resolve(window.L) : reject(new Error('Leaflet missing')));
      s.onerror = () => reject(new Error('Leaflet failed to load'));
      document.head.append(s);
      setTimeout(() => reject(new Error('Leaflet timeout')), 10000);
    });
    leafletPromise.catch(() => { leafletPromise = null; });
    return leafletPromise;
  }
  async function renderMap(rt, rows) {
    const box = $('map');
    try {
      const L = await loadLeaflet();
      box.hidden = false;
      if (!map) {
        map = L.map(box, { scrollWheelZoom: false });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18, attribution: '© OpenStreetMap contributors',
        }).addTo(map);
      }
      if (mapLayer) mapLayer.remove();
      mapLayer = L.layerGroup().addTo(map);
      const line = L.polyline(rt.coords.map(([lon, lat]) => [lat, lon]), { weight: 4 }).addTo(mapLayer);
      for (const r of rows) {
        const m = L.circleMarker([r.lat, r.lon], { radius: r.kind === 'via' ? 6 : 8, weight: 2, fillOpacity: 0.9 }).addTo(mapLayer);
        // Tooltip content as DOM node (text only) — no HTML injection.
        r.tip = el('span', { text: r.name });
        m.bindTooltip(r.tip);
        m.on('click', () => r.nameEl && r.nameEl.closest('li').scrollIntoView({ behavior: 'smooth', block: 'center' }));
      }
      map.invalidateSize();
      map.fitBounds(line.getBounds(), { padding: [20, 20] });
    } catch (_) {
      box.hidden = true; // map is optional
    }
  }

  // ---------- main ----------
  $('trip').addEventListener('submit', async (e) => {
    e.preventDefault();
    const my = ++runId;
    const go = $('go'); go.disabled = true;
    $('summary').hidden = true; $('stops').hidden = true; $('stops').replaceChildren();
    try {
      const dv = $('depart').value;
      const departMs = dv ? new Date(dv).getTime() : NaN;
      if (!Number.isFinite(departMs)) throw new TW.ApiError('Please enter a valid departure date/time.', 'input');

      status('Finding places…');
      const [from, to] = await Promise.all([resolve('from'), resolve('to')]);
      if (my !== runId) return;
      if (TW.haversineKm([from.lon, from.lat], [to.lon, to.lat]) < 0.5) throw new TW.ApiError('From and To are the same place.', 'input');

      status('Routing…');
      const rt = await TW.route(from, to);
      if (my !== runId) return;

      const stops = TW.sampleRoute(rt.coords, rt.km, rt.durationS, departMs);
      status('Fetching weather…');
      const fcs = await TW.forecastMulti(stops);
      if (my !== runId) return;

      const rows = stops.map((s, i) => {
        const fc = fcs[i];
        const wx = TW.pickWeather(fc, s.etaMs);
        return Object.assign({}, s, {
          name: s.kind === 'start' ? from.label : s.kind === 'end' ? to.label : '…',
          tz: fc.timezone, offsetS: fc.utc_offset_seconds,
          wx, reason: wx ? null : TW.rangeReason(fc, s.etaMs),
        });
      });

      renderSummary(TW.summarize(rows, rt), from, to, departMs);
      const ol = $('stops');
      ol.replaceChildren(...rows.map(stopNode));
      ol.hidden = false;
      renderMap(rt, rows);

      const missing = rows.filter((r) => !r.wx).length;
      const vias = rows.filter((r) => r.kind === 'via');
      status(vias.length ? `Looking up place names (0/${vias.length})…` : '');
      let done = 0;
      for (const r of vias) {
        if (my !== runId) return;
        const g = await TW.reverseGeocode(r.lat, r.lon, { language: LANG });
        r.name = g.name; r.nameEl.textContent = g.name; if (r.tip) r.tip.textContent = g.name;
        status(`Looking up place names (${++done}/${vias.length})…`);
      }
      if (my !== runId) return;
      status(missing ? `${missing} of ${rows.length} stops are outside the forecast window (now … +16 days).` : '', missing ? 'warn' : '');
    } catch (err) {
      if (my !== runId) return;
      const offline = !navigator.onLine || (err && err.kind === 'network');
      status(offline ? `${err.message}. You appear to be offline — the app works, but route & weather need a connection.` : (err && err.message) || 'Something went wrong.', 'error');
    } finally {
      if (my === runId) go.disabled = false;
    }
  });

  // ---------- service worker ----------
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
