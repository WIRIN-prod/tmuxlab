import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { httpErr, resolveCwd } from './util.js';

const run = promisify(execFile);
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
export const git = async (cwd, ...args) => (await run('git', args, { cwd, env: ENV, maxBuffer: 32 << 20 })).stdout;
const BRANCH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/$)[\w./-]{1,100}$/;

// branch per folder, cached briefly because the session list asks for it on every poll
const cache = new Map();
export async function branchOf(cwd) {
  const c = cache.get(cwd);
  if (c && Date.now() - c.t < 10000) return c.v;
  const v = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').then((s) => s.trim(), () => '');
  cache.set(cwd, { v, t: Date.now() });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}

async function root(p) {
  const cwd = resolveCwd(p);
  try { return (await git(cwd, 'rev-parse', '--show-toplevel')).trim(); } catch { throw httpErr(400, 'not a git repository'); }
}

export async function info(p) {
  const r = await root(p);
  const head = await git(r, 'status', '--porcelain=v1', '--branch', '-z');
  const [branchLine, ...rest] = head.split('\0');
  const files = [];
  for (let i = 0; i < rest.length; i++) {
    const e = rest[i]; if (!e) continue;
    const st = e.slice(0, 2), file = e.slice(3);
    if (st[0] === 'R' || st[0] === 'C') i++; // rename: next entry is the old path
    files.push({ status: st.trim() || st, file });
  }
  const num = await git(r, 'diff', 'HEAD', '--numstat', '-z').catch(() => '');
  const stats = {};
  for (const e of num.split('\0')) { const m = e.match(/^(\d+|-)\t(\d+|-)\t(.+)$/); if (m) stats[m[3]] = { add: +m[1] || 0, del: +m[2] || 0 }; }
  for (const f of files) Object.assign(f, stats[f.file] || { add: 0, del: 0 });
  const b = branchLine.match(/^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.+)\])?/) || [];
  const wtl = await git(r, 'worktree', 'list', '--porcelain');
  const worktrees = wtl.split('\n\n').filter(Boolean).map((blk) => ({
    path: blk.match(/^worktree (.+)$/m)?.[1], branch: blk.match(/^branch refs\/heads\/(.+)$/m)?.[1] || '' }));
  const remote = (await git(r, 'remote', 'get-url', 'origin').catch(() => '')).trim();
  const last = (await git(r, 'log', '-1', '--format=%h %s').catch(() => '')).trim();
  return { root: r, branch: b[1] || '', upstream: b[2] || '', track: b[3] || '', files, worktrees,
    isWorktree: worktrees[0]?.path !== r, remote, last };
}

export async function diff(p, file) {
  const r = await root(p);
  if (typeof file !== 'string' || !file || file.includes('\0')) throw httpErr(400, 'bad file');
  const abs = path.resolve(r, file);
  if (!abs.startsWith(r + path.sep)) throw httpErr(400, 'file outside repo');
  const tracked = await git(r, 'ls-files', '--error-unmatch', '--', file).then(() => true, () => false);
  if (tracked) return git(r, 'diff', 'HEAD', '--', file);
  // untracked: diff against nothing (exit code 1 means "differences found")
  return run('git', ['diff', '--no-index', '--', '/dev/null', file], { cwd: r, env: ENV, maxBuffer: 32 << 20 })
    .then((x) => x.stdout, (e) => (e.code === 1 ? e.stdout : Promise.reject(e)));
}

export async function commit(p, message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 5000) throw httpErr(400, 'commit message required');
  const r = await root(p);
  await git(r, 'add', '-A');
  return (await git(r, 'commit', '-m', message)).trim().split('\n')[0];
}

export async function push(p) {
  const r = await root(p);
  await git(r, 'push', '-u', 'origin', 'HEAD');
  return 'pushed';
}

export async function pr(p, title, body) {
  const r = await root(p);
  await git(r, 'push', '-u', 'origin', 'HEAD');
  const args = ['pr', 'create', ...(title ? ['--title', title, '--body', body || ''] : ['--fill'])];
  const out = await run('gh', args, { cwd: r, env: ENV }).catch((e) => {
    const existing = (e.stderr || '').match(/https:\/\/\S+\/pull\/\d+/);
    if (existing) return { stdout: existing[0] };
    throw e;
  });
  return out.stdout.trim().split('\n').pop();
}

// new branch in a sibling folder: <repo>.worktrees/<branch>
export async function addWorktree(p, branch) {
  if (!BRANCH_RE.test(branch || '')) throw httpErr(400, 'bad branch name');
  const r = await root(p);
  const dir = path.join(path.dirname(r), path.basename(r) + '.worktrees', branch.replace(/\//g, '-'));
  if (fs.existsSync(dir)) throw httpErr(409, `${dir} already exists`);
  const exists = await git(r, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true, () => false);
  await git(r, 'worktree', 'add', ...(exists ? [dir, branch] : ['-b', branch, dir]));
  return dir;
}

export async function removeWorktree(p, force) {
  const r = await root(p);
  const main = (await git(r, 'worktree', 'list', '--porcelain')).match(/^worktree (.+)$/m)[1];
  if (main === r) throw httpErr(400, 'this is the main checkout, not a worktree');
  await git(main, 'worktree', 'remove', ...(force ? ['--force'] : []), r);
  return main;
}
