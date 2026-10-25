// Live end-to-end check of the API logic (no browser).
// Usage: node test/route-test.mjs [from] [to] [YYYY-MM-DDTHH:MM local-to-From]   default: Oslo Trondheim tomorrow 08:00
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const TW = createRequire(import.meta.url)('../lib.js');

// --- offline unit checks ---
assert.equal(TW.sampleIntervalKm(50), 15);
assert.equal(TW.sampleIntervalKm(800), 60);
assert.equal(TW.sampleIntervalKm(400), 50);
const line = [[10, 60], [10, 61]]; // ~111 km north
const s = TW.sampleRoute(line, 111.2, 3600, 0);
assert.equal(s[0].kind, 'start'); assert.equal(s.at(-1).kind, 'end');
assert.ok(Math.abs(s.at(-1).etaMs - 3600e3) < 1);
assert.ok(s.every((p, i) => i === 0 || p.km > s[i - 1].km), 'monotonic km');
assert.ok(s.slice(1, -1).every((p) => p.kind === 'sample'), 'intermediate points are samples');
assert.equal(TW.nearestHourIndex([0, 3600, 7200], 3500e3), 1);
assert.equal(TW.nearestHourIndex([0, 3600, 7200], -6000e3), -1);
assert.equal(TW.nearestHourIndex([0, 3600, 7200], 13000e3), -1);
console.log('unit checks ok');

// --- live run ---
const [fromQ = 'Oslo', toQ = 'Trondheim', whenArg] = process.argv.slice(2);
const UA = 'trip-weather-test/1.0 (https://github.com/cursor-vliet-net/trip-weather)';
const [from] = await TW.geocode(fromQ, { count: 1 });
const [to] = await TW.geocode(toQ, { count: 1 });
assert.ok(from && to, 'geocode');
console.log(`From: ${from.label} (${from.lat}, ${from.lon}) tz=${from.timezone}`);
console.log(`To:   ${to.label} (${to.lat}, ${to.lon})`);

// Departure: tomorrow 08:00 in From's timezone, computed via Intl offset.
function zonedToUtcMs(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return guess - (asLocal - guess);
}
let departMs;
if (whenArg) { const [d, t] = whenArg.split('T'); const [y, mo, da] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); departMs = zonedToUtcMs(y, mo, da, h, mi, from.timezone); }
else { const t = new Date(Date.now() + 86400e3); const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: from.timezone }).format(t).split('-').map(Number); departMs = zonedToUtcMs(...ymd, 8, 0, from.timezone); }
console.log(`Depart: ${TW.formatLocal(departMs, from.timezone, null, { day: 'numeric', month: 'short' })} (${from.timezone}) = ${new Date(departMs).toISOString()}`);

const rt = await TW.route([from, to]);
const stops = TW.sampleRoute(rt, departMs);
console.log(`Route: ${rt.km.toFixed(1)} km, ${TW.formatDuration(rt.durationS)}, ${rt.coords.length} vertices, step ${TW.sampleIntervalKm(rt.km).toFixed(1)} km, ${stops.length} stops`);
const fcs = await TW.forecastMulti(stops);
const rows = [];
for (const [i, st] of stops.entries()) {
  const fc = fcs[i];
  const wx = TW.pickWeather(fc, st.etaMs);
  const name = st.kind === 'start' ? from.label : st.kind === 'end' ? to.label : (await TW.reverseGeocode(st.lat, st.lon, { userAgent: UA })).name;
  rows.push({ ...st, name, wx, tz: fc.timezone });
  const eta = TW.formatLocal(st.etaMs, fc.timezone, fc.utc_offset_seconds, { day: 'numeric', month: 'short' });
  const w = wx ? `${TW.weatherInfo(wx.code, wx.isDay).desc.padEnd(14)} ${wx.temp.toFixed(1).padStart(5)} °C  ${wx.precip.toFixed(1)} mm (${wx.precipProb ?? '–'}%)  cloud ${String(wx.cloud).padStart(3)}%  [slot ${TW.formatLocal(wx.timeMs, fc.timezone, null, { weekday: undefined })}]`
    : TW.rangeReason(fc, st.etaMs);
  console.log(`${String(Math.round(st.km)).padStart(4)} km  ${eta.padEnd(16)} ${name.padEnd(34)} ${w}`);
}
const sum = TW.summarize(rows, rt);
console.log('Summary:', JSON.stringify({ km: +sum.km.toFixed(1), duration: TW.formatDuration(sum.durationS), tMin: sum.tMin, tMax: sum.tMax, precipMax: sum.precipMax, probMax: sum.probMax, withForecast: `${sum.withForecast}/${sum.stops}` }));
assert.ok(rows.every((r) => r.wx), 'all rows have weather for tomorrow');

// out-of-range checks
const far = TW.pickWeather(fcs[0], Date.now() + 20 * 86400e3); assert.equal(far, null);
console.log('beyond horizon ->', TW.rangeReason(fcs[0], Date.now() + 20 * 86400e3));
console.log('past ->', TW.rangeReason(fcs[0], Date.now() - 3 * 86400e3));
