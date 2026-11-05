// tmuxlab: web/PWA control plane for tmux sessions (shells, claude, codex, CI).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONF = process.env.TMUXLAB_HOME || path.join(os.homedir(), '.config', 'tmuxlab');
const PORT = +(process.env.PORT || 7681);
const HOST = process.env.HOST || '0.0.0.0';
const TMUX = process.env.TMUXLAB_TMUX || 'tmux';
const SOCK = process.env.TMUXLAB_SOCKET ? ['-L', process.env.TMUXLAB_SOCKET] : []; // separate tmux server, e.g. for tests
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'login', 'tmux']);
const NAME_RE = /^[\w.-]{1,64}$/;

fs.mkdirSync(CONF, { recursive: true, mode: 0o700 });

// --- auth: one shared secret, generated on first run ---
const tokenFile = path.join(CONF, 'token');
const TOKEN = process.env.TMUXLAB_TOKEN || (fs.existsSync(tokenFile)
  ? fs.readFileSync(tokenFile, 'utf8').trim()
  : (() => { const t = crypto.randomBytes(24).toString('base64url'); fs.writeFileSync(tokenFile, t, { mode: 0o600 }); return t; })());
const authed = (t) => typeof t === 'string' && t.length === TOKEN.length &&
  crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));

// --- presets: launchers shown in the UI, editable from the UI ---
const presetFile = path.join(CONF, 'presets.json');
const DEFAULT_PRESETS = [
  { id: 'shell', label: 'Shell', cmd: '', icon: '❯' },
  { id: 'claude', label: 'Claude', cmd: 'claude', icon: '✳' },
  { id: 'claude-resume', label: 'Claude (continue)', cmd: 'claude --continue', icon: '↻' },
  { id: 'codex', label: 'Codex', cmd: 'codex', icon: '◎' },
  { id: 'ci', label: 'Tests', cmd: 'npm test', icon: '✓' },
  { id: 'dev', label: 'Dev server', cmd: 'npm run dev', icon: '▲' },
];
const loadPresets = () => {
  try { return JSON.parse(fs.readFileSync(presetFile, 'utf8')); } catch { return DEFAULT_PRESETS; }
};
const validPresets = (p) => Array.isArray(p) && p.length <= 100 && p.every((x) =>
  x && typeof x.id === 'string' && NAME_RE.test(x.id) && typeof x.label === 'string' &&
  x.label.length <= 40 && typeof x.cmd === 'string' && x.cmd.length <= 2000 &&
  (x.icon === undefined || (typeof x.icon === 'string' && x.icon.length <= 4)));

// --- tmux helpers (execFile, never a shell) ---
const tmux = async (...args) => (await run(TMUX, [...SOCK, ...args], { maxBuffer: 8 << 20 })).stdout;
const sess = (n) => { if (!NAME_RE.test(n)) throw httpErr(400, 'bad session name'); return n; };
const win = (s, i) => { if (!/^\d{1,4}$/.test(String(i))) throw httpErr(400, 'bad window'); return `=${sess(s)}:${i}`; };
const httpErr = (code, msg) => Object.assign(new Error(msg), { code });

const FMT = ['session_name', 'session_attached', 'session_created', 'session_activity', 'window_index',
  'window_name', 'window_active', 'pane_current_command', 'pane_current_path', 'pane_dead',
  'window_activity', '@tl_cmd', 'pane_pid', 'window_panes', 'pane_in_mode'].map((f) => `#{${f}}`).join('\t');

async function listSessions() {
  let out;
  try { out = await tmux('list-windows', '-a', '-F', FMT); } catch (e) {
    if (/no server running|error connecting/i.test(e.stderr || '')) return [];
    throw e;
  }
  const map = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, attached, created, activity, index, wname, active, cmd, cwd, dead, wact, tlcmd, pid, panes, inMode] = line.split('\t');
    if (!map.has(name)) map.set(name, { name, attached: +attached, created: +created, activity: +activity, windows: [] });
    map.get(name).windows.push({
      index: +index, name: wname, active: active === '1', cmd, cwd, dead: dead === '1',
      activity: +wact, preset: tlcmd || '', running: !SHELLS.has(cmd) && dead !== '1', pid: +pid, panes: +panes, inMode: inMode === '1',
    });
  }
  return [...map.values()].sort((a, b) => b.activity - a.activity);
}

const resolveCwd = (p) => {
  const d = !p ? os.homedir() : p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  if (!path.isAbsolute(d) || !fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) throw httpErr(400, `not a directory: ${p}`);
  return d;
};

async function startCmd(target, cmd) {
  await tmux('set-option', '-w', '-t', target, '@tl_cmd', cmd);
  if (cmd) await tmux('send-keys', '-t', target, '-l', cmd), await tmux('send-keys', '-t', target, 'Enter');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const presetCmd = (b) => b.cmd ?? loadPresets().find((p) => p.id === b.preset)?.cmd ?? '';
const presetLabel = (b) => b.label || loadPresets().find((p) => p.id === b.preset)?.label;

// --- REST API ---
const routes = [
  ['GET', /^\/api\/sessions$/, async () => listSessions()],
  ['POST', /^\/api\/sessions$/, async (_, b) => {
    const name = sess(b.name || `s${Date.now().toString(36).slice(-5)}`);
    const cwd = resolveCwd(b.cwd);
    const label = presetLabel(b);
    await tmux('new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', ...(label ? ['-n', label] : []));
    const idx = (await tmux('display-message', '-p', '-t', `=${name}:`, '#{window_index}')).trim();
    await startCmd(win(name, idx), presetCmd(b));
    return { name, window: +idx };
  }],
  ['DELETE', /^\/api\/sessions\/([^/]+)$/, async ([s]) => { await tmux('kill-session', '-t', `=${sess(s)}`); return {}; }],
  ['POST', /^\/api\/sessions\/([^/]+)\/rename$/, async ([s], b) => { await tmux('rename-session', '-t', `=${sess(s)}`, sess(b.to)); return {}; }],
  ['POST', /^\/api\/sessions\/([^/]+)\/windows$/, async ([s], b) => {
    const label = presetLabel(b);
    const cwd = b.cwd ? resolveCwd(b.cwd) : undefined;
    const idx = (await tmux('new-window', '-P', '-F', '#{window_index}', '-t', `=${sess(s)}:`,
      ...(cwd ? ['-c', cwd] : []), ...(label ? ['-n', label] : []))).trim();
    await startCmd(win(s, idx), presetCmd(b));
    return { window: +idx };
  }],
  ['DELETE', /^\/api\/windows\/([^/]+)\/(\d+)$/, async ([s, i]) => { await tmux('kill-window', '-t', win(s, i)); return {}; }],
  ['POST', /^\/api\/windows\/([^/]+)\/(\d+)\/select$/, async ([s, i]) => { await tmux('select-window', '-t', win(s, i)); return {}; }],
  ['POST', /^\/api\/windows\/([^/]+)\/(\d+)\/rename$/, async ([s, i], b) => {
    if (typeof b.to !== 'string' || !b.to || b.to.length > 64) throw httpErr(400, 'bad name');
    await tmux('rename-window', '-t', win(s, i), b.to); return {};
  }],
  // send literal text and/or tmux key names (C-c, Enter, Up...)
  ['POST', /^\/api\/windows\/([^/]+)\/(\d+)\/keys$/, async ([s, i], b) => {
    const t = win(s, i);
    if (typeof b.text === 'string' && b.text) await tmux('send-keys', '-t', t, '-l', b.text);
    for (const k of Array.isArray(b.keys) ? b.keys : []) {
      if (!/^[\w-]{1,16}$/.test(k)) throw httpErr(400, `bad key ${k}`);
      await tmux('send-keys', '-t', t, k);
    }
    return {};
  }],
  // stop: interrupt twice (claude/codex need a double ^C), start: rerun the window's command
  ['POST', /^\/api\/windows\/([^/]+)\/(\d+)\/stop$/, async ([s, i]) => {
    const t = win(s, i);
    await tmux('send-keys', '-t', t, 'C-c'); await sleep(250); await tmux('send-keys', '-t', t, 'C-c');
    return {};
  }],
  ['POST', /^\/api\/windows\/([^/]+)\/(\d+)\/start$/, async ([s, i], b) => {
    const t = win(s, i);
    const cmd = (b.cmd ?? b.preset) ? presetCmd(b) : (await tmux('show-options', '-wqv', '-t', t, '@tl_cmd')).trim();
    if (!cmd) throw httpErr(400, 'no command for this window');
    await startCmd(t, cmd); return {};
  }],
  ['POST', /^\/api\/windows\/([^/]+)\/(\d+)\/scroll$/, async ([s, i], b) => {
    const t = win(s, i);
    const n = String(Math.max(1, Math.min(b.lines | 0 || 10, 500)));
    // -e: leaving copy mode automatically when scrolled back to the bottom
    if (b.dir === 'up') await tmux('copy-mode', '-e', '-t', t), await tmux('send-keys', '-t', t, '-X', '-N', n, 'scroll-up');
    else if (b.dir === 'down') await tmux('send-keys', '-t', t, '-X', '-N', n, 'scroll-down').catch(() => {});
    else await tmux('send-keys', '-t', t, '-X', 'cancel').catch(() => {});
    return {};
  }],
  ['GET', /^\/api\/windows\/([^/]+)\/(\d+)\/capture$/, async ([s, i], _, q) => {
    const lines = Math.min(+(q.get('lines') || 30), 2000);
    return { text: await tmux('capture-pane', '-p', '-J', '-t', win(s, i), '-S', `-${lines}`) };
  }],
  ['GET', /^\/api\/presets$/, async () => loadPresets()],
  ['PUT', /^\/api\/presets$/, async (_, b) => {
    if (!validPresets(b)) throw httpErr(400, 'invalid presets');
    fs.writeFileSync(presetFile, JSON.stringify(b, null, 2)); return b;
  }],
  ['GET', /^\/api\/fs$/, async (_, __, q) => {
    const dir = resolveCwd(q.get('path') || '~');
    const dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (q.get('hidden') || !d.name.startsWith('.')))
      .map((d) => d.name).sort((a, b) => a.localeCompare(b)).slice(0, 500);
    const git = fs.existsSync(path.join(dir, '.git'));
    return { path: dir, parent: path.dirname(dir), dirs, git, home: os.homedir() };
  }],
  ['GET', /^\/api\/info$/, async () => ({ host: os.hostname(), user: os.userInfo().username, tmux: (await tmux('-V')).trim() })],
];

const readBody = (req) => new Promise((res, rej) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > 1 << 20) { rej(httpErr(413, 'too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { res(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { rej(httpErr(400, 'bad json')); } });
});

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

// --- static files: public/ (xterm is copied into public/vendor on install) ---
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };
const PUB = path.join(ROOT, 'public');

function serveStatic(url, res) {
  const file = path.join(PUB, url === '/' ? 'index.html' : url);
  if (!file.startsWith(PUB + path.sep)) return send(res, 404, { error: 'not found' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(decodeURIComponent(url.pathname), res);
  // CORS for the Capacitor app (origin http://localhost); safe because auth is a bearer token, not a cookie
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!authed((req.headers.authorization || '').replace(/^Bearer /, ''))) return send(res, 401, { error: 'unauthorized' });
  for (const [m, re, fn] of routes) {
    const hit = req.method === m && url.pathname.match(re);
    if (!hit) continue;
    try {
      const body = m === 'GET' ? {} : await readBody(req);
      return send(res, 200, await fn(hit.slice(1).map(decodeURIComponent), body, url.searchParams));
    } catch (e) {
      return send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: (e.stderr || e.message || '').trim() });
    }
  }
  send(res, 404, { error: 'no route' });
});

// --- terminal websocket: one pty per client running `tmux attach` ---
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://x');
  const s = url.searchParams.get('s') || '';
  if (url.pathname !== '/ws' || !authed(url.searchParams.get('token')) || !NAME_RE.test(s)) {
    sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return;
  }
  wss.handleUpgrade(req, sock, head, (ws) => attach(ws, s, url.searchParams));
});

function attach(ws, s, q) {
  const cols = Math.max(10, Math.min(+q.get('cols') || 80, 500));
  const rows = Math.max(5, Math.min(+q.get('rows') || 24, 300));
  const w = q.get('w');
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'C.UTF-8' };
  delete env.TMUX; // allow attaching even when the server itself runs inside tmux
  const target = w && /^\d{1,4}$/.test(w) ? `=${s}:${w}` : `=${s}`;
  const p = pty.spawn(TMUX, [...SOCK, 'attach-session', '-t', target], { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env });
  p.onData((d) => ws.readyState === 1 && ws.send(d));
  p.onExit(({ exitCode }) => { if (ws.readyState === 1) ws.close(4000 + Math.min(exitCode, 999), 'detached'); });
  ws.on('message', (m) => {
    const msg = m.toString();
    // control frames are JSON prefixed with \x00; everything else is raw input
    if (msg[0] === '\x00') {
      try {
        const c = JSON.parse(msg.slice(1));
        if (c.t === 'resize') p.resize(Math.max(10, Math.min(c.cols | 0, 500)), Math.max(5, Math.min(c.rows | 0, 300)));
      } catch {}
    } else p.write(msg);
  });
  ws.on('close', () => { try { p.kill(); } catch {} });
  const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 25000);
  ws.on('close', () => clearInterval(ping));
}

server.listen(PORT, HOST, () => {
  // skip docker/bridge interfaces; a loopback bind is only reachable from localhost
  const lan = ['127.0.0.1', 'localhost'].includes(HOST) ? [] : Object.entries(os.networkInterfaces())
    .filter(([n]) => !/^(docker|br-|veth|virbr|lo)/.test(n)).flatMap(([, a]) => a)
    .filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`tmuxlab listening on ${HOST}:${PORT}\nOpen one of these (the link carries your token):`);
  for (const ip of ['localhost', ...lan]) console.log(`  http://${ip}:${PORT}/#token=${TOKEN}`);
  console.log(`token: ${tokenFile}\nlaunchers: ${presetFile}`);
});

export { server, TOKEN, validPresets };
