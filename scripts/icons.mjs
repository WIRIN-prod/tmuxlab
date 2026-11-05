// Renders the app icons (PWA + Android launcher) from one SVG.
import sharp from 'sharp';
import { writeFileSync, existsSync } from 'node:fs';
const svg = (pad, round = 0) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="${round}" fill="#0E1A1C"/>
<g transform="translate(${pad} ${pad}) scale(${(512 - 2 * pad) / 512})" fill="none" stroke-linecap="round" stroke-linejoin="round">
<rect x="56" y="88" width="400" height="336" rx="40" stroke="#D8E4E1" stroke-width="26"/><path d="M56 336h400M256 88v248" stroke="#D8E4E1" stroke-width="26"/>
<path d="M112 168l52 44-52 44" stroke="#5EE6C3" stroke-width="34"/><path d="M300 380h92" stroke="#F2C14E" stroke-width="30"/></g></svg>`;
writeFileSync('public/icons/icon.svg', svg(24, 96));
for (const [n, size, pad] of [['icon-192', 192, 24], ['icon-512', 512, 24], ['icon-maskable-512', 512, 90]])
  await sharp(Buffer.from(svg(pad))).resize(size, size).png().toFile(`public/icons/${n}.png`);
// Android launcher icons, if the native project exists
const dens = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, size] of Object.entries(dens)) {
  const dir = `android/app/src/main/res/mipmap-${d}`;
  if (!existsSync(dir)) continue;
  for (const f of ['ic_launcher.png', 'ic_launcher_round.png']) await sharp(Buffer.from(svg(40, f.includes('round') ? 256 : 96))).resize(size, size).png().toFile(`${dir}/${f}`);
  await sharp(Buffer.from(svg(150))).resize(size * 2.25 | 0, size * 2.25 | 0).png().toFile(`${dir}/ic_launcher_foreground.png`);
}
// Splash screens: dark field with the mark, at each existing splash size
import { globSync } from 'node:fs';
for (const f of globSync('android/app/src/main/res/drawable*/splash.png')) {
  const { width, height } = await sharp(f).metadata();
  const s = Math.round(Math.min(width, height) * 0.28);
  const mark = await sharp(Buffer.from(svg(0))).resize(s, s).png().toBuffer();
  await sharp({ create: { width, height, channels: 3, background: '#0E1A1C' } })
    .composite([{ input: mark, gravity: 'centre' }]).png().toFile(f + '.tmp');
  (await import('node:fs')).renameSync(f + '.tmp', f);
}
