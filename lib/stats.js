// CPU (from /proc tick deltas, i.e. current use, not lifetime average), memory and disk.
import fs from 'node:fs';
import os from 'node:os';

const HZ = 100; // USER_HZ on Linux
let prevCpu = null, prevProc = new Map(), prevT = 0;

function machineCpu() {
  const l = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = l[3] + (l[4] || 0), total = l.reduce((a, b) => a + b, 0);
  const pct = prevCpu ? 100 * (1 - (idle - prevCpu.idle) / Math.max(1, total - prevCpu.total)) : null;
  prevCpu = { idle, total };
  return pct;
}

function procs() {
  const out = new Map();
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
      out.set(+pid, { ppid: +f[1], ticks: +f[11] + +f[12], rss: +f[21] * 4096 });
    } catch {} // process exited while reading
  }
  return out;
}

function memory() {
  const avail = +(fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)?.[1] || 0) * 1024;
  return { total: os.totalmem(), used: os.totalmem() - (avail || os.freemem()) };
}

// panes: [{session, pid}] -> per-session {cpu, rss}
export function stats(panes) {
  if (process.platform !== 'linux') return { machine: null, sessions: {} };
  const now = Date.now(), dt = (now - prevT) / 1000, cur = procs();
  const kids = new Map();
  for (const [pid, p] of cur) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(pid); }
  const sessions = {};
  for (const { session, pid } of panes) {
    const s = sessions[session] ??= { cpu: 0, rss: 0 };
    const stack = [pid];
    while (stack.length) {
      const id = stack.pop(), p = cur.get(id); if (!p) continue;
      s.rss += p.rss;
      const before = prevProc.get(id);
      if (before && prevT) s.cpu += (100 * (p.ticks - before.ticks)) / HZ / dt;
      stack.push(...(kids.get(id) || []));
    }
  }
  prevProc = cur; prevT = now;
  let disk = null;
  try { const d = fs.statfsSync(os.homedir()); disk = { total: d.blocks * d.bsize, used: (d.blocks - d.bavail) * d.bsize }; } catch {}
  return {
    machine: { cpu: machineCpu(), cores: os.cpus().length, load: os.loadavg()[0], mem: memory(), disk },
    sessions,
  };
}
