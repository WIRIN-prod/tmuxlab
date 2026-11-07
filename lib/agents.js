// Past Claude Code and Codex conversations for a folder, so the app can offer "resume this one".
// Both CLIs keep transcripts as JSONL under the home directory; we only peek at the ends of each file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const CHUNK = 128 * 1024;

function peek(file, fromEnd) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(CHUNK, size), b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, fromEnd ? size - n : 0);
    return b.toString('utf8');
  } finally { fs.closeSync(fd); }
}
const lastMatch = (text, re) => { let m, last = null; for (const x of text.matchAll(re)) last = x; return last && (m = JSON.parse(`"${last[1]}"`)) ? m : ''; };
const clip = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 140);

// Claude Code: ~/.claude/projects/<cwd with every non-alphanumeric as "-">/<session id>.jsonl
export function claudeHistory(cwd, limit = 30) {
  const dir = path.join(HOME, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  let files; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  return files.map((f) => ({ f: path.join(dir, f), id: f.slice(0, -6) }))
    .map((x) => ({ ...x, mtime: fs.statSync(x.f).mtimeMs })).sort((a, b) => b.mtime - a.mtime).slice(0, limit)
    .map(({ f, id, mtime }) => {
      const head = peek(f, false), tail = peek(f, true), both = head + '\n' + tail;
      const title = lastMatch(both, /"customTitle":"((?:[^"\\]|\\.)*)"/g) || lastMatch(both, /"aiTitle":"((?:[^"\\]|\\.)*)"/g);
      let first = '';
      for (const m of head.matchAll(/"type":"user","message":\{"role":"user","content":"((?:[^"\\]|\\.)*)"/g)) {
        const t = JSON.parse(`"${m[1]}"`); if (!t.startsWith('<')) { first = t; break; }
      }
      return { id, title: clip(title || first), first: clip(first), when: new Date(mtime).toISOString() };
    }).filter((x) => x.title);
}

// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, names in ~/.codex/session_index.jsonl
export function codexHistory(cwd, limit = 30) {
  const root = path.join(HOME, '.codex', 'sessions');
  const names = new Map();
  try {
    for (const l of fs.readFileSync(path.join(HOME, '.codex', 'session_index.jsonl'), 'utf8').split('\n')) {
      try { const o = JSON.parse(l); names.set(o.id, o.thread_name); } catch {}
    }
  } catch {}
  const desc = (d) => { try { return fs.readdirSync(d).sort().reverse(); } catch { return []; } };
  const out = []; let scanned = 0;
  for (const y of desc(root)) for (const m of desc(path.join(root, y))) for (const d of desc(path.join(root, y, m))) {
    for (const f of desc(path.join(root, y, m, d)).filter((x) => x.endsWith('.jsonl'))) {
      if (out.length >= limit || scanned++ > 400) return out;
      const file = path.join(root, y, m, d, f);
      const meta = peek(file, false).split('\n')[0].slice(0, 8192);
      if (lastMatch(meta, /"cwd":"((?:[^"\\]|\\.)*)"/g) !== cwd) continue;
      const id = f.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1];
      if (!id) continue;
      out.push({ id, title: clip(names.get(id) || ''), first: '', when: new Date(fs.statSync(file).mtimeMs).toISOString() });
    }
  }
  return out;
}
