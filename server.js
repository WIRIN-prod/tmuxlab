// tmuxlab: web/Android control plane for tmux sessions (shells, claude, codex, CI).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { CONF, httpErr, sleep, resolveCwd, loadConf, saveConf, NAME_RE } from './lib/util.js';
import { TMUX, SOCK, tmux, sess, tgt, listPanes, shape, startCmd, setProject, storedCmd, interrupt, killViews, choose, VIEW_RE } from './lib/tmux.js';
import { claudeHistory, codexHistory } from './lib/agents.js';
import * as G from './lib/git.js';
import { stats, openPorts } from './lib/stats.js';
import { forward } from './lib/ports.js';
import * as auth from './lib/auth.js';
import * as rs from './lib/restore.js';
import * as logs from './lib/logs.js';
const { setMaster } = auth;
import { parseCron, nextRun } from './lib/cron.js';
import { startWatcher, prompts, status, agentState, lastRuns, notify, answerToken } from './lib/watch.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 7681);
const HOST = process.env.HOST || '0.0.0.0';

// --- auth: one shared secret, generated on first run ---
const tokenFile = path.join(CONF, 'token');
let TOKEN = process.env.TMUXLAB_TOKEN || (fs.existsSync(tokenFile)
  ? fs.readFileSync(tokenFile, 'utf8').trim()
  : (() => { const t = crypto.randomBytes(24).toString('base64url'); fs.writeFileSync(tokenFile, t, { mode: 0o600 }); return t; })());
setMaster(TOKEN);

// addresses other devices can use; Tailscale (100.64/10) first since it also works away from home
const lanAddrs = () => ['127.0.0.1', 'localhost'].includes(HOST) ? [] : Object.entries(os.networkInterfaces())
  .filter(([n]) => !/^(docker|br-|veth|virbr|lo)/.test(n)).flatMap(([, a]) => a)
  .filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address)
  .sort((a, b) => /^100\./.test(b) - /^100\./.test(a));

// --- sessions, windows, panes ---
const panePids = async () => (await listPanes()).filter((x) => !VIEW_RE.test(x.session_name)).map((x) => ({ session: x.session_name, pid: +x.pane_pid }));
async function listSessions() {
  const rows = await listPanes();
  const cwds = [...new Set(rows.map((r) => r.pane_current_path))];
  const repos = new Map(await Promise.all(cwds.map(async (c) => [c, await G.repoOf(c)])));
  return shape(rows, (r) => {
    const g = repos.get(r.pane_current_path);
        const agent = agentState.get(r.pane_id) || null;
    return { ...(agent && { cmd: agent.agent, running: true }), prompt: prompts.get(r.pane_id) || null, status: status.get(r.pane_id) || null, agent, branch: g?.branch || '', repo: g?.repo || '', wt: g?.wt || '' };
  }).list;
}

const presetOf = (id) => loadConf('presets').find((p) => p.id === id);
const stepCmd = (st) => st.cmd ?? presetOf(st.preset)?.cmd ?? '';
const stepLabel = (st) => st.label || presetOf(st.preset)?.label;

// one window (or split pane) of a session, running a launcher or command
async function addStep(name, cwd, st, splitOf) {
  const label = stepLabel(st);
  let where;
  if (st.split && splitOf !== undefined) {
    where = (await tmux('split-window', st.split === 'down' ? '-v' : '-h', '-P', '-F', '#{window_index}.#{pane_index}',
      '-t', tgt(name, splitOf), '-c', cwd || '#{pane_current_path}')).trim();
  } else {
    where = (await tmux('new-window', '-P', '-F', '#{window_index}', '-t', `=${sess(name)}:`,
      ...(cwd ? ['-c', cwd] : []), ...(label ? ['-n', label] : []))).trim();
  }
  await startCmd(tgt(name, where), stepCmd(st));
  return where;
}

async function freeName(base) {
  base = base.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 56) || 'session';
  const taken = new Set((await tmux('list-sessions', '-F', '#{session_name}').catch(() => '')).split('\n'));
  let n = base, i = 2; while (taken.has(n)) n = `${base}-${i++}`;
  return n;
}

async function createSession({ name, cwd, stack, worktree, project, ...st }) {
  if (project && !NAME_RE.test(project)) throw httpErr(400, 'bad project');
  let dir = resolveCwd(cwd);
  if (worktree?.branch) dir = await G.addWorktree(dir, worktree.branch);
  name = sess(name || await freeName(path.basename(dir))); // unnamed sessions are named after their folder, not a number
  if (VIEW_RE.test(name)) throw httpErr(400, 'bad session name');
  const steps = stack ? loadConf('stacks').find((s) => s.id === stack)?.windows : [st];
  if (!steps) throw httpErr(400, `no stack ${stack}`);
  const label = stepLabel(steps[0]);
  await tmux('new-session', '-d', '-s', name, '-c', dir, '-x', '200', '-y', '50', ...(label ? ['-n', label] : []));
  if (project) await setProject(name, project);
  const first = (await tmux('display-message', '-p', '-t', `=${name}:`, '#{window_index}')).trim();
  await startCmd(tgt(name, first), stepCmd(steps[0]));
  let last = first;
  for (const s of steps.slice(1)) last = (await addStep(name, dir, s, last.split('.')[0])).split('.')[0];
  if (steps.length > 1) await tmux('select-window', '-t', tgt(name, first));
  return { name, window: +first, cwd: dir };
}

async function runSchedule(s) {
  const name = s.session || 'scheduled';
  const label = `${s.label.slice(0, 20)} ${new Date().toTimeString().slice(0, 5)}`;
  const exists = await tmux('has-session', '-t', `=${name}`).then(() => true, () => false);
  if (!exists) await createSession({ name, cwd: s.cwd, preset: s.preset, cmd: s.cmd, label });
  else await addStep(name, s.cwd ? resolveCwd(s.cwd) : undefined, { preset: s.preset, cmd: s.cmd, label });
  lastRuns[s.id] = new Date().toISOString();
  notify(`Scheduled: ${s.label}`, `started in session ${name}`, { tags: 'alarm_clock' }).catch(() => {});
}

// --- REST API ---
const W = '/api/windows/([^/]+)/(\\d+(?:\\.\\d+)?)';
const r = (s) => new RegExp(`^${s}$`);
const routes = [
  ['GET', r('/api/sessions'), () => listSessions()],
  ['POST', r('/api/sessions'), (_, b) => createSession(b)],
  // after a reboot: offer to recreate the sessions that were open before
  ['GET', r('/api/restore'), () => rs.offer()],
  // output of every pane, live and saved
  ['GET', r('/api/logs/search'), (_, __, q) => logs.search(q.get('q'))],
  ['GET', r('/api/logs/([\\w.-]+)'), ([f]) => { const l = logs.readLog(f); if (!l) throw httpErr(404, 'no such log'); return l; }],
  ['POST', r('/api/restore'), (_, b) => rs.restore({ run: b.run !== false })],
  ['DELETE', r('/api/restore'), () => { rs.dismiss(); return {}; }],
  ['DELETE', r('/api/sessions/([^/]+)'), async ([s]) => { await logs.saveLogs(sess(s)).catch(() => {}); await killViews(s); await tmux('kill-session', '-t', `=${s}`); return {}; }],
  ['POST', r('/api/sessions/([^/]+)/rename'), async ([s], b) => {
    if (!NAME_RE.test(b.to || '')) throw httpErr(400, 'bad name');
    await tmux('rename-session', '-t', `=${sess(s)}`, b.to); return {};
  }],
  ['POST', r('/api/sessions/([^/]+)/project'), async ([s], b) => { await setProject(s, b.project || ''); return {}; }],
  ['POST', r('/api/sessions/([^/]+)/windows'), async ([s], b) =>
    ({ window: +(await addStep(sess(s), b.cwd ? resolveCwd(b.cwd) : undefined, b)).split('.')[0] })],
  ['DELETE', r(W), async ([s, w]) => { await tmux(w.includes('.') ? 'kill-pane' : 'kill-window', '-t', tgt(s, w)); return {}; }],
  ['POST', r(`${W}/select`), async ([s, w]) => {
    await tmux('select-window', '-t', tgt(s, w.split('.')[0]));
    if (w.includes('.')) await tmux('select-pane', '-t', tgt(s, w));
    return {};
  }],
  ['POST', r(`${W}/rename`), async ([s, w], b) => {
    if (typeof b.to !== 'string' || !b.to || b.to.length > 64) throw httpErr(400, 'bad name');
    await tmux('rename-window', '-t', tgt(s, w.split('.')[0]), b.to); return {};
  }],
  ['POST', r(`${W}/move`), async ([s, w], b) => {
    await tmux('swap-window', '-d', '-s', tgt(s, w.split('.')[0]), '-t', tgt(s, String(b.to | 0))); return {};
  }],
  // literal text and/or tmux key names (C-c, Enter, Up...)
  ['POST', r(`${W}/keys`), async ([s, w], b) => {
    const t = tgt(s, w);
    if (typeof b.text === 'string' && b.text) await tmux('send-keys', '-t', t, '-l', b.text);
    for (const k of Array.isArray(b.keys) ? b.keys : []) {
      if (!/^[\w-]{1,16}$/.test(k)) throw httpErr(400, `bad key ${k}`);
      await tmux('send-keys', '-t', t, k);
    }
    return {};
  }],
  ['POST', r(`${W}/stop`), async ([s, w]) => { await interrupt(tgt(s, w)); return {}; }],
  ['POST', r(`${W}/start`), async ([s, w], b) => {
    const t = tgt(s, w);
    const cmd = (b.cmd ?? b.preset) ? stepCmd(b) : await storedCmd(t);
    if (!cmd) throw httpErr(400, 'no command for this pane');
    await startCmd(t, cmd); return {};
  }],
  ['POST', r(`${W}/split`), async ([s, w], b) => ({ pane: await addStep(sess(s), undefined, { ...b, split: b.dir === 'down' ? 'down' : 'right' }, w) })],
  ['POST', r(`${W}/pane`), async ([s, w], b) => {
    const win = tgt(s, w.split('.')[0]);
    const acts = {
      next: () => tmux('select-pane', '-t', `${win}.+`),
      zoom: () => tmux('resize-pane', '-Z', '-t', tgt(s, w)),
      layout: () => tmux('next-layout', '-t', win),
      sync: () => tmux('set-option', '-w', '-t', win, 'synchronize-panes'),
    };
    if (!acts[b.action]) throw httpErr(400, 'bad action');
    await acts[b.action](); return {};
  }],
  // answer an arrow-key menu (agent permission prompts): move from the selected option to n, then Enter
  ['POST', r(`${W}/choose`), async ([s, w], b) => { await choose(tgt(s, w), b.n | 0); return {}; }],
  // past Claude Code / Codex conversations started in a folder
  ['GET', r('/api/agents/(claude|codex)/history'), ([a], _, q) => {
    const cwd = resolveCwd(q.get('cwd') || '');
    return a === 'claude' ? claudeHistory(cwd) : codexHistory(cwd);
  }],
  ['POST', r(`${W}/scroll`), async ([s, w], b) => {
    const t = tgt(s, w);
    const lines = Math.max(1, Math.min(b.lines | 0 || 10, 500)), n = String(lines);
    if (b.dir === 'cancel') { await tmux('send-keys', '-t', t, '-X', 'cancel').catch(() => {}); return { mode: 'copy' }; }
    const up = b.dir === 'up';
    const [inMode, alt, mouse, sgr, wd, ht] = (await tmux('display-message', '-p', '-t', t,
      '#{pane_in_mode} #{alternate_on} #{mouse_any_flag} #{mouse_sgr_flag} #{pane_width} #{pane_height}')).trim().split(' ').map(Number);
    // full-screen apps (Claude Code, codex, vim, less) keep their own scrollback: do what a terminal does with a wheel
    if (!inMode && alt) {
      if (mouse) {
        const x = Math.ceil(wd / 2), y = Math.ceil(ht / 2), btn = up ? 64 : 65;
        const ev = sgr ? `\x1b[<${btn};${x};${y}M` : `\x1b[M${String.fromCharCode(32 + btn, 32 + Math.min(x, 222), 32 + Math.min(y, 222))}`;
        await tmux('send-keys', '-t', t, '-l', ev.repeat(Math.min(40, Math.max(1, Math.round(lines / 3))))); // one wheel notch ≈ 3 lines
        return { mode: 'app' };
      }
      await tmux('send-keys', '-t', t, '-N', String(Math.min(lines, 100)), up ? 'Up' : 'Down'); // xterm's alternateScroll
      return { mode: 'keys' };
    }
    // -e: copy mode exits by itself when scrolled back to the bottom
    if (up) { await tmux('copy-mode', '-e', '-t', t); await tmux('send-keys', '-t', t, '-X', '-N', n, 'scroll-up'); return { mode: 'copy' }; }
    if (inMode) await tmux('send-keys', '-t', t, '-X', '-N', n, 'scroll-down').catch(() => {});
    return { mode: inMode ? 'copy' : 'none' };
  }],
  ['GET', r(`${W}/capture`), async ([s, w], _, q) => {
    const lines = Math.min(+(q.get('lines') || 30), 5000);
    return { text: await tmux('capture-pane', '-p', '-J', '-t', tgt(s, w), '-S', `-${lines}`) };
  }],
  // open a dev server port through tmuxlab; the link carries a key that only works for that port
  ['POST', r('/api/ports/(\\d{2,5})/open'), async ([p]) => {
    const port = +p;
    if (!openPorts.has(port)) throw httpErr(404, `nothing in a session listens on port ${port}`);
    const f = await forward(port); return { port: f.port, key: f.key };
  }],
  ['GET', r('/api/stats'), async () => {
    return stats(await panePids());
  }],
  ['GET', r('/api/(?:config/)?(presets|stacks|schedules|settings|projects|snippets)'), ([n]) => loadConf(n)],
  ['PUT', r('/api/(?:config/)?(presets|stacks|schedules|settings|projects|snippets)'), ([n], b) => {
    if (n === 'schedules') for (const s of Array.isArray(b) ? b : []) try { parseCron(s.cron); } catch (e) { throw httpErr(400, `${s.label}: ${e.message}`); }
    return saveConf(n, b);
  }],
  ['POST', r('/api/alerts/test'), async () => {
    if (!(await notify('tmuxlab test', `Alerts from ${os.hostname()} work.`, { tags: 'bell' }))) throw httpErr(400, 'set an ntfy topic URL first');
    return {};
  }],
  // the tmuxlab command: an agent tells you something (phone alert)
  ['POST', r('/api/notify'), async (_, b) => {
    const title = String(b?.title || '').slice(0, 120), message = String(b?.message || '').slice(0, 2000);
    if (!title) throw httpErr(400, 'title is required');
    if (!(await notify(title, message || title, { tags: 'robot' }))) throw httpErr(400, 'set an ntfy topic URL in Settings › Phone alerts first');
    return {};
  }],
  ['GET', r('/api/schedules/status'), () => Object.fromEntries(loadConf('schedules').map((s) => {
    let next = null; try { next = nextRun(parseCron(s.cron))?.toISOString(); } catch {}
    return [s.id, { last: lastRuns[s.id] || null, next }];
  }))],
  ['POST', r('/api/schedules/([^/]+)/run'), async ([id]) => {
    const s = loadConf('schedules').find((x) => x.id === id);
    if (!s) throw httpErr(404, 'no such schedule');
    await runSchedule(s); return {};
  }],
  ['GET', r('/api/git'), (_, __, q) => G.info(q.get('path'))],
  ['GET', r('/api/repos'), async () => G.overview((await listPanes()).filter((p) => !VIEW_RE.test(p.session_name)).map((p) => p.pane_current_path))],
  ['GET', r('/api/git/diff'), async (_, __, q) => ({ diff: await G.diff(q.get('path'), q.get('file')) })],
  ['POST', r('/api/git/commit'), async (_, b) => ({ result: await G.commit(b.path, b.message) })],
  ['POST', r('/api/git/push'), async (_, b) => ({ result: await G.push(b.path) })],
  ['POST', r('/api/git/pr'), async (_, b) => ({ url: await G.pr(b.path, b.title, b.body) })],
  ['POST', r('/api/git/worktree'), async (_, b) => ({ path: await G.addWorktree(b.path, b.branch) })],
  ['DELETE', r('/api/git/worktree'), async (_, b) => ({ main: await G.removeWorktree(b.path, !!b.force) })],
  ['GET', r('/api/fs'), (_, __, q) => {
    const dir = resolveCwd(q.get('path') || '~');
    const dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (q.get('hidden') || !d.name.startsWith('.')))
      .map((d) => d.name).sort((a, b) => a.localeCompare(b)).slice(0, 500);
    return { path: dir, parent: path.dirname(dir), dirs, git: fs.existsSync(path.join(dir, '.git')), home: os.homedir() };
  }],
  ['GET', r('/api/info'), async (_, __, ___, who) => ({ host: os.hostname(), user: os.userInfo().username, tmux: (await tmux('-V')).trim(), version: 2,
    addrs: lanAddrs(), apk: apkVersion(), role: who.role, session: who.session, self: who.id, auth: who.master ? 'server' : 'device' })],
  // devices: each gets its own token (the server token only signs devices in); share links are view-only devices
  ['GET', r('/api/devices'), (_, __, ___, who) => ({ self: who.id, devices: auth.list() })],
  ['POST', r('/api/devices'), (_, b) => auth.issue({ name: b.name })],
  ['POST', r('/api/devices/self/name'), (_, b, __, who) => { if (!who.master) auth.rename(who.id, b.name || 'Device'); return {}; }],
  ['DELETE', r('/api/devices/([0-9a-f]{12})'), ([id]) => { if (!auth.revoke(id)) throw httpErr(404, 'no such device'); return {}; }],
  ['POST', r('/api/share'), async (_, b) => {
    const hours = b.hours | 0;
    if (!NAME_RE.test(b.session || '') || !(await listSessions()).some((s) => s.name === b.session)) throw httpErr(404, 'no such session');
    if (hours < 1 || hours > 168) throw httpErr(400, 'a link lasts 1 to 168 hours');
    return auth.issue({ name: `View link: ${b.session}`, role: 'view', session: b.session, hours });
  }],
  ['POST', r('/api/token/rotate'), () => {
    if (process.env.TMUXLAB_TOKEN) throw httpErr(400, 'the server token is set by TMUXLAB_TOKEN; change it there');
    TOKEN = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 }); setMaster(TOKEN);
    return {};
  }],
];

// upload into <folder>/.tmuxlab-uploads (git-ignored locally) so agents can read it without leaving the project
async function upload(req, q) {
  const dir = resolveCwd(q.get('dir'));
  const name = path.basename(q.get('name') || 'file').replace(/[^\w.-]/g, '_').slice(-100) || 'file';
  const dest = path.join(dir, '.tmuxlab-uploads');
  fs.mkdirSync(dest, { recursive: true });
  try {
    const ex = path.resolve(dir, (await G.git(dir, 'rev-parse', '--git-path', 'info/exclude')).trim());
    const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
    if (!cur.includes('.tmuxlab-uploads')) { fs.mkdirSync(path.dirname(ex), { recursive: true }); fs.appendFileSync(ex, '\n.tmuxlab-uploads/\n'); }
  } catch {} // not a git repo
  const file = path.join(dest, `${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}-${name}`);
  const out = fs.createWriteStream(file, { mode: 0o600 });
  let n = 0;
  await new Promise((res, rej) => {
    req.on('data', (c) => { n += c.length; if (n > 50 << 20) { req.unpipe(out); out.destroy(); fs.rmSync(file, { force: true }); rej(httpErr(413, 'file over 50 MB')); } });
    req.pipe(out); out.on('finish', res); out.on('error', rej); req.on('error', rej);
  });
  return { path: file, bytes: n };
}

const readBody = (req) => new Promise((res, rej) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > 1 << 20) { rej(httpErr(413, 'too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { res(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { rej(httpErr(400, 'bad json')); } });
});

const send = (res, code, body) => {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

// --- static files: public/ (xterm and fonts are copied into public/vendor on install) ---
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };
const PUB = path.join(ROOT, 'public');

// the newest app build, for phones to update from (scripts/build-apk.sh writes both files)
const APK = path.join(ROOT, 'dist', 'tmuxlab.apk');
const apkVersion = () => { try { return fs.readFileSync(APK.replace(/\.apk$/, '.version'), 'utf8').trim(); } catch { return null; } };

function serveStatic(url, res) {
  if (url === '/tmuxlab.apk') { // public, like the page itself: it holds no token
    return fs.stat(APK, (err, st) => {
      if (err) return send(res, 404, { error: 'no app build on this machine' });
      res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-length': st.size, 'content-disposition': 'attachment; filename="tmuxlab.apk"' });
      fs.createReadStream(APK).pipe(res);
    });
  }
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
  const ans = req.method === 'POST' && url.pathname.match(/^\/api\/answer\/([\w-]{20,64})$/);
  if (ans) {
    const a = answerToken(ans[1]);
    if (!a) return send(res, 410, { error: 'this answer link was used or has expired' });
    try { await choose(a.pane, a.n, a.question); return send(res, 200, { ok: true }); } catch (e) { return send(res, e.code || 500, { error: e.message }); }
  }
  const who = auth.check((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!who) return send(res, 401, { error: 'unauthorized' });
  // a view-only link can read its one session and nothing else
  const viewer = who.role === 'view';
  if (viewer && !(req.method === 'GET' && ['/api/info', '/api/sessions'].includes(url.pathname))) return send(res, 403, { error: 'this link can only watch' });
  try {
    if (req.method === 'POST' && url.pathname === '/api/upload') return send(res, 200, await upload(req, url.searchParams));
    for (const [m, re, fn] of routes) {
      const hit = req.method === m && url.pathname.match(re);
      if (!hit) continue;
      const body = m === 'GET' ? {} : await readBody(req);
      const out = await fn(hit.slice(1).map(decodeURIComponent), body, url.searchParams, who);
      return send(res, 200, viewer && url.pathname === '/api/sessions' ? out.filter((s) => s.name === who.session) : out);
    }
    send(res, 404, { error: 'no route' });
  } catch (e) {
    send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: (e.stderr || e.message || '').trim() });
  }
});

// --- terminal websocket: each connection gets its own view session and a `tmux attach` pty ---
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://x');
  const s = url.searchParams.get('s') || '';
  const who = auth.check(url.searchParams.get('token'));
  if (url.pathname !== '/ws' || !who || !NAME_RE.test(s) || (who.role === 'view' && s !== who.session)) {
    sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return;
  }
  wss.handleUpgrade(req, sock, head, (ws) => attach(ws, s, url.searchParams, who.role === 'view').catch((e) => { console.error('attach:', e.message); ws.close(1011); }));
});

async function attach(ws, s, q, readOnly = false) {
  const cols = Math.max(10, Math.min(+q.get('cols') || 80, 500));
  const rows = Math.max(5, Math.min(+q.get('rows') || 24, 300));
  const w = q.get('w');
  const early = []; // input that arrives while the view is being set up
  const onEarly = (m) => early.push(m);
  ws.on('message', onEarly);
  const view = `${s}~tl${crypto.randomBytes(4).toString('hex')}`;
  try { await tmux('new-session', '-d', '-t', `=${s}`, '-s', view, '-x', String(cols), '-y', String(rows)); }
  catch { ws.close(4404, 'no such session'); return; }
  // show the real session name in the status bar, not the internal view name
  const left = await tmux('show-options', '-gv', 'status-left').catch(() => '');
  if (left.includes('#S') || left.includes('#{session_name}')) {
    await tmux('set-option', '-t', `=${view}:`, 'status-left', left.trim().replaceAll('#{session_name}', '#{session_group}').replaceAll('#S', '#{session_group}')).catch(() => {});
  }
  const cleanup = () => tmux('kill-session', '-t', `=${view}:`).catch(() => {});
  if (ws.readyState !== 1) return cleanup();
  // start on the requested window, else wherever the parent session is
  const start = w && /^\d{1,4}$/.test(w) ? w : (await tmux('display-message', '-p', '-t', `=${s}:`, '#{window_index}')).trim();
  await tmux('select-window', '-t', `=${view}:${start}`).catch(() => {});
  ws.send('\x00TL' + JSON.stringify({ t: 'view', name: view }));
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'C.UTF-8' };
  delete env.TMUX; // allow attaching even when the server itself runs inside tmux
  const p = pty.spawn(TMUX, [...SOCK, 'attach-session', ...(readOnly ? ['-f', 'read-only,ignore-size'] : []), '-t', `=${view}`], { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env });
  p.onData((d) => ws.readyState === 1 && ws.send(d));
  p.onExit(({ exitCode }) => { cleanup(); if (ws.readyState === 1) ws.close(4000 + Math.min(exitCode, 999), 'detached'); });
  const handle = (m) => {
    const msg = m.toString();
    // control frames are JSON prefixed with \x00; everything else is raw input
    if (msg[0] === '\x00') {
      try {
        const c = JSON.parse(msg.slice(1));
        if (c.t === 'resize') p.resize(Math.max(10, Math.min(c.cols | 0, 500)), Math.max(5, Math.min(c.rows | 0, 300)));
      } catch {}
    } else if (!readOnly) p.write(msg);
  };
  ws.off('message', onEarly);
  ws.on('message', handle);
  early.forEach(handle);
  const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 25000);
  ws.on('close', () => { clearInterval(ping); try { p.kill(); } catch {} cleanup(); });
}

startWatcher(runSchedule);
setInterval(() => rs.snapshot().catch((e) => console.error('snapshot:', e.message)), 30e3).unref();
setTimeout(() => rs.snapshot().catch(() => {}), 3000).unref();
setInterval(() => logs.saveLogs().catch((e) => console.error('logs:', e.message)), 60e3).unref();
server.listen(PORT, HOST, () => {
  // skip docker/bridge interfaces; a loopback bind is only reachable from localhost
  const lan = lanAddrs();
  console.log(`tmuxlab listening on ${HOST}:${PORT}\nOpen one of these (the link carries your token):`);
  for (const ip of ['localhost', ...lan]) console.log(`  http://${ip}:${PORT}/#token=${TOKEN}`);
  console.log(`token: ${tokenFile}\nconfig: ${CONF}\nPair a phone: npm run pair (shows a QR code to scan)`);
});

export { server, TOKEN };
