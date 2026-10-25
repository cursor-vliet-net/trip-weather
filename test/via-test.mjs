// Via waypoints: multi-leg routing, leg-based ETAs, stay durations, snap check (live APIs + offline units).
// Usage: node test/via-test.mjs [from] [via] [to]     default: Oslo Bergen Stavanger
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const TW = createRequire(import.meta.url)('../lib.js');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// --- offline units: synthetic 2-leg out-and-back route (A→B→A), legs with different speeds ---
{
  const A = [10, 60], B = [10, 61];
  const coords = [A, [10, 60.5], B, [10, 60.5], A];
  const legs = [{ km: 111.2, durationS: 3600 }, { km: 111.2, durationS: 7200 }];
  const wps = [{ location: A }, { location: B }, { location: A }];
  const cum = TW.cumulativeKm(coords);
  assert.deepEqual(TW.legBoundaries(coords, cum, legs, wps), [0, 2, 4], 'leg boundaries');
  const s = TW.sampleRoute({ coords, km: 222.4, durationS: 10800, legs, waypoints: wps }, 0, { stayS: [1800] });
  const via = s.filter((p) => p.kind === 'via');
  assert.equal(via.length, 1); assert.equal(s[0].kind, 'start'); assert.equal(s.at(-1).kind, 'end');
  near(via[0].km, 111.2, 1e-6, 'via km'); near(via[0].etaMs, 3600e3, 1, 'via arrival');
  near(via[0].departMs, 5400e3, 1, 'via departure incl. stay');
  near(s.at(-1).etaMs, (3600 + 1800 + 7200) * 1e3, 1, 'end ETA = legs + stay');
  assert.ok(s.every((p, i) => i === 0 || p.km > s[i - 1].km), 'monotonic km');
  assert.ok(s.every((p, i) => i === 0 || p.etaMs > s[i - 1].etaMs), 'monotonic ETA');
  // A sample in leg 2 at route-km k must use leg-2 speed (7200 s per 111.2 km) after the stay.
  const s2 = s.find((p) => p.kind === 'sample' && p.km > 111.2);
  near(s2.etaMs, (3600 + 1800 + ((s2.km - 111.2) / 111.2) * 7200) * 1e3, 1, 'leg-2 sample ETA');
  assert.ok(s2.lat < 61 && s2.lat > 60, 'leg-2 sample is on the way back');
  console.log('unit checks ok');
}

// --- live: direct vs via ---
const [fromQ = 'Oslo', viaQ = 'Bergen', toQ = 'Stavanger'] = process.argv.slice(2);
const [[from], [via], [to]] = await Promise.all([fromQ, viaQ, toQ].map((q) => TW.geocode(q, { count: 1 })));
assert.ok(from && via && to, 'geocode');
const departMs = Math.ceil(Date.now() / 3600e3) * 3600e3 + 86400e3; // tomorrow, on the hour
const direct = await TW.route([from, to]);
const rt = await TW.route([from, via, to]);
console.log(`Direct ${from.name} → ${to.name}: ${direct.km.toFixed(1)} km, ${TW.formatDuration(direct.durationS)}`);
console.log(`Via ${via.name}: ${rt.km.toFixed(1)} km, ${TW.formatDuration(rt.durationS)}; legs ${rt.legs.map((l) => `${l.km.toFixed(1)} km/${TW.formatDuration(l.durationS)}`).join(' + ')}; legIdx ${rt.legIdx.join(',')} of ${rt.coords.length}`);
assert.ok(rt.km > direct.km + 50, 'via route is longer than direct');
assert.equal(rt.legs.length, 2);
near(rt.legs[0].km + rt.legs[1].km, rt.km, 0.5, 'legs sum to total km');
near(rt.legs[0].durationS + rt.legs[1].durationS, rt.durationS, 2, 'legs sum to total duration');
assert.ok(TW.haversineKm(rt.coords[rt.legIdx[1]], rt.waypoints[1].location) < 0.05, 'leg boundary vertex = snapped via');

const STAY_MIN = 45;
const stops = TW.sampleRoute(rt, departMs, { stayS: [STAY_MIN * 60] });
const fcs = await TW.forecastMulti(stops);
const kinds = stops.map((s) => s.kind);
assert.equal(kinds[0], 'start'); assert.equal(kinds.at(-1), 'end');
assert.equal(kinds.filter((k) => k === 'via').length, 1, 'via appears once');
const vi = kinds.indexOf('via');
assert.ok(vi > 0 && vi < kinds.length - 1, 'via is between start and end');
const v = stops[vi];
assert.ok(TW.haversineKm([v.lon, v.lat], [via.lon, via.lat]) < 5, 'via stop at the via place');
near(v.km, rt.legs[0].km, 0.01, 'via km = leg 0 km');
near(v.etaMs, departMs + rt.legs[0].durationS * 1e3, 1, 'via ETA = arrival after leg 0');
near(stops.at(-1).etaMs, departMs + (rt.durationS + STAY_MIN * 60) * 1e3, 2e3, 'end ETA includes stay');
assert.ok(stops.every((p, i) => i === 0 || p.km > stops[i - 1].km), 'monotonic km');
assert.ok(stops.every((p, i) => i === 0 || p.etaMs > stops[i - 1].etaMs), 'monotonic ETA');
const minGap = Math.min(...stops.slice(1).map((p, i) => p.km - stops[i].km));
assert.ok(minGap >= 0.4 * TW.sampleIntervalKm(rt.km) - 1e-6, `no sample crowding a via/end (min gap ${minGap.toFixed(1)} km)`);
for (const [i, s] of stops.entries()) {
  const fc = fcs[i], wx = TW.pickWeather(fc, s.etaMs);
  assert.ok(wx, 'weather for every point');
  const label = s.kind === 'via' ? `[VIA] ${via.label}` : s.kind === 'start' ? from.label : s.kind === 'end' ? to.label : `${s.lat.toFixed(3)},${s.lon.toFixed(3)}`;
  const leave = s.kind === 'via' ? ` (stay ${STAY_MIN} min → leave ${TW.formatLocal(s.departMs, fc.timezone, null, { weekday: undefined })})` : '';
  console.log(`${String(Math.round(s.km)).padStart(4)} km  ${TW.formatLocal(s.etaMs, fc.timezone, null, { day: 'numeric', month: 'short' }).padEnd(16)} ${label.padEnd(30)} ${wx.temp.toFixed(1).padStart(5)} °C ${wx.precip.toFixed(1)} mm cloud ${String(wx.cloud).padStart(3)}%${leave}`);
}

// --- order matters: swapping via order changes the route ---
const [lille] = await TW.geocode('Lillehammer', { count: 1 });
const r2 = await TW.route([from, via, lille, to]);
assert.equal(r2.legs.length, 3); assert.equal(r2.legIdx.length, 4);
assert.ok(r2.legIdx.every((x, i) => i === 0 || x > r2.legIdx[i - 1]), 'leg boundaries increasing');
const s2 = TW.sampleRoute(r2, departMs);
assert.deepEqual(s2.filter((s) => s.kind === 'via').map((s) => s.viaIndex), [0, 1], 'vias in travel order');
console.log(`3 legs ${from.name}→${via.name}→${lille.name}→${to.name}: ${r2.km.toFixed(0)} km, ${s2.length} points`);

// --- snap check per waypoint: via in the North Sea ---
await assert.rejects(TW.route([from, { lat: 58.5, lon: 2.0, name: 'North Sea' }, to]),
  (e) => (console.log('via at sea ->', e.message), /via 1 \(North Sea\)/.test(e.message)));
console.log('via checks ok');
