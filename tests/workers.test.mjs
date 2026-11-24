import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../plugins/development-team-toolkit/bin/toolkit.mjs', import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const toolkit = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const ok = (cwd, ...args) => {
  const result = toolkit(cwd, ...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const refused = (cwd, pattern, ...args) => {
  const result = toolkit(cwd, ...args);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, pattern);
};

async function project(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'toolkit-workers-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  await mkdir(join(root, 'src', 'billing'), { recursive: true });
  await mkdir(join(root, 'src', 'ui'), { recursive: true });
  await writeFile(join(root, 'src', 'billing', 'a.js'), 'a\n');
  await writeFile(join(root, 'src', 'ui', 'b.js'), 'b\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

test('disjoint workers run together, overlapping ones wait, and the worker cap holds', async (t) => {
  const root = await project(t);
  const billing = ok(root, 'worker', 'start', 'billing', '--role', 'developer', 'src/billing', '--resource', 'resource:contract-billing');
  assert.equal(billing.state, 'held');
  assert.ok(existsSync(join(billing.path, 'src', 'billing', 'a.js')));
  assert.equal(ok(root, 'worker', 'start', 'ui', '--role', 'developer', 'src/ui/b.js').state, 'held');
  // The worktree folder is ignored locally, so the primary checkout stays clean.
  assert.equal(git(root, 'status', '--porcelain'), '');
  refused(root, /parallel\.maxWorkers is 2/, 'worker', 'start', 'third', '--role', 'developer', 'docs');
  assert.deepEqual(ok(root, 'worker', 'status').workers.map((w) => [w.name, w.state]).sort(), [['billing', 'held'], ['ui', 'held']]);

  // Finish ui, then a worker overlapping billing's files queues until billing finishes.
  ok(root, 'worker', 'finish', 'ui');
  const overlap = ok(root, 'worker', 'start', 'billing-fix', '--role', 'developer', 'src/billing/a.js');
  assert.equal(overlap.state, 'queued');
  assert.equal(ok(root, 'worker', 'start', 'contract', '--role', 'developer', 'src/other', '--resource', 'resource:contract-billing').state, 'queued');
  await writeFile(join(billing.path, 'src', 'billing', 'a.js'), 'a2\n');
  git(billing.path, 'commit', '-q', '-am', 'billing change');
  const done = ok(root, 'worker', 'finish', 'billing');
  assert.deepEqual(done.changed, ['src/billing/a.js']);
  assert.equal(await readFile(join(root, 'src', 'billing', 'a.js'), 'utf8'), 'a2\n');
  assert.equal(ok(root, 'worker', 'start', 'billing-fix', '--role', 'developer', 'src/billing/a.js').state, 'held');
});

test('finish refuses undeclared files, dirty worktrees and a target that moved on', async (t) => {
  const root = await project(t);
  const worker = ok(root, 'worker', 'start', 'ui', '--role', 'developer', 'src/ui');
  await writeFile(join(worker.path, 'src', 'ui', 'b.js'), 'b2\n');
  refused(root, /uncommitted changes/, 'worker', 'finish', 'ui');
  await writeFile(join(worker.path, 'src', 'billing', 'a.js'), 'sneaky\n');
  git(worker.path, 'commit', '-q', '-am', 'too much');
  refused(root, /undeclared files: src\/billing\/a\.js/, 'worker', 'finish', 'ui');
  git(worker.path, 'reset', '-q', '--hard', 'HEAD~1');
  await writeFile(join(worker.path, 'src', 'ui', 'b.js'), 'b2\n');
  git(worker.path, 'commit', '-q', '-am', 'ui change');

  await writeFile(join(root, 'README.md'), 'moved\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'main moved');
  refused(root, /moved on since ui started\. Rebase first/, 'worker', 'finish', 'ui');
  git(worker.path, 'rebase', '-q', 'main');
  assert.equal(ok(root, 'worker', 'finish', 'ui').into, 'main');
  assert.equal(await readFile(join(root, 'src', 'ui', 'b.js'), 'utf8'), 'b2\n');
  assert.equal(git(root, 'branch', '--list', 'worker/*'), '');

  // Typed spawns only: no role, an unknown role or a read-only role is refused with a clear error.
  refused(root, /--role <id>/, 'worker', 'start', 'untyped', 'src');
  refused(root, /not an enabled role.*never retry under another agent name/s, 'worker', 'start', 'typo', '--role', 'devloper', 'src');
  refused(root, /qa-code is read-only/, 'worker', 'start', 'review', '--role', 'toolkit-qa-code', 'src');
  refused(root, /lowercase slugs/, 'worker', 'start', 'Bad Name', '--role', 'developer', 'src');
  refused(root, /repo-relative/, 'worker', 'start', 'esc', '--role', 'developer', '../outside');
  await writeFile(join(root, 'cap.json'), JSON.stringify({ schemaVersion: 1, id: 'p', title: 'P', parallel: { maxWorkers: 1 } }));
  ok(root, 'init', 'cap.json');
  ok(root, 'worker', 'start', 'one', '--role', 'developer', 'src/ui');
  refused(root, /parallel\.maxWorkers is 1/, 'worker', 'start', 'two', '--role', 'developer', 'src/billing');
});
