// Copies xterm and the fonts into public/vendor so the same folder works when served and when bundled into the APK.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('public/vendor', { recursive: true });
for (const [src, dst] of [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'], ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'], ['@xterm/addon-web-links/lib/addon-web-links.js', 'addon-web-links.js'],
  ['qrcode-generator/dist/qrcode.mjs', 'qrcode.js'],
]) cpSync(`node_modules/${src}`, `public/vendor/${dst}`);
let css = '';
for (const [pkg, fam, weights] of [['ibm-plex-sans', 'IBM Plex Sans', [400, 500, 600]], ['jetbrains-mono', 'JetBrains Mono', [400, 600]]]) {
  for (const w of weights) {
    const f = `${pkg}-latin-${w}-normal.woff2`;
    cpSync(`node_modules/@fontsource/${pkg}/files/${f}`, `public/vendor/${f}`);
    css += `@font-face{font-family:'${fam}';font-weight:${w};font-style:normal;font-display:swap;src:url(${f}) format('woff2')}\n`;
  }
}
writeFileSync('public/vendor/fonts.css', css);
