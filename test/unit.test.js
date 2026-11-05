import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPrompt } from '../lib/tmux.js';
import { parseCron, cronMatches, nextRun } from '../lib/cron.js';

test('detects a Claude Code permission prompt', () => {
  const screen = `● Bash(git push origin main)
╭──────────────────────────────────────────────╮
│ Bash command                                  │
│   git push origin main                        │
│ Do you want to proceed?                       │
│ ❯ 1. Yes                                      │
│   2. Yes, and don't ask again for git push    │
│   3. No, and tell Claude what to do (esc)     │
╰──────────────────────────────────────────────╯`;
  const p = detectPrompt(screen);
  assert.equal(p.question, 'Do you want to proceed?');
  assert.deepEqual(p.options.map((o) => o.n), [1, 2, 3]);
  assert.equal(p.options[1].label, "Yes, and don't ask again for git push");
  assert.equal(p.selected, 1);
});

test('detects a Codex-style prompt with the cursor on option 2', () => {
  const p = detectPrompt(`Would you like to run the following command?\n  $ rm -rf build\n  1. Yes, proceed (y)\n› 2. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm`);
  assert.equal(p.selected, 2);
  assert.equal(p.options.length, 2);
});

test('ignores ordinary numbered lists and old prompts scrolled up', () => {
  assert.equal(detectPrompt('Plan:\n1. Install deps\n2. Run tests\n3. Ship'), null);
  const old = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n' + Array.from({ length: 30 }, (_, i) => `output line ${i}`).join('\n');
  assert.equal(detectPrompt(old), null);
});

test('cron parsing and matching', () => {
  const c = parseCron('30 2 * * 1-5');
  assert.ok(cronMatches(c, new Date(2026, 10, 5, 2, 30))); // Thursday
  assert.ok(!cronMatches(c, new Date(2026, 10, 7, 2, 30))); // Saturday
  assert.ok(cronMatches(parseCron('*/15 * * * *'), new Date(2026, 0, 1, 9, 45)));
  assert.ok(cronMatches(parseCron('0 9 * * 7'), new Date(2026, 10, 8, 9, 0))); // 7 = Sunday
  assert.equal(nextRun(parseCron('0 0 1 1 *'), new Date(2026, 5, 1)).getFullYear(), 2027);
  for (const bad of ['* * *', '60 * * * *', '5-1 * * * *', 'x * * * *']) assert.throws(() => parseCron(bad));
});
