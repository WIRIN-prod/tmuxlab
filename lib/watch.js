// Background loop: reads every running pane, detects choice prompts, sends phone alerts,
// removes orphaned view sessions and fires scheduled runs.
import crypto from 'node:crypto';
import { tmux, listPanes, detectPrompt, VIEW_RE } from './tmux.js';
import { loadConf } from './util.js';
import { parseCron, cronMatches } from './cron.js';

export const prompts = new Map(); // pane_id -> prompt
export const lastRuns = {};       // schedule id -> ISO time
const state = new Map();          // pane_id -> { hash, changedAt, busy, quietSent, running, cmd }
let onRunSchedule = null;

export async function notify(title, message, { tags = 'computer', priority } = {}) {
  const { ntfy } = loadConf('settings');
  if (!ntfy) return false;
  // ntfy reads these headers; titles must be latin1, so strip anything else
  const r = await fetch(ntfy, { method: 'POST', body: message,
    headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Tags: tags, ...(priority ? { Priority: String(priority) } : {}) } });
  if (!r.ok) throw new Error(`ntfy answered ${r.status}`);
  return true;
}
const alert = (...a) => notify(...a).catch((e) => console.error('alert failed:', e.message));

async function tick() {
  const rows = await listPanes();
  const settings = loadConf('settings');
  const agents = new Set(settings.agents);
  const now = Date.now();
  const seen = new Set();
  for (const r of rows) {
    if (VIEW_RE.test(r.session_name)) continue;
    const id = r.pane_id;
    if (seen.has(id)) continue; seen.add(id);
    const running = !['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'login', 'tmux'].includes(r.pane_current_command) && r.pane_dead !== '1';
    const where = `${r.session_name}:${r.window_index}`;
    const st = state.get(id) || { hash: '', changedAt: now, busy: false, quietSent: true, running, cmd: r.pane_current_command };
    if (st.running && !running && (r['@tl_cmd'] || agents.has(st.cmd)) && settings.alerts.finished) {
      alert(`${where} finished`, `${st.cmd} exited`, { tags: 'white_check_mark' });
    }
    if (running) {
      // visible screen only: after a clear, tmux keeps the old menu in history
      const text = await tmux('capture-pane', '-p', '-t', id).catch(() => '');
      const hash = crypto.createHash('sha1').update(text).digest('hex');
      if (hash !== st.hash) {
        if (st.hash) { st.busy = true; st.quietSent = false; }
        st.hash = hash; st.changedAt = now;
      }
      const p = detectPrompt(text);
      const before = prompts.get(id);
      if (p) {
        prompts.set(id, p);
        if (settings.alerts.prompts && before?.question !== p.question) {
          alert(`${where} needs you`, `${r.pane_current_command}: ${p.question}\n${p.options.map((o) => `${o.n}. ${o.label}`).join('\n')}`, { tags: 'warning', priority: 4 });
        }
      } else prompts.delete(id);
      const quietFor = (now - st.changedAt) / 1000;
      if (!p && agents.has(r.pane_current_command) && st.busy && !st.quietSent && quietFor >= settings.alerts.quietSeconds) {
        st.quietSent = true; st.busy = false;
        if (settings.alerts.quiet) alert(`${where} is waiting`, `${r.pane_current_command} stopped producing output ${Math.round(quietFor)}s ago`, { tags: 'hourglass' });
      }
    } else { prompts.delete(id); st.hash = ''; st.busy = false; }
    st.running = running; st.cmd = r.pane_current_command;
    state.set(id, st);
  }
  for (const id of state.keys()) if (!seen.has(id)) { state.delete(id); prompts.delete(id); }
  // views whose terminal went away (e.g. the server restarted mid-connection)
  const views = new Map();
  for (const r of rows) if (VIEW_RE.test(r.session_name)) views.set(r.session_name, r);
  for (const [name, r] of views) {
    if (r.session_attached === '0' && now / 1000 - +r.session_created > 20) await tmux('kill-session', '-t', `=${name}:`).catch(() => {});
  }
}

let lastMinute = -1;
async function scheduleTick() {
  const d = new Date();
  const m = Math.floor(d.getTime() / 60000);
  if (m === lastMinute) return;
  lastMinute = m;
  for (const s of loadConf('schedules')) {
    if (!s.enabled) continue;
    let c; try { c = parseCron(s.cron); } catch { continue; }
    if (cronMatches(c, d)) onRunSchedule(s).catch((e) => console.error(`schedule ${s.id} failed:`, e.message));
  }
}

export function startWatcher(runSchedule) {
  onRunSchedule = runSchedule;
  let busy = false;
  setInterval(async () => {
    if (busy) return; busy = true;
    try { await tick(); await scheduleTick(); } catch (e) { console.error('watch:', e.message); } finally { busy = false; }
  }, 2000).unref();
}

