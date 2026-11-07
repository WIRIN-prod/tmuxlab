// Dev servers started inside sessions: which TCP ports their processes listen on, and a small
// forwarder so a phone can open one even when it only listens on localhost.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

// pid -> [{ port, local }] for listening TCP sockets of processes we can read (our own user's)
export function listeners() {
  const socks = new Map(); // inode -> { port, local }
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of t.split('\n').slice(1)) {
      const c = l.trim().split(/\s+/); if (c[3] !== '0A') continue; // 0A = LISTEN
      const [addr, port] = c[1].split(':');
      const local = /^(0100007F|00000000000000000000000001000000)$/.test(addr); // 127.0.0.1 or ::1
      const prev = socks.get(c[9]);
      socks.set(c[9], { port: parseInt(port, 16), local: prev ? prev.local && local : local });
    }
  }
  const out = new Map();
  if (!socks.size) return out;
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let fds; try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link; try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const s = link.startsWith('socket:[') && socks.get(link.slice(8, -1));
      if (s) { if (!out.has(+pid)) out.set(+pid, []); out.get(+pid).push(s); }
    }
  }
  return out;
}

// port -> { port: proxyPort, key, server }
const forwards = new Map();
const COOKIE = (p) => `tlfwd${p}`;

// Each forward gets its own random key: the first visit carries it as ?tl=..., which sets a cookie.
export function forward(target) {
  const have = forwards.get(target);
  if (have) return Promise.resolve(have);
  const key = crypto.randomBytes(18).toString('base64url');
  const ok = (req) => (req.headers.cookie || '').split(/;\s*/).includes(`${COOKIE(target)}=${key}`);
  const upstream = (req) => ({ host: '127.0.0.1', port: target, method: req.method, path: req.url,
    headers: { ...req.headers, host: `localhost:${target}` } });
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('tl') === key) {
      u.searchParams.delete('tl');
      res.writeHead(302, { location: u.pathname + u.search, 'set-cookie': `${COOKIE(target)}=${key}; HttpOnly; SameSite=Lax; Path=/` });
      return res.end();
    }
    if (!ok(req)) { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('Open this preview from tmuxlab.'); }
    const up = http.request(upstream(req), (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`localhost:${target} is not answering (${e.code})`); });
    req.pipe(up);
  });
  // websockets (hot reload) are passed through as raw TCP after the upgrade request
  srv.on('upgrade', (req, sock, head) => {
    if (!ok(req)) return sock.destroy();
    const up = net.connect(target, '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries({ ...req.headers, host: `localhost:${target}` }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      sock.pipe(up).pipe(sock);
    });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, process.env.HOST || '0.0.0.0', () => {
      const f = { port: srv.address().port, key, server: srv };
      forwards.set(target, f); resolve(f);
    });
  });
}

// stop forwarding ports nothing listens on any more
export function pruneForwards(open) {
  for (const [p, f] of forwards) if (!open.has(p)) { f.server.close(); forwards.delete(p); }
}
