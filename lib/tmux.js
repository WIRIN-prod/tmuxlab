import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { httpErr, NAME_RE, sleep } from './util.js';

const run = promisify(execFile);
export const TMUX = process.env.TMUXLAB_TMUX || 'tmux';
export const SOCK = process.env.TMUXLAB_SOCKET ? ['-L', process.env.TMUXLAB_SOCKET] : []; // separate tmux server, e.g. for tests
export const tmux = async (...args) => (await run(TMUX, [...SOCK, ...args], { maxBuffer: 8 << 20 })).stdout;

// A "view" is a grouped session (shares windows with its parent, keeps its own current window),
// created per connected terminal so each device can look at a different window.
export const VIEW_RE = /^([\w.-]{1,64})~tl[a-z0-9]{1,12}$/;
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'login', 'tmux']);

export const sess = (n) => { if (!NAME_RE.test(n) && !VIEW_RE.test(n)) throw httpErr(400, 'bad session name'); return n; };
// window target, optionally with a pane: "2" or "2.1"
export const tgt = (s, w) => { if (!/^\d{1,4}(\.\d{1,3})?$/.test(String(w))) throw httpErr(400, 'bad window'); return `=${sess(s)}:${w}`; };

const F = ['session_name', 'session_attached', 'session_created', 'session_activity', 'window_index', 'window_name',
  'window_active', 'window_activity', 'window_bell_flag', 'window_zoomed_flag', 'synchronize-panes', 'pane_index', 'pane_active',
  'pane_id', 'pane_current_command', 'pane_current_path', 'pane_dead', 'pane_in_mode', 'pane_pid', '@tl_cmd', 'pane_width', 'pane_height', '@tl_project'];
const FMT = F.map((f) => `#{${f}}`).join('\t');

export async function listPanes() {
  let out;
  try { out = await tmux('list-panes', '-a', '-F', FMT); } catch (e) {
    if (/no server running|error connecting|No such file/i.test(e.stderr || '')) return [];
    throw e;
  }
  return out.split('\n').filter(Boolean).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [F[i], v])));
}

// sessions -> windows -> panes; extra per-pane data (prompt, branch) is merged in by the caller
export function shape(rows, extra = () => ({})) {
  const map = new Map(), views = [];
  for (const r of rows) {
    const vm = r.session_name.match(VIEW_RE);
    if (vm) { views.push({ name: r.session_name, parent: vm[1], attached: +r.session_attached, created: +r.session_created, w: +r.window_index, active: r.window_active === '1' }); continue; }
    if (!map.has(r.session_name)) map.set(r.session_name, { name: r.session_name, attached: +r.session_attached, created: +r.session_created, activity: +r.session_activity,
      project: r['@tl_project'] || '', windows: [], views: {} });
    const s = map.get(r.session_name);
    let w = s.windows.find((x) => x.index === +r.window_index);
    if (!w) s.windows.push(w = { index: +r.window_index, name: r.window_name, active: r.window_active === '1', activity: +r.window_activity,
      bell: r.window_bell_flag === '1', zoomed: r.window_zoomed_flag === '1', sync: r['synchronize-panes'] === '1', panes: [] });
    const dead = r.pane_dead === '1';
    w.panes.push({ index: +r.pane_index, id: r.pane_id, active: r.pane_active === '1', cmd: r.pane_current_command, cwd: r.pane_current_path,
      dead, inMode: r.pane_in_mode === '1', pid: +r.pane_pid, preset: r['@tl_cmd'] || '', running: !SHELLS.has(r.pane_current_command) && !dead,
      width: +r.pane_width, height: +r.pane_height, ...extra(r) });
  }
  for (const s of map.values()) for (const w of s.windows) {
    const p = w.panes.find((x) => x.active) || w.panes[0];
    // window-level fields mirror the active pane, so simple clients can ignore panes
    Object.assign(w, { cmd: p.cmd, cwd: p.cwd, dead: p.dead, inMode: p.inMode, preset: p.preset, branch: p.branch, repo: p.repo, wt: p.wt,
      running: w.panes.some((x) => x.running), prompt: w.panes.find((x) => x.prompt)?.prompt || null });
  }
  const counted = new Set(); // view rows repeat once per pane
  for (const v of views) {
    const s = map.get(v.parent); if (!s) continue;
    if (v.active) s.views[v.name] = v.w;
    if (!counted.has(v.name)) { counted.add(v.name); s.attached += v.attached; }
  }
  return { list: [...map.values()].sort((a, b) => b.activity - a.activity), views };
}

export async function setProject(s, id) {
  if (id && !NAME_RE.test(id)) throw httpErr(400, 'bad project');
  await tmux('set-option', '-t', `=${sess(s)}:`, ...(id ? ['@tl_project', id] : ['-u', '@tl_project']));
}

export async function startCmd(target, cmd) {
  await tmux('set-option', '-p', '-t', target, '@tl_cmd', cmd);
  if (cmd) { await tmux('send-keys', '-t', target, '-l', cmd); await tmux('send-keys', '-t', target, 'Enter'); }
}

export async function storedCmd(target) {
  return (await tmux('show-options', '-pqv', '-t', target, '@tl_cmd')).trim() ||
    (await tmux('show-options', '-wqv', '-t', target, '@tl_cmd')).trim(); // windows made by tmuxlab 1.0
}

export async function interrupt(target) {
  await tmux('send-keys', '-t', target, 'C-c'); await sleep(250); await tmux('send-keys', '-t', target, 'C-c');
}

export async function killViews(parent) {
  for (const l of (await tmux('list-sessions', '-F', '#{session_name}').catch(() => '')).split('\n')) {
    if (l.match(VIEW_RE)?.[1] === parent) await tmux('kill-session', '-t', `=${l}:`).catch(() => {});
  }
}

// Finds an arrow-key choice menu at the bottom of a screen, e.g. Claude Code's
//   Do you want to proceed?
//   ❯ 1. Yes
//     2. Yes, and don't ask again
//     3. No, and tell Claude what to do differently (esc)
export function detectPrompt(text) {
  const lines = text.replace(/\s+$/, '').split('\n');
  const tail = lines.slice(-25);
  const strip = (l) => l.replace(/^[\s│┃|╭╰]+|[\s│┃|╮╯]+$/g, '');
  let opts = [], sel = -1, firstIdx = -1;
  for (let i = 0; i < tail.length; i++) {
    const m = strip(tail[i]).match(/^([❯›>▶➜→*]\s*)?(\d{1,2})[.)]\s+(.+)$/);
    if (m && +m[2] === (opts.length ? opts.at(-1).n + 1 : 1)) {
      if (!opts.length) firstIdx = i;
      opts.push({ n: +m[2], label: m[3].trim() });
      if (m[1]) sel = +m[2];
    } else if (m && +m[2] === 1) {
      opts = [{ n: 1, label: m[3].trim() }]; firstIdx = i; sel = m[1] ? 1 : -1;
    } else if (opts.length && strip(tail[i]) && !/^[─━-]+$/.test(strip(tail[i])) && i - firstIdx > opts.length + 6) {
      break; // a long run of other text after the list: it is not a menu at the bottom
    }
  }
  if (opts.length < 2 || sel < 0) return null;
  // menus sit at the bottom: allow a border and a short footer ("Esc to cancel") after the options
  const lastOpt = firstIdx + tail.slice(firstIdx).findIndex((l) => strip(l).match(new RegExp(`^([❯›>▶➜→*]\\s*)?${opts.at(-1).n}[.)]\\s`)));
  if (tail.slice(lastOpt + 1).filter((l) => strip(l) && !/^[─━-]+$/.test(strip(l))).length > 3) return null;
  // the question is the closest line above the list that ends in "?" (or ":")
  let question = '';
  for (let i = firstIdx - 1; i >= Math.max(0, firstIdx - 8); i--) {
    const l = strip(tail[i]);
    if (/[?:]$/.test(l)) { question = l; break; }
  }
  if (!question) return null;
  return { question, options: opts, selected: sel };
}

// One line saying what a running program is doing, for the sessions list. Agents mark their
// steps with a bullet (Claude ●, Codex •); otherwise take the lowest line that isn't input box or footer chrome.
const CHROME = /^[\s─━═╌-]*$|^[❯›>]\s|^[❯›>]$|shift\+tab|for shortcuts|esc to interrupt|^⎿\s+Tip|Update installed|ctrl\+b ctrl\+b|^\? |context left|send\s+⏎/i;
export function paneStatus(text) {
  const lines = text.replace(/\s+$/, '').split('\n').slice(-40).map((l) => l.replace(/^[\s│┃|╭╰]+|[\s│┃|╮╯]+$/g, ''));
  const mode = lines.slice(-4).join(' ').match(/⏵⏵\s*([a-z][a-z ]+?) on\b/i)?.[1] || (/plan mode on/i.test(lines.slice(-4).join(' ')) ? 'plan mode' : '');
  let last = '';
  for (let i = lines.length - 1; i >= 0 && !last; i--) if (/^[●•⏺]\s+\S/.test(lines[i])) last = lines[i].replace(/^[●•⏺]\s+/, '');
  for (let i = lines.length - 1; i >= 0 && !last; i--) if (!CHROME.test(lines[i])) last = lines[i];
  return { last: last.replace(/\s+/g, ' ').slice(0, 140), mode };
}

// answer an arrow-key menu: move from the selected option to n, then Enter
export async function choose(t, n, question) {
  const p = detectPrompt(await tmux('capture-pane', '-p', '-J', '-t', t));
  if (!p || (question && p.question !== question)) throw httpErr(409, 'no question on screen any more');
  if (!p.options.some((o) => o.n === n)) throw httpErr(400, 'no such option');
  for (let i = 0; i < Math.abs(n - p.selected); i++) await tmux('send-keys', '-t', t, n > p.selected ? 'Down' : 'Up');
  await sleep(80); await tmux('send-keys', '-t', t, 'Enter');
}
