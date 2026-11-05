// End-to-end for panes, views, prompts, stacks, git, uploads, stats, schedules. Private tmux socket, temp dirs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxlab-feat-'));
const repo = path.join(home, 'proj');
const SOCK = `tmuxlab-feat-${process.pid}`;
const PORT = 18000 + (process.pid % 1000);
const TOKEN = 'feat-token-0123456789';
const base = `http://127.0.0.1:${PORT}`;
const T = (...a) => execFileSync('tmux', ['-L', SOCK, ...a]).toString();
let srv;

const api = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (r.status !== 200) throw Object.assign(new Error(`${method} ${p} -> ${r.status} ${j.error}`), { status: r.status });
  return j;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await wait(100); }
}
const sessions = () => api('/api/sessions');
const find = async (n) => (await sessions()).find((s) => s.name === n);
const g = (...a) => execFileSync('git', a, { cwd: repo }).toString();

before(async () => {
  fs.mkdirSync(repo);
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); g('add', '.'); g('commit', '-qm', 'init');
  srv = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', TMUXLAB_HOME: home, TMUXLAB_SOCKET: SOCK, TMUXLAB_TOKEN: TOKEN }, stdio: 'pipe',
  });
  await until(async () => fetch(base + '/').then(() => true));
});
after(() => {
  srv.kill();
  try { T('kill-server'); } catch {}
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo + '.worktrees', { recursive: true, force: true });
});

test('each terminal gets its own view: switching windows does not move other viewers', async () => {
  await api('/api/sessions', 'POST', { name: 'v', cwd: home });
  await api('/api/sessions/v/windows', 'POST', { label: 'two' });
  const open = (w) => new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?s=v&token=${TOKEN}&w=${w}`);
    ws.on('message', (d) => { const m = d.toString(); if (m.startsWith('\x00TL')) res({ ws, view: JSON.parse(m.slice(3)).name }); });
  });
  const a = await open(0), b = await open(1);
  const s = await until(async () => { const x = await find('v'); return Object.keys(x.views).length === 2 && x; });
  assert.equal(s.views[a.view], 0);
  assert.equal(s.views[b.view], 1);
  assert.equal(s.attached, 2);
  await api(`/api/windows/${a.view}/1/select`, 'POST');
  assert.equal((await find('v')).views[b.view], 1);
  assert.equal((await sessions()).filter((x) => x.name.includes('~')).length, 0, 'views are not listed as sessions');
  a.ws.close(); b.ws.close();
  await until(async () => !T('ls', '-F', '#{session_name}').includes('~tl'));
  await api('/api/sessions/v', 'DELETE');
});

test('panes: split, zoom, sync, next, kill', async () => {
  await api('/api/sessions', 'POST', { name: 'p', cwd: home });
  const { pane } = await api('/api/windows/p/0/split', 'POST', { dir: 'right', cmd: 'sleep 60' });
  assert.equal(pane, '0.1');
  let w = await until(async () => { const x = (await find('p')).windows[0]; return x.panes[1]?.running && x; });
  assert.equal(w.panes.length, 2);
  assert.equal(w.running, true);
  await api('/api/windows/p/0/pane', 'POST', { action: 'zoom' });
  await api('/api/windows/p/0/pane', 'POST', { action: 'sync' });
  w = (await find('p')).windows[0];
  assert.ok(w.zoomed && w.sync);
  await api('/api/windows/p/0/pane', 'POST', { action: 'next' });
  await api('/api/windows/p/0.1', 'DELETE');
  assert.equal((await find('p')).windows[0].panes.length, 1);
  await assert.rejects(api('/api/windows/p/0/pane', 'POST', { action: 'nope' }), /400/);
  await api('/api/sessions/p', 'DELETE');
});

test('detects a choice prompt and answers it with arrows + Enter', async () => {
  const menu = path.join(home, 'menu.py');
  // a fake agent (not a shell, so it counts as running) with an arrow-key menu
  fs.writeFileSync(menu, `import sys, tty, termios, time
print("Do you want to proceed?\\n\u276f 1. Yes\\n  2. No", flush=True)
tty.setraw(0); sel = 1
while True:
    k = sys.stdin.read(1)
    if k == "\\x1b":
        k = sys.stdin.read(2); sel = 2 if k == "[B" else 1 if k == "[A" else sel
    elif k in "\\r\\n":
        termios.tcsetattr(0, termios.TCSANOW, termios.tcgetattr(1)); print("\\x1b[2J\\x1b[HCHOSE-%d" % sel, flush=True); time.sleep(30)
`);
  await api('/api/sessions', 'POST', { name: 'q', cwd: home, cmd: `python3 ${menu}` });
  const w = await until(async () => (await find('q')).windows[0].prompt && (await find('q')).windows[0]);
  assert.equal(w.prompt.question, 'Do you want to proceed?');
  assert.equal(w.prompt.selected, 1);
  await api('/api/windows/q/0/choose', 'POST', { n: 2 });
  await until(async () => (await api('/api/windows/q/0/capture')).text.includes('CHOSE-2'));
  // the cleared menu lingers in tmux history; it must not count as still waiting
  await until(async () => (await find('q')).windows[0].prompt === null);
  await assert.rejects(api('/api/windows/q/0/choose', 'POST', { n: 1 }), /409/);
  await api('/api/sessions/q', 'DELETE');
});

test('stacks create several windows and splits', async () => {
  await api('/api/config/presets', 'PUT', [{ id: 'sl', label: 'Sleeper', cmd: 'sleep 61' }]);
  await api('/api/config/stacks', 'PUT', [{ id: 'st', label: 'Stack', windows: [{ preset: 'sl' }, { cmd: 'sleep 62', label: 'b' }, { cmd: 'sleep 63', split: 'down' }] }]);
  await api('/api/sessions', 'POST', { name: 'st', cwd: home, stack: 'st' });
  const s = await until(async () => { const x = await find('st'); return x.windows[1]?.panes.length === 2 && x.windows[1].panes.every((p) => p.running) && x; });
  assert.deepEqual(s.windows.map((w) => w.name), ['Sleeper', 'b']);
  assert.equal(s.windows[0].active, true);
  await assert.rejects(api('/api/config/stacks', 'PUT', [{ id: 'bad id', label: 'x', windows: [] }]), /400/);
  await api('/api/sessions/st', 'DELETE');
});

test('git: changes, diff, commit, worktree session, remove worktree', async () => {
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'fresh\n');
  let info = await api('/api/git?path=' + encodeURIComponent(repo));
  assert.equal(info.branch, 'main');
  const a = info.files.find((f) => f.file === 'a.txt');
  assert.equal(a.add, 1);
  assert.ok(info.files.some((f) => f.file === 'new.txt' && f.status === '??'));
  assert.match((await api(`/api/git/diff?path=${encodeURIComponent(repo)}&file=a.txt`)).diff, /\+two/);
  assert.match((await api(`/api/git/diff?path=${encodeURIComponent(repo)}&file=new.txt`)).diff, /\+fresh/);
  await assert.rejects(api(`/api/git/diff?path=${encodeURIComponent(repo)}&file=../../etc/passwd`), /400/);
  await api('/api/git/commit', 'POST', { path: repo, message: 'two lines' });
  info = await api('/api/git?path=' + encodeURIComponent(repo));
  assert.equal(info.files.length, 0);
  assert.match(info.last, /two lines/);

  const s = await api('/api/sessions', 'POST', { name: 'wt', cwd: repo, cmd: '', worktree: { branch: 'agent/x' } });
  assert.equal(s.cwd, path.join(home, 'proj.worktrees', 'agent-x'));
  const w = await until(async () => { const x = (await find('wt')).windows[0]; return x.branch === 'agent/x' && x; });
  assert.equal(w.cwd, s.cwd);
  assert.equal((await api('/api/git?path=' + encodeURIComponent(s.cwd))).isWorktree, true);
  await api('/api/sessions/wt', 'DELETE');
  await api('/api/git/worktree', 'DELETE', { path: s.cwd });
  assert.ok(!fs.existsSync(s.cwd));
  await assert.rejects(api('/api/git/worktree', 'DELETE', { path: repo }), /400/);
  await assert.rejects(api('/api/git/worktree', 'POST', { path: repo, branch: '../evil' }), /400/);
});

test('upload lands in the project and is git-ignored', async () => {
  const r = await fetch(`${base}/api/upload?dir=${encodeURIComponent(repo)}&name=${encodeURIComponent('shot 1.png')}`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: Buffer.from('PNGDATA') });
  const j = await r.json();
  assert.equal(r.status, 200, j.error);
  assert.ok(j.path.startsWith(path.join(repo, '.tmuxlab-uploads') + path.sep));
  assert.match(j.path, /shot_1\.png$/);
  assert.equal(fs.readFileSync(j.path, 'utf8'), 'PNGDATA');
  assert.equal(g('status', '--porcelain'), '');
});

test('stats report machine and per-session usage', async () => {
  await api('/api/sessions', 'POST', { name: 'busy', cwd: home, cmd: 'sleep 64' });
  await api('/api/stats');
  await wait(300);
  const st = await api('/api/stats');
  assert.ok(st.machine.mem.total > 0 && st.machine.cores > 0);
  assert.ok(st.sessions.busy.rss > 0);
  assert.equal(typeof st.machine.cpu, 'number');
  await api('/api/sessions/busy', 'DELETE');
});

test('schedules: validate cron, run now, report next run', async () => {
  await assert.rejects(api('/api/config/schedules', 'PUT', [{ id: 'n', label: 'Nightly', cron: '99 * * * *', session: 'night', cmd: 'echo hi', enabled: true }]), /400/);
  await api('/api/config/schedules', 'PUT', [{ id: 'n', label: 'Nightly', cron: '0 3 * * *', session: 'night', cwd: home, cmd: 'echo sched-ran', enabled: true }]);
  await api('/api/schedules/n/run', 'POST');
  await api('/api/schedules/n/run', 'POST');
  const s = await until(async () => { const x = await find('night'); return x?.windows.length === 2 && x; });
  await until(async () => (await api('/api/windows/night/0/capture')).text.includes('sched-ran'));
  const status = await api('/api/schedules/status');
  assert.ok(status.n.last && new Date(status.n.next).getHours() === 3);
  assert.match(s.windows[1].name, /^Nightly \d\d:\d\d$/);
  await api('/api/sessions/night', 'DELETE');
});

test('settings keep defaults and reject bad URLs', async () => {
  const s = await api('/api/config/settings');
  assert.equal(s.alerts.prompts, true);
  await assert.rejects(api('/api/config/settings', 'PUT', { ntfy: 'file:///etc/passwd' }), /400/);
  await assert.rejects(api('/api/alerts/test', 'POST'), /400/);
});

test('projects: config, assign on create, move, survive rename, clear', async () => {
  assert.deepEqual(await api('/api/config/projects'), []);
  await api('/api/config/projects', 'PUT', [{ id: 'web', label: 'Web app', cwd: home }, { id: 'ml', label: 'ML' }]);
  await assert.rejects(api('/api/config/projects', 'PUT', [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }]), /400/);
  await api('/api/sessions', 'POST', { name: 'pj', cwd: home, project: 'web' });
  assert.equal((await find('pj')).project, 'web');
  await api('/api/sessions/pj/project', 'POST', { project: 'ml' });
  await api('/api/sessions/pj/rename', 'POST', { to: 'pj2' });
  assert.equal((await find('pj2')).project, 'ml');
  await api('/api/sessions/pj2/project', 'POST', { project: '' });
  assert.equal((await find('pj2')).project, '');
  await assert.rejects(api('/api/sessions/pj2/project', 'POST', { project: 'bad id' }), /400/);
  await assert.rejects(api('/api/sessions', 'POST', { name: 'pj3', cwd: home, project: 'bad id' }), /400/);
  assert.equal(await find('pj3'), undefined);
  await api('/api/sessions/pj2', 'DELETE');
});

test('scroll goes to full-screen apps as wheel events, to shells as tmux history', async () => {
  const app = path.join(home, 'fullscreen.py');
  // alternate screen + SGR mouse, like Claude Code's full-screen mode; counts wheel-up events it receives
  fs.writeFileSync(app, `import sys, tty, os
sys.stdout.write("\\x1b[?1049h\\x1b[?1000h\\x1b[?1006hREADY\\n"); sys.stdout.flush()
tty.setraw(0); buf = ""; ups = 0
while True:
    buf += os.read(0, 64).decode()
    while "\\x1b[<64;" in buf:
        ups += 1; buf = buf.replace("\\x1b[<64;", "", 1)
        sys.stdout.write("\\rUP %d   " % ups); sys.stdout.flush()
`);
  await api('/api/sessions', 'POST', { name: 'fs', cwd: home, cmd: `python3 ${app}` });
  await until(async () => (await api('/api/windows/fs/0/capture')).text.includes('READY'));
  assert.equal((await api('/api/windows/fs/0/scroll', 'POST', { dir: 'up', lines: 9 })).mode, 'app');
  await until(async () => (await api('/api/windows/fs/0/capture')).text.includes('UP 3'));
  assert.equal((await find('fs')).windows[0].inMode, false); // no tmux copy mode over the app
  await api('/api/sessions/fs', 'DELETE');

  await api('/api/sessions', 'POST', { name: 'sh', cwd: home, cmd: 'seq 1 200' });
  await until(async () => (await api('/api/windows/sh/0/capture')).text.includes('200'));
  assert.equal((await api('/api/windows/sh/0/scroll', 'POST', { dir: 'down', lines: 5 })).mode, 'none');
  assert.equal((await api('/api/windows/sh/0/scroll', 'POST', { dir: 'up', lines: 5 })).mode, 'copy');
  await api('/api/sessions/sh', 'DELETE');
});
