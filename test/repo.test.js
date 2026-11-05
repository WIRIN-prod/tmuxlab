import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoOf } from '../lib/git.js';

test('repoOf names the repo, branch and worktree of a folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-repo-'));
  const repo = path.join(dir, 'myapp'), wt = path.join(dir, 'myapp.worktrees', 'feat-x');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main'); g(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
  g(repo, 'worktree', 'add', '-q', '-b', 'feat-x', wt);
  fs.mkdirSync(path.join(wt, 'src'));
  assert.deepEqual(await repoOf(repo), { branch: 'main', root: fs.realpathSync(repo), repo: 'myapp', wt: '' });
  const w = await repoOf(path.join(wt, 'src'));
  assert.equal(w.repo, 'myapp'); assert.equal(w.branch, 'feat-x'); assert.equal(w.wt, 'feat-x');
  assert.equal(await repoOf(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
