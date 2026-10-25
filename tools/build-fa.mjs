// Build css/fa.css (only the Font Awesome Free solid icons this app uses) + copy fonts/fa-solid-900.woff2.
// Usage: npm pack @fortawesome/fontawesome-free@6.5.2 && tar xzf fortawesome-fontawesome-free-6.5.2.tgz
//        node tools/build-fa.mjs ./package
// The woff2 is copied unmodified (no glyph subsetting) — FA Free fonts are SIL OFL 1.1.
import fs from 'node:fs';
import path from 'node:path';

export const ICONS = [
  // UI
  'car-side', 'location-crosshairs', 'spinner', 'triangle-exclamation', 'check', 'arrows-up-down', 'plus', 'xmark',
  'arrow-up', 'arrow-down', 'share-nodes', 'plug-circle-xmark', 'download', 'arrow-up-from-bracket', 'square-plus',
  'ellipsis-vertical', 'rotate-right',
  // cards / summary
  'circle-play', 'location-dot', 'flag-checkered', 'route', 'clock', 'hourglass-half', 'droplet', 'cloud',
  'temperature-empty', 'temperature-quarter', 'temperature-half', 'temperature-three-quarters', 'temperature-full',
  // weather (WMO weather_code)
  'sun', 'moon', 'cloud-sun', 'cloud-moon', 'smog', 'cloud-sun-rain', 'cloud-moon-rain', 'cloud-rain',
  'cloud-showers-heavy', 'icicles', 'snowflake', 'cloud-bolt', 'circle-question',
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const pkg = process.argv[2];
  if (!pkg) { console.error('usage: node tools/build-fa.mjs <fontawesome-free package dir>'); process.exit(2); }
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const all = fs.readFileSync(path.join(pkg, 'css/all.css'), 'utf8');
  const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
  const rules = [];
  for (const name of ICONS) {
    // Selectors may be grouped with aliases: ".fa-xmark::before,\n.fa-close::before { content: "\f00d"; }"
    const re = new RegExp(`\\.fa-${name}::before[^{]*\\{\\s*content:\\s*"(\\\\[0-9a-f]+)"`);
    const m = all.match(re);
    if (!m) { console.error(`icon not found: ${name}`); process.exit(1); }
    rules.push(`.fa-${name}::before { content: "${m[1]}"; }`);
  }
  const css = `/*!
 * Font Awesome Free ${version} by @fontawesome - https://fontawesome.com
 * License - https://fontawesome.com/license/free (Icons: CC BY 4.0, Fonts: SIL OFL 1.1, Code: MIT License)
 * Copyright 2024 Fonticons, Inc.
 * Trimmed to the solid icons used by Trip Weather by tools/build-fa.mjs (generated — do not edit).
 */
@font-face {
  font-family: 'Font Awesome 6 Free'; font-style: normal; font-weight: 900; font-display: block;
  src: url("../fonts/fa-solid-900.woff2") format("woff2");
}
.fa-solid {
  font-family: 'Font Awesome 6 Free'; font-weight: 900;
  -moz-osx-font-smoothing: grayscale; -webkit-font-smoothing: antialiased;
  display: inline-block; font-style: normal; font-variant: normal; line-height: 1; text-rendering: auto;
}
.fa-fw { text-align: center; width: 1.25em; }
.fa-spin { animation: fa-spin 1s linear infinite; }
@keyframes fa-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .fa-spin { animation-duration: 3s; } }
${rules.join('\n')}
`;
  fs.writeFileSync(path.join(root, 'css/fa.css'), css);
  fs.copyFileSync(path.join(pkg, 'webfonts/fa-solid-900.woff2'), path.join(root, 'fonts/fa-solid-900.woff2'));
  console.log(`css/fa.css: ${ICONS.length} icons, ${css.length} bytes; fonts/fa-solid-900.woff2 copied (FA ${version})`);
}
