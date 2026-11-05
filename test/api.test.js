// End-to-end: real server, real tmux on a private socket (never touches your sessions).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxlab-test-'));
const SOCK = `tmuxlab-test-${process.pid}`;
const PORT = 17000 + (process.pid % 1000);
const TOKEN = 'test-token-0123456789';
const base = `http://127.0.0.1:${PORT}`;
let srv;

const api = async (p, method = 'GET', body, token = TOKEN) => {
  const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await wait(100); }
}

before(async () => {
  srv = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', TMUXLAB_HOME: home, TMUXLAB_SOCKET: SOCK, TMUXLAB_TOKEN: TOKEN }, stdio: 'pipe',
  });
  await until(async () => fetch(base + '/').then(() => true, () => false));
});
after(() => {
  srv.kill();
  try { execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' }); } catch {}
  fs.rmSync(home, { recursive: true, force: true });
});

test('rejects missing or wrong token', async () => {
  assert.equal((await api('/api/sessions', 'GET', undefined, 'nope')).status, 401);
  assert.equal((await api('/api/sessions', 'GET', undefined, '')).status, 401);
});

test('serves the app and blocks path traversal', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/vendor/xterm.js')).status, 200);
  assert.equal((await fetch(base + '/..%2fserver.js')).status, 404);
});

test('empty list with no tmux server', async () => {
  assert.deepEqual((await api('/api/sessions')).body, []);
});

test('session lifecycle: create with command, window, keys, stop/start, kill', async () => {
  let r = await api('/api/sessions', 'POST', { name: 'job', cwd: home, cmd: 'sleep 30', label: 'sleeper' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const w = r.body.window;

  const running = await until(async () => {
    const s = (await api('/api/sessions')).body.find((x) => x.name === 'job');
    return s?.windows[0].running && s;
  });
  assert.equal(running.windows[0].cmd, 'sleep');
  assert.equal(running.windows[0].preset, 'sleep 30');
  assert.equal(running.windows[0].name, 'sleeper');

  assert.equal((await api(`/api/windows/job/${w}/stop`, 'POST')).status, 200);
  await until(async () => !(await api('/api/sessions')).body[0].windows[0].running);

  assert.equal((await api(`/api/windows/job/${w}/start`, 'POST')).status, 200);
  await until(async () => (await api('/api/sessions')).body[0].windows[0].running);
  await api(`/api/windows/job/${w}/stop`, 'POST');

  r = await api('/api/sessions/job/windows', 'POST', { preset: 'shell' });
  assert.equal(r.status, 200);
  await api(`/api/windows/job/${r.body.window}/keys`, 'POST', { text: 'echo hello-$((40+2))', keys: ['Enter'] });
  const cap = await until(async () => {
    const t = (await api(`/api/windows/job/${r.body.window}/capture`)).body.text;
    return t.includes('hello-42') && t;
  });
  assert.match(cap, /hello-42/);

  assert.equal((await api(`/api/windows/job/${r.body.window}/scroll`, 'POST', { dir: 'up', lines: 3 })).status, 200);
  assert.ok((await api('/api/sessions')).body[0].windows.find((x) => x.index === r.body.window).inMode);

  assert.equal((await api('/api/sessions/job/rename', 'POST', { to: 'job2' })).status, 200);
  assert.equal((await api('/api/sessions/job2', 'DELETE')).status, 200);
  assert.deepEqual((await api('/api/sessions')).body, []);
});

test('validates names, keys and directories', async () => {
  assert.equal((await api('/api/sessions', 'POST', { name: 'bad name;rm' })).status, 400);
  assert.equal((await api('/api/sessions', 'POST', { name: 'ok', cwd: '/definitely/not/here' })).status, 400);
  await api('/api/sessions', 'POST', { name: 'v' });
  assert.equal((await api('/api/windows/v/0/keys', 'POST', { keys: ['C-c; kill-server'] })).status, 400);
  assert.equal((await api('/api/windows/v/abc/keys', 'POST', {})).status, 404);
  await api('/api/sessions/v', 'DELETE');
});

test('presets round-trip and reject bad input', async () => {
  const p = [{ id: 'x', label: 'X', cmd: 'echo x' }];
  assert.equal((await api('/api/presets', 'PUT', [{ id: 'bad id', label: 'X', cmd: '' }])).status, 400);
  assert.deepEqual((await api('/api/presets', 'PUT', p)).body, p);
  assert.deepEqual((await api('/api/presets')).body, p);
});

test('websocket terminal: auth, output, input', async () => {
  await api('/api/sessions', 'POST', { name: 'ws', cwd: home });
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws?s=ws&token=wrong`);
  await new Promise((res) => { bad.on('error', res); bad.on('close', res); });

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?s=ws&token=${TOKEN}&cols=100&rows=30`);
  let out = '';
  ws.on('message', (d) => { out += d.toString(); });
  await new Promise((r) => ws.on('open', r));
  ws.send('\x00' + JSON.stringify({ t: 'resize', cols: 90, rows: 25 }));
  ws.send('echo ws-$((6*7))\r');
  await until(() => out.includes('ws-42'));
  const s = (await api('/api/sessions')).body.find((x) => x.name === 'ws');
  assert.equal(s.attached, 1);
  ws.close();
  await api('/api/sessions/ws', 'DELETE');
});
