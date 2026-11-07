// Bring sessions back after a reboot. Every 30 s the layout of every session is saved with the machine's boot id;
// when the machine has rebooted and none of those sessions exist, the client offers to recreate them.
import fs from 'node:fs';
import path from 'node:path';
import { CONF, NAME_RE } from './util.js';
import { tmux, listPanes, VIEW_RE, SHELLS, startCmd, setProject } from './tmux.js';

const FILE = path.join(CONF, 'snapshot.json');
const boot = () => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return ''; } };
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };

// what to run again in a pane: agents continue their last conversation, launched commands start again
export function again(p) {
  if (!p.run) return '';
  const tl = p.tl.trim();
  if (p.cmd === 'claude' || /^claude\b/.test(tl)) {
    const base = /^claude\b/.test(tl) ? tl.replace(/\s--(continue|fork-session)\b|\s-c\b|\s(--resume|-r)\s+\S+/g, '') : 'claude';
    return `${base} --continue`;
  }
  if (p.cmd === 'codex' || /^codex\b/.test(tl)) return 'codex resume --last';
  return tl;
}

export async function snapshot() {
  const rows = (await listPanes()).filter((r) => !VIEW_RE.test(r.session_name));
  if (!rows.length) return; // after a reboot the old snapshot is what we want to keep
  const old = load();
  if (old?.sessions?.length && old.boot !== boot() && !old.dismissed) return; // an offer is waiting: don't overwrite it
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.session_name)) map.set(r.session_name, { name: r.session_name, project: r['@tl_project'] || '', windows: [] });
    const s = map.get(r.session_name);
    let w = s.windows.find((x) => x.index === +r.window_index);
    if (!w) s.windows.push(w = { index: +r.window_index, name: r.window_name, layout: r.window_layout, active: r.window_active === '1', panes: [] });
    w.panes.push({ cwd: r.pane_current_path, cmd: r.pane_current_command, tl: r['@tl_cmd'] || '', active: r.pane_active === '1', run: !SHELLS.has(r.pane_current_command) && r.pane_dead !== '1' });
  }
  const snap = { boot: boot(), at: Date.now(), sessions: [...map.values()] };
  fs.mkdirSync(CONF, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(snap)); fs.renameSync(FILE + '.tmp', FILE);
}

// -> { at, sessions: [{name, windows, panes, agents}] } when there is something to offer, else null
export async function offer() {
  const snap = load();
  if (!snap?.sessions?.length || snap.boot === boot() || snap.dismissed) return null;
  const live = new Set((await listPanes()).map((r) => r.session_name));
  const sessions = snap.sessions.filter((s) => !live.has(s.name));
  if (!sessions.length) return null;
  return { at: snap.at, sessions: sessions.map((s) => ({ name: s.name, windows: s.windows.length,
    run: s.windows.flatMap((w) => w.panes.map(again)).filter(Boolean) })) };
}

export function dismiss() { const snap = load(); if (snap) { snap.dismissed = true; fs.writeFileSync(FILE, JSON.stringify(snap)); } }

export async function restore({ run = true } = {}) {
  const snap = load();
  if (!snap?.sessions?.length) return { restored: [] };
  const live = new Set((await listPanes()).map((r) => r.session_name));
  const done = [];
  for (const s of snap.sessions) {
    if (live.has(s.name) || !NAME_RE.test(s.name)) continue;
    const okDir = (d) => (d && fs.existsSync(d) ? d : process.env.HOME);
    let first = true;
    for (const w of s.windows) {
      const p0 = w.panes[0];
      const name = ['-n', w.name || 'shell'];
      const F = ['-P', '-F', '#{window_index} #{pane_id}'];
      const [idx, id0] = (first
        ? await tmux('new-session', '-d', ...F, '-s', s.name, '-c', okDir(p0.cwd), '-x', '200', '-y', '50', ...name)
        : await tmux('new-window', ...F, '-t', `=${s.name}:`, '-c', okDir(p0.cwd), ...name)).trim().split(' ');
      first = false;
      const ids = [id0]; // pane ids, not indexes: pane-base-index may be 1
      for (const p of w.panes.slice(1)) ids.push((await tmux('split-window', '-P', '-F', '#{pane_id}', '-t', ids[0], '-c', okDir(p.cwd))).trim());
      const target = (i) => ids[i];
      if (w.panes.length > 1) await tmux('select-layout', '-t', `=${s.name}:${idx}`, w.layout).catch(() => tmux('select-layout', '-t', `=${s.name}:${idx}`, 'tiled').catch(() => {}));
      for (const [i, p] of w.panes.entries()) {
        const cmd = run ? again(p) : '';
        if (cmd) await startCmd(target(i), cmd);
        else if (p.tl) await tmux('set-option', '-p', '-t', target(i), '@tl_cmd', p.tl); // keeps the Start button
        if (p.active) await tmux('select-pane', '-t', target(i)).catch(() => {});
      }
      if (w.active) await tmux('select-window', '-t', `=${s.name}:${idx}`).catch(() => {});
    }
    if (s.project) await setProject(s.name, s.project).catch(() => {});
    done.push(s.name);
  }
  dismiss();
  return { restored: done };
}
