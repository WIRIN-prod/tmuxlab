// Agent history, dev server ports and alert answer links, against a real server with a throwaway HOME.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paneStatus } from '../lib/tmux.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxlab-agents-'));
const SOCK = `tmuxlab-agents-${process.pid}`;
const PORT = 18000 + (process.pid % 1000), DEV = PORT + 1;
const TOKEN = 'test-token-agents-0123';
const base = `http://127.0.0.1:${PORT}`;
let srv;
const api = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await wait(150); }
}

before(async () => {
  srv = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, HOME: home, PORT, HOST: '127.0.0.1', TMUXLAB_HOME: path.join(home, 'conf'), TMUXLAB_SOCKET: SOCK, TMUXLAB_TOKEN: TOKEN }, stdio: 'pipe',
  });
  await until(async () => fetch(base + '/').then(() => true, () => false));
});
after(async () => {
  srv.kill(); await new Promise((r) => srv.exitCode !== null ? r() : srv.once('exit', r)); // the server may still be writing
  try { execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' }); } catch {}
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

test('paneStatus: agent step lines win over spinner and input box chrome', () => {
  const claude = ['● Read 3 files', '● Running 1 shell command · 47s…', '  ⎿  $ npm test', '✽ Fermenting… (6m 53s · ↓ 30.2k tokens)',
    '  ⎿  Tip: Use /btw to ask a quick side question', '─────────', '❯ ', '─────────', '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt'].join('\n');
  assert.deepEqual(paneStatus(claude), { last: 'Running 1 shell command · 47s…', mode: 'auto mode' });
  assert.deepEqual(paneStatus('$ npm run dev\n\n  VITE v5 ready in 300 ms\n  ➜  Local:   http://localhost:5173/\n\n'), { last: '➜ Local: http://localhost:5173/', mode: '' });
});

test('lists past Claude Code conversations for a folder, newest first, with titles', async () => {
  const proj = path.join(home, 'proj.x'); fs.mkdirSync(proj);
  const dir = path.join(home, '.claude', 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-')); fs.mkdirSync(dir, { recursive: true });
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(path.join(dir, 'aaa-1.jsonl'), line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } })
    + line({ type: 'user', message: { role: 'user', content: 'fix the login bug' } }));
  fs.writeFileSync(path.join(dir, 'bbb-2.jsonl'), line({ type: 'user', message: { role: 'user', content: 'add dark mode' } }) + line({ type: 'ai-title', aiTitle: 'Dark mode' }));
  fs.utimesSync(path.join(dir, 'aaa-1.jsonl'), new Date(), new Date(Date.now() - 60e3));
  const r = await api(`/api/agents/claude/history?cwd=${encodeURIComponent(proj)}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((x) => [x.id, x.title]), [['bbb-2', 'Dark mode'], ['aaa-1', 'fix the login bug']]);
  assert.deepEqual((await api(`/api/agents/codex/history?cwd=${encodeURIComponent(proj)}`)).body, []);
});

test('finds a dev server in a session and opens it through a keyed forwarder', async () => {
  const s = await api('/api/sessions', 'POST', { name: 'web', cwd: home, cmd: `python3 -m http.server ${DEV} --bind 127.0.0.1` });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  await until(async () => (await api('/api/stats')).body.sessions.web?.ports.some((p) => p.port === DEV && p.local));
  assert.equal((await api('/api/ports/1/open', 'POST')).status, 404, 'only ports that sessions listen on');
  const f = (await api(`/api/ports/${DEV}/open`, 'POST')).body;
  const fw = `http://127.0.0.1:${f.port}`;
  assert.equal((await fetch(fw + '/')).status, 401, 'no key, no access');
  const hello = await fetch(`${fw}/?tl=${f.key}`, { redirect: 'manual' });
  assert.equal(hello.status, 302);
  const cookie = hello.headers.get('set-cookie').split(';')[0];
  const page = await fetch(fw + '/', { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Directory listing/);
  assert.equal((await api(`/api/ports/${DEV}/open`, 'POST')).body.port, f.port, 'one forwarder per port');
});

test('alert answer links need a valid one-time token', async () => {
  const r = await fetch(`${base}/api/answer/${'x'.repeat(24)}`, { method: 'POST' });
  assert.equal(r.status, 410);
});

test('a question alert carries one-time answer buttons that work once', async () => {
  const http = await import('node:http');
  const got = [];
  const ntfy = http.createServer((req, res) => { got.push(req.headers); res.end('{}'); });
  await new Promise((r) => ntfy.listen(0, '127.0.0.1', r));
  try {
    const put = await api('/api/config/settings', 'PUT', { ntfy: `http://127.0.0.1:${ntfy.address().port}/t`, base,
      alerts: { prompts: true, quiet: false, finished: false, quietSeconds: 20 }, agents: ['claude'] });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    await api('/api/sessions', 'POST', { name: 'ask', cwd: home, cmd: "printf 'Do you want to proceed?\\n❯ 1. Yes\\n  2. No\\n'; cat" });
    const h = await until(() => got.find((x) => x.actions));
    const links = h.actions.split('; ').map((a) => a.split(', ')[2]);
    assert.equal(links.length, 2);
    assert.ok(links.every((l) => l.startsWith(`${base}/api/answer/`)));
    const first = await fetch(links[1], { method: 'POST' });
    assert.equal(first.status, 200, await first.text());
    assert.equal((await fetch(links[0], { method: 'POST' })).status, 410, 'the other button is spent too');
  } finally { ntfy.close(); }
});

test('devices get their own keys; view links only watch one session; removed keys stop working', async () => {
  const as = (tok) => async (p, method = 'GET', body) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await api('/api/info')).body.auth, 'server');
  const phone = (await api('/api/devices', 'POST', { name: 'Pixel' })).body;
  const P = as(phone.token);
  assert.equal((await P('/api/info')).body.auth, 'device');
  assert.equal((await P('/api/devices')).body.self, phone.id);
  assert.ok(!JSON.stringify((await P('/api/devices')).body).includes('hash'), 'key hashes stay on the server');

  await api('/api/sessions', 'POST', { name: 'seen', cwd: home });
  await api('/api/sessions', 'POST', { name: 'hidden', cwd: home });
  assert.equal((await P('/api/share', 'POST', { session: 'nope', hours: 2 })).status, 404);
  assert.equal((await P('/api/share', 'POST', { session: 'seen', hours: 999 })).status, 400);
  const link = (await P('/api/share', 'POST', { session: 'seen', hours: 2 })).body;
  const V = as(link.token);
  assert.equal((await V('/api/info')).body.role, 'view');
  assert.deepEqual((await V('/api/sessions')).body.map((s) => s.name), ['seen']);
  assert.equal((await V('/api/windows/seen/0/capture')).status, 403);
  assert.equal((await V('/api/sessions', 'POST', { name: 'x', cwd: home })).status, 403);
  const { WebSocket } = await import('ws');
  const ws = (tok, s) => new Promise((res) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${tok}&s=${s}`); w.on('open', () => { w.close(); res('open'); }); w.on('error', () => res('refused')); });
  assert.equal(await ws(link.token, 'hidden'), 'refused');
  assert.equal(await ws(link.token, 'seen'), 'open');

  assert.equal((await api('/api/token/rotate', 'POST')).status, 400, 'a token set by TMUXLAB_TOKEN is not rotated');
  assert.equal((await api(`/api/devices/${phone.id}`, 'DELETE')).status, 200);
  assert.equal((await P('/api/info')).status, 401);
  assert.equal((await V('/api/info')).status, 200, 'other keys keep working');
});

test('after a reboot, sessions come back with their windows, splits and commands', async () => {
  const { again } = await import('../lib/restore.js');
  assert.equal(again({ run: true, cmd: 'claude', tl: 'claude --resume abc-1 --fork-session --permission-mode plan' }), 'claude --permission-mode plan --continue');
  assert.equal(again({ run: true, cmd: 'codex', tl: '' }), 'codex resume --last');
  assert.equal(again({ run: false, cmd: 'bash', tl: 'npm run dev' }), '', 'stopped commands stay stopped');
  const pane = (o) => ({ cwd: home, cmd: 'bash', tl: '', active: false, run: false, ...o });
  fs.writeFileSync(path.join(home, 'conf', 'snapshot.json'), JSON.stringify({ boot: 'an-earlier-boot', at: Date.now() - 3600e3, sessions: [
    { name: 'seen', project: '', windows: [{ index: 0, name: 'x', layout: '', active: true, panes: [pane({ active: true })] }] }, // still running: skipped
    { name: 'back', project: 'work', windows: [
      { index: 0, name: 'agent', layout: '', active: false, panes: [pane({ cmd: 'claude', tl: 'claude --permission-mode plan', run: true, active: true })] },
      { index: 1, name: 'dev', layout: '', active: true, panes: [pane({ cmd: 'python3', tl: 'sleep 300', run: true }), pane({ cwd: '/no/such/dir', active: true })] },
    ] }] }));
  const o = (await api('/api/restore')).body;
  assert.deepEqual(o.sessions.map((s) => [s.name, s.windows, s.run]), [['back', 2, ['claude --permission-mode plan --continue', 'sleep 300']]]);
  assert.deepEqual((await api('/api/restore', 'POST', {})).body, { restored: ['back'] });
  const s = (await api('/api/sessions')).body.find((x) => x.name === 'back');
  assert.equal(s.project, 'work');
  assert.deepEqual(s.windows.map((w) => [w.name, w.panes.length, w.active]), [['agent', 1, false], ['dev', 2, true]]);
  assert.deepEqual(s.windows.flatMap((w) => w.panes.map((p) => p.preset)), ['claude --permission-mode plan --continue', 'sleep 300', '']);
  assert.equal((await api('/api/restore')).body, null, 'offered once');
});

test('output of every session is searchable, and kept after a session ends', async () => {
  await api('/api/sessions', 'POST', { name: 'loud', cwd: home, cmd: 'echo needle-4711 here' });
  const live = await until(async () => (await api('/api/logs/search?q=NEEDLE-4711')).body.find((x) => x.s === 'loud'));
  assert.equal(live.live, true);
  assert.ok(live.hits.some((h) => h.line.includes('needle-4711 here')));
  assert.equal((await api('/api/sessions/loud', 'DELETE')).status, 200);
  const kept = (await api('/api/logs/search?q=needle-4711')).body.find((x) => x.s === 'loud');
  assert.equal(kept.live, false);
  const log = (await api(`/api/logs/${kept.log}`)).body;
  assert.match(log.text, /needle-4711 here/);
  assert.equal((fs.statSync(path.join(home, 'conf', 'logs', kept.log)).mode & 0o777), 0o600);
  assert.equal((await api('/api/logs/..%2Ftoken')).status, 404);
});
