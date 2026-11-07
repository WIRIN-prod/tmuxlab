// Output history: every minute the last lines of each pane are saved (when they changed), so output can be
// searched across all sessions and read after a session ends or the machine restarts. Kept 7 days, owner-only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONF } from './util.js';
import { tmux, listPanes, VIEW_RE } from './tmux.js';

const DIR = path.join(CONF, 'logs');
const KEEP = 7 * 86400e3, LINES = 5000;
const seen = new Map(); // file -> hash of what was last written
const fileOf = (r) => `${r.session_name}.${r.window_index}.${r.pane_index}.log`;
const capture = (id) => tmux('capture-pane', '-p', '-J', '-t', id, '-S', `-${LINES}`).then((t) => t.replace(/\s+$/, ''), () => '');

export async function saveLogs(only) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  for (const r of (await listPanes()).filter((x) => !VIEW_RE.test(x.session_name) && (!only || x.session_name === only))) {
    const text = await capture(r.pane_id);
    if (!text.trim()) continue;
    const f = fileOf(r), h = crypto.createHash('sha1').update(text).digest('hex');
    if (seen.get(f) === h) continue;
    seen.set(f, h);
    const head = JSON.stringify({ s: r.session_name, w: +r.window_index, p: +r.pane_index, name: r.window_name, cwd: r.pane_current_path });
    fs.writeFileSync(path.join(DIR, f), `${head}\n${text}\n`, { mode: 0o600 });
  }
  if (only) return;
  for (const f of fs.readdirSync(DIR)) {
    const st = fs.statSync(path.join(DIR, f), { throwIfNoEntry: false });
    if (st && Date.now() - st.mtimeMs > KEEP) fs.rmSync(path.join(DIR, f), { force: true });
  }
}

const read = (f) => {
  const raw = fs.readFileSync(path.join(DIR, f), 'utf8'), nl = raw.indexOf('\n');
  try { return { meta: JSON.parse(raw.slice(0, nl)), text: raw.slice(nl + 1), at: fs.statSync(path.join(DIR, f)).mtimeMs }; } catch { return null; }
};

// live panes are searched live; saved logs only for panes that no longer exist
export async function search(q, max = 200) {
  q = String(q || '').toLowerCase().trim();
  if (q.length < 2) return [];
  const live = (await listPanes()).filter((x) => !VIEW_RE.test(x.session_name));
  const liveFiles = new Set(live.map(fileOf));
  const sources = await Promise.all(live.map(async (r) => ({ s: r.session_name, w: +r.window_index, p: +r.pane_index, name: r.window_name, live: true, text: await capture(r.pane_id) })));
  for (const f of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
    if (liveFiles.has(f) || !f.endsWith('.log')) continue;
    const l = read(f); if (l) sources.push({ ...l.meta, live: false, at: l.at, log: f, text: l.text });
  }
  const out = [];
  for (const src of sources) {
    const lines = src.text.split('\n'), hits = [];
    lines.forEach((ln, i) => { if (hits.length < 20 && ln.toLowerCase().includes(q)) hits.push({ n: i, line: ln.slice(0, 300) }); });
    if (hits.length) { const { text, ...rest } = src; out.push({ ...rest, total: lines.length, hits }); }
    if (out.length >= max) break;
  }
  return out.sort((a, b) => b.live - a.live || (b.at || 0) - (a.at || 0));
}

export function readLog(f) {
  if (!/^[\w.-]+\.\d+\.\d+\.log$/.test(f) || !fs.existsSync(path.join(DIR, f))) return null;
  return read(f);
}
