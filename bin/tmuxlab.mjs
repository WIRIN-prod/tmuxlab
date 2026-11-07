#!/usr/bin/env node
// tmuxlab: lets agents (and you) work with the other terminals: list agents, open a pane, send a prompt,
// read output, wait for an agent to finish. Pane ops go straight to tmux; agent states come from the server.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONF } from '../lib/util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const rest = () => { const i = args.indexOf('--'); return i < 0 ? [] : args.splice(i).slice(1); };
const die = (msg, code = 1) => { console.error(`tmuxlab: ${msg}`); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the server's tmux socket when it isn't the default one (inside a pane, $TMUX already points there)
const SOCK = process.env.TMUXLAB_SOCKET ? ['-L', process.env.TMUXLAB_SOCKET] : [];
const tmux = (...a) => { try { return execFileSync('tmux', [...SOCK, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { die((e.stderr || e.message).trim()); } };
// an empty or flag-like name would make tmux pick the current pane: a prompt meant for another agent would land in yours
const paneId = (t) => /^(%\d+|[\w.-]+:\d+(\.\d+)?)$/.test(t || '') ? tmux('display-message', '-p', '-t', t, '#{pane_id}').trim() : die(`"${t || ''}" isn't a pane: use an id like %3 or session:window.pane like api:0.1`);
const here = () => process.env.TMUX_PANE || die('not inside a tmux pane; name one, e.g. %3 or api:0.1');

const BASE = process.env.TMUXLAB_URL || `http://127.0.0.1:${process.env.PORT || 7681}`;
const token = () => process.env.TMUXLAB_TOKEN || (() => { try { return fs.readFileSync(path.join(CONF, 'token'), 'utf8').trim(); } catch { return die(`no server token in ${CONF}; is tmuxlab set up for this user?`); } })();
async function api(p, body) {
  let r;
  try { r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); }
  catch { die(`the tmuxlab server isn't answering at ${BASE} (set TMUXLAB_URL)`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) die(j.error || `server answered ${r.status}`);
  return j;
}
const allPanes = async () => (await api('/api/sessions')).flatMap((s) => s.windows.flatMap((w) => w.panes.map((p) => ({
  pane: p.id, target: `${s.name}:${w.index}.${p.index}`, cmd: p.cmd, cwd: p.cwd, agent: p.agent?.agent || null, state: p.agent?.state || (p.running ? 'running' : 'shell'),
  question: p.prompt?.question || null, last: p.status?.last || '' }))));

// type text into a pane; several lines go in as one paste, so an agent reads one prompt
function send(t, text, enter = true) {
  tmux('send-keys', '-t', t, '-l', text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
  if (enter) { execFileSync('sleep', ['0.15']); tmux('send-keys', '-t', t, 'Enter'); }
}

const HELP = `tmuxlab: work with the other terminals on this machine

  tmuxlab agents [--json]                  every agent: pane, state (working, blocked, done, idle), last step
  tmuxlab panes [--json]                   every pane
  tmuxlab split [--down] [--cwd DIR] [-- CMD...]
                                           open a pane beside this one (and run CMD); prints its pane id
  tmuxlab new NAME [--cwd DIR] [-- CMD...] start a session (and run CMD); prints its pane id
  tmuxlab send PANE TEXT [--no-enter]      type TEXT into PANE and press Enter (a prompt for an agent)
  tmuxlab read PANE [--lines N]            the last N lines PANE printed (default 50)
  tmuxlab wait PANE [--until done|blocked|idle] [--timeout SEC]
                                           wait for the agent in PANE; exit 0 when reached,
                                           2 if it is blocked on a question instead, 124 on timeout
  tmuxlab notify TITLE [MESSAGE]           send a phone alert (Settings › Phone alerts)
  tmuxlab skill [--install]                print the agent skill, or install it for Claude Code

PANE is a pane id like %12 (see "tmuxlab agents") or session:window.pane, e.g. api:0.1.`;

const table = (rows) => rows.map((r) => [r.pane.padEnd(5), (r.agent || r.cmd).padEnd(10), r.state.padEnd(8), r.target.padEnd(16), r.question ? `asks: ${r.question}` : r.last].join(' ')).join('\n');

switch (cmd) {
  case 'agents': case 'panes': {
    const all = await allPanes(), list = cmd === 'agents' ? all.filter((p) => p.agent) : all;
    console.log(has('--json') ? JSON.stringify(list, null, 2) : list.length ? table(list) : cmd === 'agents' ? 'No agents are running.' : 'No panes.');
    break;
  }
  case 'split': {
    const down = has('--down'), cwd = flag('--cwd'), run = rest().join(' ');
    const id = tmux('split-window', '-d', down ? '-v' : '-h', '-P', '-F', '#{pane_id}', '-t', here(), ...(cwd ? ['-c', path.resolve(cwd)] : [])).trim();
    if (run) { tmux('set-option', '-p', '-t', id, '@tl_cmd', run); send(id, run); }
    console.log(id);
    break;
  }
  case 'new': {
    const name = args.shift() || die('give the session a name'), cwd = flag('--cwd', process.cwd()), run = rest().join(' ');
    const r = await api('/api/sessions', { name, cwd: path.resolve(cwd), ...(run && { cmd: run }) });
    console.log(tmux('list-panes', '-t', `=${r.name}:`, '-F', '#{pane_id}').split('\n')[0]);
    break;
  }
  case 'send': {
    const t = args.shift() || die('which pane? e.g. tmuxlab send %3 "run the tests"'), enter = !has('--no-enter');
    const text = args.join(' ') || (process.stdin.isTTY ? die('nothing to send') : fs.readFileSync(0, 'utf8').replace(/\n$/, ''));
    send(paneId(t), text, enter);
    break;
  }
  case 'read': {
    const t = args.shift() || die('which pane?'), n = Math.max(1, +flag('--lines', 50) || 50);
    process.stdout.write(tmux('capture-pane', '-p', '-J', '-t', paneId(t), '-S', `-${n}`).replace(/\s+$/, '').split('\n').slice(-n).join('\n') + '\n');
    break;
  }
  case 'wait': {
    const id = args[0] && !args[0].startsWith('-') ? paneId(args.shift()) : here(), until = flag('--until', 'done'), timeout = +flag('--timeout', 1800) * 1000;
    if (!['done', 'blocked', 'idle'].includes(until)) die('--until takes done, blocked or idle');
    const t0 = Date.now(); let worked = false;
    for (;;) {
      const p = (await allPanes()).find((x) => x.pane === id) || die(`pane ${id} is gone`);
      if (!p.agent) die(`no agent is running in ${id}`);
      if (p.state === 'working') worked = true;
      if (p.state === until) break;
      if (until !== 'blocked' && p.state === 'blocked') { console.log(`blocked: ${p.question || p.last}`); process.exit(2); }
      // "done" right after a prompt: give the agent a moment to start before taking "idle" as finished
      if (until === 'done' && p.state === 'idle' && (worked || Date.now() - t0 > 15000)) break;
      if (Date.now() - t0 > timeout) die('timed out', 124);
      await sleep(1500);
    }
    console.log(until);
    break;
  }
  case 'notify': {
    await api('/api/notify', { title: args.shift() || die('give a title'), message: args.join(' ') });
    break;
  }
  case 'skill': {
    const skill = fs.readFileSync(path.join(HERE, '../skills/tmuxlab/SKILL.md'), 'utf8');
    if (!has('--install')) { process.stdout.write(skill); break; }
    const dir = path.join(process.env.HOME, '.claude/skills/tmuxlab');
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), skill);
    console.log(`Installed for Claude Code: ${dir}/SKILL.md`);
    break;
  }
  case undefined: case 'help': case '-h': case '--help': console.log(HELP); break;
  default: die(`unknown command "${cmd}"\n\n${HELP}`);
}
