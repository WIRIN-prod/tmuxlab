import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONF = process.env.TMUXLAB_HOME || path.join(os.homedir(), '.config', 'tmuxlab');
fs.mkdirSync(CONF, { recursive: true, mode: 0o700 });

export const httpErr = (code, msg) => Object.assign(new Error(msg), { code });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const NAME_RE = /^[\w.-]{1,64}$/;

export function resolveCwd(p) {
  const d = !p ? os.homedir() : p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  if (!path.isAbsolute(d) || !fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) throw httpErr(400, `not a directory: ${p}`);
  return path.resolve(d);
}

// JSON config files in CONF, each with a default and a validator
const str = (v, max) => typeof v === 'string' && v.length <= max;
const opt = (v, f) => v === undefined || f(v);
const step = (w) => w && (opt(w.preset, (v) => str(v, 64)) && opt(w.cmd, (v) => str(v, 2000)) &&
  opt(w.label, (v) => str(v, 40)) && opt(w.split, (v) => ['right', 'down'].includes(v)));

export const CONFIGS = {
  presets: {
    def: [
      { id: 'shell', label: 'Shell', cmd: '', icon: '❯' },
      { id: 'claude', label: 'Claude', cmd: 'claude', icon: '✳' },
      { id: 'claude-resume', label: 'Claude (continue)', cmd: 'claude --continue', icon: '↻' },
      { id: 'codex', label: 'Codex', cmd: 'codex', icon: '◎' },
      { id: 'ci', label: 'Tests', cmd: 'npm test', icon: '✓' },
      { id: 'dev', label: 'Dev server', cmd: 'npm run dev', icon: '▲' },
    ],
    ok: (p) => Array.isArray(p) && p.length <= 100 && p.every((x) => x && NAME_RE.test(x.id) && str(x.label, 40) &&
      str(x.cmd, 2000) && opt(x.icon, (v) => str(v, 4))),
  },
  stacks: {
    def: [
      { id: 'dev-stack', label: 'Dev + tests + Claude', icon: '≡', windows: [{ preset: 'dev' }, { preset: 'ci' }, { preset: 'claude' }] },
      { id: 'pair', label: 'Claude | Codex', icon: '⫴', windows: [{ preset: 'claude' }, { preset: 'codex', split: 'right' }] },
    ],
    ok: (s) => Array.isArray(s) && s.length <= 50 && s.every((x) => x && NAME_RE.test(x.id) && str(x.label, 40) &&
      opt(x.icon, (v) => str(v, 4)) && Array.isArray(x.windows) && x.windows.length >= 1 && x.windows.length <= 12 && x.windows.every(step)),
  },
  schedules: {
    def: [],
    ok: (s) => Array.isArray(s) && s.length <= 100 && s.every((x) => x && NAME_RE.test(x.id) && str(x.label, 60) &&
      str(x.cron, 100) && NAME_RE.test(x.session || 'scheduled') && opt(x.cwd, (v) => str(v, 1000)) && step(x) && typeof x.enabled === 'boolean'),
  },
  settings: {
    def: { ntfy: '', alerts: { prompts: true, quiet: true, finished: true, quietSeconds: 20 },
      agents: ['claude', 'codex', 'gemini', 'aider', 'opencode', 'cursor-agent'] },
    ok: (s) => s && typeof s === 'object' && str(s.ntfy ?? '', 500) && (!s.ntfy || /^https?:\/\//.test(s.ntfy)) &&
      opt(s.alerts, (a) => a && typeof a === 'object') && opt(s.agents, (a) => Array.isArray(a) && a.every((x) => str(x, 40))),
  },
};

export function loadConf(name) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(CONF, name + '.json'), 'utf8'));
    return name === 'settings' ? { ...CONFIGS.settings.def, ...v, alerts: { ...CONFIGS.settings.def.alerts, ...v.alerts } } : v;
  } catch { return structuredClone(CONFIGS[name].def); }
}
export function saveConf(name, v) {
  if (!CONFIGS[name].ok(v)) throw httpErr(400, `invalid ${name}`);
  fs.writeFileSync(path.join(CONF, name + '.json'), JSON.stringify(v, null, 2), { mode: 0o600 });
  return loadConf(name);
}
