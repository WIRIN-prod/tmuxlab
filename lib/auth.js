// Who is calling. The server token (printed at start, in pairing links) signs a device in once; each
// device then uses its own token, which can be revoked on its own. View-only tokens (share links) see one
// session and cannot type. Only hashes of device tokens are stored.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONF } from './util.js';

const FILE = path.join(CONF, 'devices.json');
const hash = (t) => crypto.createHash('sha256').update(t).digest('base64url');
const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
let devices = [];
try { devices = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
let dirty = false;
const save = () => { fs.mkdirSync(CONF, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(devices, null, 2), { mode: 0o600 }); dirty = false; };
setInterval(() => { if (dirty) save(); }, 60e3).unref(); // last-seen times are flushed lazily

let master = '';
export const setMaster = (t) => { master = t; };

// -> { id, role: 'full' | 'view', session?, master? } or null
export function check(token) {
  if (typeof token !== 'string' || !token) return null;
  if (same(token, master)) return { id: 'server', role: 'full', master: true };
  const h = hash(token), now = Date.now();
  const d = devices.find((x) => same(h, x.hash));
  if (!d || (d.exp && d.exp < now)) return null;
  if (now - (d.seen || 0) > 60e3) { d.seen = now; dirty = true; }
  return d;
}

export function issue({ name, role = 'full', session, hours }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const d = { id: crypto.randomBytes(6).toString('hex'), name: String(name || 'Device').slice(0, 60), role, created: Date.now(),
    ...(session ? { session } : {}), ...(hours ? { exp: Date.now() + hours * 3600e3 } : {}), hash: hash(token) };
  devices = devices.filter((x) => !x.exp || x.exp > Date.now()); // drop expired share links
  devices.push(d); save();
  return { token, id: d.id };
}

export const list = () => devices.filter((x) => !x.exp || x.exp > Date.now()).map(({ hash: _, ...d }) => d);
export function revoke(id) { const n = devices.length; devices = devices.filter((x) => x.id !== id); if (devices.length !== n) save(); return n !== devices.length; }
export function rename(id, name) { const d = devices.find((x) => x.id === id); if (d) { d.name = String(name).slice(0, 60); save(); } return !!d; }
