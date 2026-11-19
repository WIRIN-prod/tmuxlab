// Agent notifications and the combined agent list across every saved machine.
// The current machine is read by wall.js (refresh); the others are polled here, so a question on any machine reaches you.
import { S, store, api, act, W, toast, saveMachines, cfg } from './core.js';

export const remote = new Map(); // machine base -> { sessions, at, err }
const prev = new Map();          // `${base}|${session}:${window}.${pane}` -> last agent state
const primed = new Set();        // machines already read once: what was waiting before we looked is not news
const LABEL = { blocked: 'needs you', done: 'finished' };
const name = (m) => m.name || new URL(m.base).host;

// go to an agent wherever it runs: switch machine first when it is another one
export async function jumpTo(m, session, w, p) {
  const { start } = await import('./main.js');
  const { openTerm } = await import('./term.js');
  if (S.machines.indexOf(m) !== S.cur) { S.cur = S.machines.indexOf(m); saveMachines(); await start(); }
  if (p != null) await act(`${W(session, `${w}.${p}`)}/select`).catch(() => {});
  openTerm(session, w);
}

// a short two-tone beep, no audio file: it is only an attention sound
let ac = null;
function beep(kind) {
  try {
    ac ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = ac.currentTime, g = ac.createGain(); g.connect(ac.destination);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    for (const [i, f] of (kind === 'blocked' ? [880, 660] : [660, 880]).entries()) {
      const o = ac.createOscillator(); o.frequency.value = f; o.connect(g); o.start(t + i * 0.14); o.stop(t + i * 0.14 + 0.12);
    }
  } catch {}
}

const native = () => window.TmuxlabNative?.notify ? window.TmuxlabNative : null; // the Android app has no Notification API
export const canNotify = () => !!native() || typeof Notification !== 'undefined';
// the settings switch asks for permission the moment it is turned on (browsers only allow that from a click)
export async function allowSystemNotifications() {
  if (!canNotify()) return false;
  if (native()) { native().askNotify(); return true; }
  if (Notification.permission === 'default') await Notification.requestPermission().catch(() => {});
  return Notification.permission === 'granted';
}

async function announce(m, s, w, p, state) {
  if (!store.get('notify', true)) return;
  const a = p.agent, multi = S.machines.length > 1;
  const { T } = await import('./term.js');
  const looking = !document.hidden && document.hasFocus() && S.machines.indexOf(m) === S.cur && !document.querySelector('#term')?.hidden && T.panes.some((x) => x.s === s.name);
  if (looking) return; // you are already reading it
  const title = `${a.agent} ${s.name}${multi ? ` · ${name(m)}` : ''}`;
  const body = (p.prompt?.question || p.status?.last || '').slice(0, 140);
  const run = () => jumpTo(m, s.name, w.index, p.index);
  toast(body || LABEL[state], false, { title: `${title} ${LABEL[state]}`, kind: state === 'blocked' ? 'ask' : 'done', action: 'Open', run });
  if (store.get('notifySound', true)) beep(state);
  const away = document.hidden || !document.hasFocus();
  if (native() && away) native().notify(`${title} ${LABEL[state]}`, body || LABEL[state], `${m.base}|${s.name}:${w.index}.${p.index}`);
  else if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && away) {
    const n = new Notification(`${title} ${LABEL[state]}`, { body, tag: `${m.base}|${s.name}:${w.index}.${p.index}`, silent: true });
    n.onclick = () => { window.focus(); n.close(); run(); };
  }
}

// feed a machine's session list in; notifies on a change to "needs you", or from working to finished
export function watchStates(m, sessions) {
  const first = !primed.has(m.base); primed.add(m.base);
  const live = new Set();
  for (const s of sessions) for (const w of s.windows) for (const p of w.panes || []) {
    if (!p.agent) continue;
    const k = `${m.base}|${s.name}:${w.index}.${p.index}`, was = prev.get(k), now = p.agent.state;
    live.add(k); prev.set(k, now);
    if (first || was === undefined || was === now) continue;
    if (now === 'blocked' || (was === 'working' && (now === 'done' || now === 'idle'))) announce(m, s, w, p, now === 'blocked' ? 'blocked' : 'done');
  }
  for (const k of prev.keys()) if (k.startsWith(m.base + '|') && !live.has(k)) prev.delete(k);
}

// every agent on every machine, in a fixed order (machine, then session): the list must not jump around
export function allAgents() {
  const out = [];
  S.machines.forEach((m, i) => {
    const sessions = i === S.cur ? S.sessions : remote.get(m.base)?.sessions || [];
    for (const s of sessions) for (const w of s.windows) for (const p of w.panes || []) if (p.agent) out.push({ m, i, s, w, p, ...p.agent });
  });
  return out.sort((a, b) => a.i - b.i || (+!!b.p.pinned) - (+!!a.p.pinned) || a.s.name.localeCompare(b.s.name) || a.w.index - b.w.index || a.p.index - b.p.index);
}

// the other machines: read every few seconds, so their questions reach you too
async function pollOthers() {
  if (document.hidden || S.machines.length < 2 || S.watch) return;
  await Promise.all(S.machines.map(async (m, i) => {
    if (i === S.cur) return;
    try { const sessions = await api('/api/sessions', { m, timeout: 5000 }); remote.set(m.base, { sessions, at: Date.now() }); watchStates(m, sessions); }
    catch { remote.set(m.base, { sessions: [], err: true, at: Date.now() }); }
  }));
  document.dispatchEvent(new CustomEvent('tl-remote'));
}
setInterval(pollOthers, 6000);
setTimeout(pollOthers, 1500);
export { cfg };
