// Offline check: every Font Awesome icon referenced by the UI exists in the self-hosted css/fa.css,
// no emoji icons remain, and the font/CSS are in the service-worker precache.
// Run: node test/icons-test.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('..', import.meta.url).pathname;
const read = (f) => fs.readFileSync(root + f, 'utf8');
const css = read('css/fa.css'), app = read('app.js'), html = read('index.html'), sw = read('sw.js');
const TW = require(root + 'lib.js');
const have = new Set([...css.matchAll(/\.fa-([a-z0-9-]+)::before/g)].map((m) => m[1]));
const used = new Set();
for (const m of app.matchAll(/(?:icon|setBtn)\((?:[^,()]+,\s*)?'([a-z0-9-]+)'/g)) used.add(m[1]);
for (const m of app.matchAll(/'(temperature-[a-z-]+)'/g)) used.add(m[1]);
for (const m of html.matchAll(/fa-solid fa-([a-z0-9-]+)/g)) used.add(m[1]);
const codes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99, 12345];
for (const c of codes) for (const d of [0, 1]) used.add(TW.weatherInfo(c, d).icon);
const missing = [...used].filter((n) => !have.has(n));
let fail = 0;
const check = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
check(!missing.length, `${used.size} icons used, all present in css/fa.css (${have.size} defined)${missing.length ? ' missing: ' + missing : ''}`);
check(TW.weatherInfo(0, 0).icon === 'moon' && TW.weatherInfo(0, 1).icon === 'sun' && TW.weatherInfo(0).icon === 'sun', 'day/night variants (is_day)');
check(TW.weatherInfo(95, 1).icon === 'cloud-bolt' && TW.weatherInfo(65, 1).icon === 'cloud-showers-heavy' && TW.weatherInfo(73, 1).icon === 'snowflake' && TW.weatherInfo(45, 1).icon === 'smog', 'WMO → FA mapping');
check(TW.weatherInfo(999).icon === 'circle-question', 'unknown code → circle-question');
const emoji = /[\u2190-\u21FF\u2600-\u27BF\u2B00-\u2BFF\uFF0B\u{1F300}-\u{1FAFF}]/u;
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/→/g, '');
check(!emoji.test(strip(app)) && !emoji.test(strip(html.replace(/<!--[\s\S]*?-->/g, ''))), 'no emoji/symbol icons in app.js / index.html (→ arrows in text excepted)');
check(!/innerHTML/.test(strip(app)), 'no innerHTML in app.js');
check(/'css\/fa\.css'/.test(sw) && /'fonts\/fa-solid-900\.woff2'/.test(sw), 'sw.js precaches css/fa.css + fonts/fa-solid-900.woff2');
check(fs.statSync(root + 'fonts/fa-solid-900.woff2').size > 100000 && /url\("\.\.\/fonts\/fa-solid-900\.woff2"\)/.test(css), 'font file present and referenced');
if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('icons checks ok');
