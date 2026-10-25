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
  // A "slot" is one place input: {key, input, list, sel:{name,label,lat,lon}|null}. Vias add stayMin + row.
  const slots = { from: { key: 'from', input: $('from'), list: $('from-list'), sel: null },
                  to: { key: 'to', input: $('to'), list: $('to-list'), sel: null } };
  const vias = []; // ordered = travel order
  let runId = 0, viaSeq = 0;

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
  function setupAutocomplete(slot) {
    const { input, list } = slot;
    const key = list.id;
    let items = [], active = -1, timer = null, ctl = null, seq = 0;

    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    const choose = (i) => {
      const it = items[i]; if (!it) return;
      slot.sel = it; input.value = it.label; close(); savePrefs();
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
      slot.sel = null;
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { items = []; render(); savePrefs(); return; }
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
  setupAutocomplete(slots.from);
  setupAutocomplete(slots.to);

  // ---------- via rows ----------
  const validPlace = (v) => v && typeof v.lat === 'number' && typeof v.lon === 'number' && Number.isFinite(v.lat) &&
    Number.isFinite(v.lon) && typeof v.label === 'string';

  function renumberVias() {
    vias.forEach((v, i) => {
      v.labelEl.textContent = `Stop ${i + 1}`;
      v.up.disabled = i === 0; v.down.disabled = i === vias.length - 1;
      v.input.setAttribute('aria-label', `Stop ${i + 1} place`);
    });
    const full = vias.length >= TW.MAX_VIAS;
    $('add-via').disabled = full;
    $('add-via').textContent = full ? `Max ${TW.MAX_VIAS} stops` : '＋ Add stop';
  }

  /** Add a via row. init: {sel?, text?, stayMin?}. Returns the via slot. */
  function addVia(init, focus) {
    if (vias.length >= TW.MAX_VIAS) return null;
    const id = `via${++viaSeq}`;
    const input = el('input', { id, type: 'text', placeholder: 'e.g. Lillehammer', role: 'combobox',
      'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-list` });
    const list = el('ul', { id: `${id}-list`, class: 'suggest', role: 'listbox', hidden: '' });
    const stay = el('input', { type: 'number', min: '0', max: '1440', step: '5', inputmode: 'numeric', class: 'stay',
      id: `${id}-stay`, 'aria-label': 'Stay at this stop, minutes' });
    const labelEl = el('label', { for: id });
    const btn = (txt, title) => el('button', { type: 'button', class: 'icon-btn sm', title, 'aria-label': title, text: txt });
    const up = btn('↑', 'Move stop up'), down = btn('↓', 'Move stop down'), rm = btn('✕', 'Remove stop');
    const row = el('li', { class: 'field via' },
      labelEl,
      el('div', { class: 'row' }, el('div', { class: 'ac' }, input, list), rm),
      el('div', { class: 'via-opts' },
        el('label', { class: 'inline', for: `${id}-stay` }, 'Stay'), stay, el('span', { class: 'unit', text: 'min' }),
        el('span', { class: 'spacer' }), up, down));
    const v = { key: id, input, list, stay, row, labelEl, up, down, sel: null };
    if (init && validPlace(init.sel)) { v.sel = init.sel; input.value = init.sel.label; }
    else if (init && typeof init.text === 'string') input.value = init.text;
    stay.value = String(init && Number.isFinite(+init.stayMin) && +init.stayMin > 0 ? Math.round(+init.stayMin) : 0);
    setupAutocomplete(v);
    stay.addEventListener('change', savePrefs);
    rm.addEventListener('click', () => {
      const i = vias.indexOf(v); if (i < 0) return;
      vias.splice(i, 1); row.remove(); renumberVias(); savePrefs();
      (vias[i] || vias[i - 1] || { input: $('add-via') }).input.focus?.();
    });
    const move = (d) => {
      const i = vias.indexOf(v), j = i + d;
      if (j < 0 || j >= vias.length) return;
      [vias[i], vias[j]] = [vias[j], vias[i]];
      $('vias').replaceChildren(...vias.map((x) => x.row));
      renumberVias(); savePrefs();
      (d < 0 ? (up.disabled ? down : up) : (down.disabled ? up : down)).focus();
    };
    up.addEventListener('click', () => move(-1));
    down.addEventListener('click', () => move(1));
    vias.push(v); $('vias').append(row); renumberVias();
    if (focus) input.focus();
    return v;
  }
  function clearVias() { vias.splice(0).forEach((v) => v.row.remove()); renumberVias(); }
  const stayMinOf = (v) => { const n = Math.round(+v.stay.value); return Number.isFinite(n) && n > 0 ? Math.min(n, 1440) : 0; };

  $('add-via').addEventListener('click', () => { addVia(null, true); savePrefs(); });

  // ---------- prefs (localStorage) + share link (URL hash) ----------
  const placeOut = (p) => (p ? { name: p.name, label: p.label, lat: p.lat, lon: p.lon } : null);
  function savePrefs() {
    // The form is the source of truth once edited; drop a stale share hash so a reload doesn't revert edits.
    if (location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {} }
    try {
      localStorage.setItem('tw:last', JSON.stringify({
        v: 2, from: placeOut(slots.from.sel), to: placeOut(slots.to.sel),
        vias: vias.map((v) => ({ sel: placeOut(v.sel), text: v.input.value, stayMin: stayMinOf(v) })),
      }));
    } catch (_) {}
  }
  function applyState(st) {
    for (const k of ['from', 'to']) {
      const v = st[k];
      if (validPlace(v)) { slots[k].sel = v; slots[k].input.value = v.label; }
    }
    clearVias();
    for (const v of (Array.isArray(st.vias) ? st.vias : []).slice(0, TW.MAX_VIAS)) addVia(v);
    if (st.depart) $('depart').value = st.depart;
  }

  // Hash format (all optional): #from=lat,lon,label&via=lat,lon,stayMin,label&via=…&to=lat,lon,label&t=YYYY-MM-DDTHH:MM
  const num = (x) => (Math.round(x * 1e5) / 1e5).toString();
  function parsePlace(str, withStay) {
    const parts = String(str).split(',');
    const n = withStay ? 3 : 2;
    if (parts.length <= n) return null;
    const lat = +parts[0], lon = +parts[1];
    const label = parts.slice(n).join(',').trim();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !label) return null;
    return { sel: { name: label.split(',')[0], label, lat, lon }, stayMin: withStay ? +parts[2] || 0 : 0 };
  }
  function readHash() {
    if (!location.hash || location.hash.length < 2) return null;
    const q = new URLSearchParams(location.hash.slice(1));
    const from = q.get('from') && parsePlace(q.get('from'));
    const to = q.get('to') && parsePlace(q.get('to'));
    if (!from && !to) return null;
    const t = q.get('t');
    return {
      from: from && from.sel, to: to && to.sel,
      vias: q.getAll('via').map((x) => parsePlace(x, true)).filter(Boolean),
      depart: t && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? t : null,
    };
  }
  function shareUrl(from, viaList, to) {
    const q = new URLSearchParams();
    q.append('from', `${num(from.lat)},${num(from.lon)},${from.label}`);
    for (const v of viaList) q.append('via', `${num(v.place.lat)},${num(v.place.lon)},${v.stayMin},${v.place.label}`);
    q.append('to', `${num(to.lat)},${num(to.lon)},${to.label}`);
    q.append('t', $('depart').value);
    return `${location.origin}${location.pathname}#${q.toString()}`;
  }

  try {
    const fromHash = readHash();
    const last = fromHash || JSON.parse(localStorage.getItem('tw:last') || 'null');
    if (last) applyState(last);
    if (fromHash) savePrefs();
  } catch (_) {}
  renumberVias();

  // ---------- swap / locate ----------
  $('swap').addEventListener('click', () => {
    // Reverse the whole trip: swap From/To and reverse the stop order.
    const f = slots.from, t = slots.to;
    [f.sel, t.sel] = [t.sel, f.sel];
    [f.input.value, t.input.value] = [t.input.value, f.input.value];
    vias.reverse(); $('vias').replaceChildren(...vias.map((x) => x.row)); renumberVias();
    savePrefs();
  });

  $('locate').addEventListener('click', () => {
    if (!('geolocation' in navigator)) { status('Geolocation is not supported by this browser.', 'error'); return; }
    const btn = $('locate'); btn.disabled = true; status('Getting your location…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      slots.from.sel = { name: 'My location', label: 'My location', lat, lon };
      $('from').value = 'My location';
      status('');
      try {
        const r = await TW.reverseGeocode(lat, lon, { language: LANG });
        if (r.source !== 'coords') { slots.from.sel = { name: r.name, label: `📍 ${r.name}`, lat, lon }; $('from').value = slots.from.sel.label; }
      } catch (_) {}
      btn.disabled = false; savePrefs();
    }, (err) => {
      btn.disabled = false;
      status(err.code === 1 ? 'Location permission denied.' : 'Could not determine your location.', 'error');
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  });

  // ---------- resolve input → place ----------
  async function resolve(slot, what) {
    if (slot.sel) return slot.sel;
    const q = slot.input.value.trim();
    if (!q) throw new TW.ApiError(`Please enter a “${what}” place.`, 'input');
    const res = await TW.geocode(q, { language: LANG, count: 1 });
    if (!res.length) throw new TW.ApiError(`Place not found (${what}): “${q}”.`, 'input');
    slot.sel = res[0]; slot.input.value = res[0].label; savePrefs();
    return res[0];
  }

  // ---------- rendering ----------
  const fmt1 = (v) => (v == null ? '–' : (Math.round(v * 10) / 10).toFixed(1));
  const fmt0 = (v) => (v == null ? '–' : String(Math.round(v)));

  function renderSummary(sum, from, to, departMs, viaPlaces, link) {
    const box = $('summary');
    const kv = (k, v) => el('div', null, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }));
    box.replaceChildren(
      kv('Distance', `${Math.round(sum.km)} km`),
      kv('Duration', TW.formatDuration(sum.durationS) + (sum.stayS ? ` + ${TW.formatDuration(sum.stayS)} stops` : '')),
      kv('Temp range', sum.tMin == null ? '–' : `${fmt0(sum.tMin)} … ${fmt0(sum.tMax)} °C`),
      kv('Max precip', sum.precipMax == null ? '–' : `${fmt1(sum.precipMax)} mm/h${sum.probMax != null ? ` · ${fmt0(sum.probMax)}%` : ''}`),
      el('div', { class: 'full', text:
        [from, ...viaPlaces, to].map((p) => p.label).join(' → ') + ` · departs ${TW.formatLocal(departMs, undefined, undefined, { day: 'numeric', month: 'short' })} · ` +
        `${sum.stops} points, ${sum.withForecast} with forecast · driving (OSRM, no traffic)` }),
      link ? el('div', { class: 'full' }, shareBtn(link)) : null,
    );
    box.hidden = false;
  }
  function shareBtn(link) {
    const b = el('button', { type: 'button', class: 'small-btn', text: '🔗 Share trip link' });
    b.addEventListener('click', async () => {
      try {
        if (navigator.share) { await navigator.share({ title: 'Trip Weather', url: link }); return; }
        await navigator.clipboard.writeText(link); b.textContent = '✓ Link copied';
      } catch (e) { if (!e || e.name !== 'AbortError') { b.textContent = 'Copy failed – see address bar'; } }
    });
    return b;
  }

  function stopNode(row) {
    const nameEl = el('span', { class: 'name', text: row.name });
    const fmtT = (ms, o) => TW.formatLocal(ms, row.tz, row.offsetS, o);
    const eta = fmtT(row.etaMs, { day: 'numeric', month: 'short' });
    const meta = el('div', { class: 'meta' },
      el('span', { text: `${Math.round(row.km)} km` }),
      el('span', { text: row.kind === 'via' ? `arrive ${eta}` : eta }));
    if (row.kind === 'via' && row.stayS > 0) meta.append(el('span', { text: `stay ${TW.formatDuration(row.stayS)} → leave ${fmtT(row.departMs, { weekday: undefined })}` }));
    const badge = row.kind === 'via' ? el('span', { class: 'badge', text: `via ${row.viaIndex + 1}` })
      : row.kind === 'start' ? el('span', { class: 'badge start', text: 'start' })
      : row.kind === 'end' ? el('span', { class: 'badge end', text: 'destination' }) : null;
    const head = el('div', { class: 'head' }, el('div', { class: 'title' }, badge, nameEl), meta);
    let wxEl;
    if (row.wx) {
      const [emo, desc] = TW.weatherInfo(row.wx.code);
      wxEl = [
        el('div', { class: 'wx' },
          el('span', { class: 't', text: `${fmt1(row.wx.temp)} °C` }),
          el('span', { class: 'p', text: `💧 ${fmt1(row.wx.precip)} mm${row.wx.precipProb != null ? ` (${fmt0(row.wx.precipProb)}%)` : ''}` }),
          el('span', { text: `☁ ${fmt0(row.wx.cloud)}%` })),
        el('div', { class: 'desc', text: `${desc} · forecast for ${fmtT(row.wx.timeMs, { weekday: undefined })}` }),
      ];
      row.emoji = emo;
    } else {
      wxEl = el('div', { class: 'na', text: row.reason });
      row.emoji = '—';
    }
    const dot = row.kind === 'start' ? '🟢' : row.kind === 'end' ? '🏁' : row.kind === 'via' ? '📍' : row.emoji;
    const li = el('li', { class: `stop ${row.kind}` },
      el('div', { class: 'dot', 'aria-hidden': 'true', text: dot }),
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
      const STYLE = {
        start: { radius: 9, color: '#065f46', fillColor: '#22c55e' },
        end: { radius: 9, color: '#7f1d1d', fillColor: '#ef4444' },
        via: { radius: 10, color: '#7c2d12', fillColor: '#f97316', weight: 3 },
        sample: { radius: 5, color: '#1e3a8a', fillColor: '#3b82f6' },
      };
      // Samples first so start/via/end markers are drawn on top.
      const order = [...rows].sort((a, b) => (a.kind === 'sample' ? 0 : 1) - (b.kind === 'sample' ? 0 : 1));
      for (const r of order) {
        const m = L.circleMarker([r.lat, r.lon], Object.assign({ weight: 2, fillOpacity: 0.95 }, STYLE[r.kind] || STYLE.sample)).addTo(mapLayer);
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
      const viaList = vias.filter((v) => v.sel || v.input.value.trim()); // empty via rows are ignored
      const [from, to, ...viaPlaces] = await Promise.all([
        resolve(slots.from, 'From'), resolve(slots.to, 'To'),
        ...viaList.map((v) => resolve(v, `Stop ${vias.indexOf(v) + 1}`))]);
      if (my !== runId) return;
      const points = [from, ...viaPlaces, to];
      for (let i = 1; i < points.length; i++) {
        if (TW.haversineKm([points[i - 1].lon, points[i - 1].lat], [points[i].lon, points[i].lat]) < 0.5) {
          throw new TW.ApiError(`“${points[i - 1].label}” and “${points[i].label}” are the same place.`, 'input');
        }
      }
      const stayS = viaList.map((v) => stayMinOf(v) * 60);

      status('Routing…');
      const rt = await TW.route(points);
      if (my !== runId) return;

      const stops = TW.sampleRoute(rt, departMs, { stayS });
      status('Fetching weather…');
      const fcs = await TW.forecastMulti(stops);
      if (my !== runId) return;

      const rows = stops.map((s, i) => {
        const fc = fcs[i];
        const wx = TW.pickWeather(fc, s.etaMs); // via: weather at arrival
        return Object.assign({}, s, {
          name: s.kind === 'start' ? from.label : s.kind === 'end' ? to.label : s.kind === 'via' ? viaPlaces[s.viaIndex].label : '…',
          tz: fc.timezone, offsetS: fc.utc_offset_seconds,
          wx, reason: wx ? null : TW.rangeReason(fc, s.etaMs),
        });
      });

      const link = shareUrl(from, viaList.map((v, i) => ({ place: viaPlaces[i], stayMin: stayMinOf(v) })), to);
      try { history.replaceState(null, '', link); } catch (_) {}
      renderSummary(TW.summarize(rows, rt), from, to, departMs, viaPlaces, link);
      const ol = $('stops');
      ol.replaceChildren(...rows.map(stopNode));
      ol.hidden = false;
      renderMap(rt, rows);

      const missing = rows.filter((r) => !r.wx).length;
      const samples = rows.filter((r) => r.kind === 'sample');
      status(samples.length ? `Looking up place names (0/${samples.length})…` : '');
      let done = 0;
      for (const r of samples) {
        if (my !== runId) return;
        const g = await TW.reverseGeocode(r.lat, r.lon, { language: LANG });
        r.name = g.name; r.nameEl.textContent = g.name; if (r.tip) r.tip.textContent = g.name;
        status(`Looking up place names (${++done}/${samples.length})…`);
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

  // ---------- service worker + update prompt ----------
  // sw.js calls skipWaiting()/clients.claim(), so a new version takes control right away; the running page
  // still has the old JS, so we offer a reload (automatic if no results are on screen).
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    let hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; } // first install claimed this page: nothing to refresh
      if (reloading) return;
      if ($('stops').hidden && !document.activeElement?.matches?.('input')) { reloading = true; location.reload(); return; }
      $('update').hidden = false;
    });
    $('reload').addEventListener('click', () => { reloading = true; location.reload(); });
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').then((reg) => {
      // Re-check for updates when the (installed) app comes back to the foreground.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {}));
  }
})();
