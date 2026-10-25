// Checks fallbacks and error paths against live APIs.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const TW = createRequire(import.meta.url)('../lib.js');
TW.API.nominatim = 'https://nominatim.invalid/reverse';
let r = await TW.reverseGeocode(61.5, 10.5);
console.log('nominatim down ->', r); assert.equal(r.source, 'bigdatacloud');
TW.API.bdc = 'https://bdc.invalid/x';
r = await TW.reverseGeocode(62.123, 9.456);
console.log('both down ->', r); assert.equal(r.source, 'coords');
console.log('geocode nonsense ->', await TW.geocode('qwxzzkjhv'));
await assert.rejects(TW.route({ lat: 59.9, lon: 10.7 }, { lat: 40.7, lon: -74.0 }), (e) => (console.log('Oslo->NYC ->', e.message), true));
TW.API.forecast = 'https://api.open-meteo.invalid/v1/forecast';
await assert.rejects(TW.forecastMulti([{ lat: 1, lon: 1 }]), (e) => (console.log('forecast down ->', e.kind, e.message), e.kind === 'network'));
console.log('fallback checks ok');
