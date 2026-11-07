// Prints the link to this machine as a QR code, to scan from the tmuxlab app (Add machine › Scan QR code).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import qrcode from 'qrcode-generator';
import { CONF } from '../lib/util.js';

const token = process.env.TMUXLAB_TOKEN || fs.readFileSync(path.join(CONF, 'token'), 'utf8').trim();
const port = process.env.PORT || 7681;
const ips = Object.entries(os.networkInterfaces()).filter(([n]) => !/^(docker|br-|veth|virbr|lo)/.test(n))
  .flatMap(([, a]) => a).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
// Tailscale (100.64/10) works away from home too, so prefer it
const ip = process.argv[2] || ips.find((a) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) || ips[0] || 'localhost';
const url = `http://${ip}:${port}/#token=${token}`;
const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
console.log(qr.createASCII(1, 2));
console.log(url);
if (ips.length > 1) console.log(`Other addresses: ${ips.filter((a) => a !== ip).join(', ')} (npm run pair -- <address>)`);
