import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../plugins/development-team-toolkit/bin/toolkit.mjs', import.meta.url));

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'toolkit-coordinator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  git(root, 'init', project);
  git(project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
  const worktree = join(root, 'other');
  git(project, 'worktree', 'add', '-b', 'other', worktree);
  return { project, worktree };
}

function command(cwd, args, capability) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'coordinate', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(capability ? `${capability}\n` : '');
  });
}

async function run(cwd, args, capability) {
  const result = await command(cwd, args, capability);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const request = (cwd, owner, ...resources) => run(cwd, ['request', owner, ...resources]);
const act = (cwd, action, ticket) => run(cwd, [action, ticket.id], ticket.capability);

test('disjoint claims run together and an overlapping file waits across worktrees', async (t) => {
  const { project, worktree } = await fixture(t);
  const a = await request(project, 'developer', 'file:src/search');
  const b = await request(worktree, 'designer', 'file:src/layout');
  const c = await request(worktree, 'reviewer', 'file:src/search/child.js');
  assert.equal((await act(project, 'claim', a)).state, 'held');
  assert.equal((await act(worktree, 'claim', b)).state, 'held');
  assert.equal((await act(worktree, 'claim', c)).state, 'queued');
  assert.equal((await act(project, 'release', a)).state, 'released');
  assert.equal((await act(worktree, 'claim', c)).state, 'held');
});

test('competing processes cannot hold the same shared runner and FIFO survives restarts', async (t) => {
  const { project, worktree } = await fixture(t);
  const first = await request(project, 'first', 'resource:runner');
  const second = await request(worktree, 'second', 'resource:runner');
  const [one, two] = await Promise.all([act(project, 'claim', first), act(worktree, 'claim', second)]);
  assert.equal(one.state, 'held');
  assert.equal(two.state, 'queued');
  const third = await request(project, 'third', 'resource:runner');
  const independent = await request(worktree, 'independent', 'resource:browser');
  assert.equal((await act(project, 'release', first)).state, 'released');
  assert.equal((await act(project, 'claim', third)).state, 'queued');
  assert.equal((await act(worktree, 'claim', independent)).state, 'held');
  assert.equal((await act(worktree, 'claim', second)).state, 'held');
  assert.equal((await act(worktree, 'release', second)).state, 'released');
  assert.equal((await act(project, 'claim', third)).state, 'held');
});

test('bundles hold all resources or none, with status omitting capabilities', async (t) => {
  const { project, worktree } = await fixture(t);
  const runner = await request(project, 'runner-owner', 'resource:runner');
  await act(project, 'claim', runner);
  const bundle = await request(worktree, 'bundle-owner', 'resource:runner', 'file:src/shared');
  assert.equal((await act(worktree, 'claim', bundle)).state, 'queued');
  const status = await run(project, ['status']);
  const record = status.requests.find((entry) => entry.id === bundle.id);
  assert.equal(record.state, 'queued');
  assert.deepEqual(record.resources, ['file:src/shared', 'resource:runner']);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(`${runner.capability}|${bundle.capability}`));
  assert.equal(Object.hasOwn(record, 'capability'), false);
  const holder = status.requests.find((entry) => entry.id === runner.id);
  assert.ok(Date.parse(record.requested_at) && record.claimed_at === null && Number.isInteger(record.age_seconds));
  assert.ok(Date.parse(holder.claimed_at) >= Date.parse(holder.requested_at) && Number.isInteger(holder.age_seconds));
  await act(project, 'release', runner);
  assert.equal((await act(worktree, 'claim', bundle)).state, 'held');
});

test('invalid and stale capabilities cannot release a current owner', async (t) => {
  const { project, worktree } = await fixture(t);
  const old = await request(project, 'old-owner', 'resource:runner');
  await act(project, 'claim', old);
  assert.notEqual((await command(project, ['release', old.id], '0'.repeat(64))).status, 0);
  const current = await request(worktree, 'new-owner', 'resource:runner');
  assert.equal((await act(worktree, 'claim', current)).state, 'queued');
  await act(project, 'release', old);
  assert.equal((await act(worktree, 'claim', current)).state, 'held');
  assert.notEqual((await command(project, ['release', old.id], old.capability)).status, 0);
  assert.equal((await run(project, ['status'])).requests.find((item) => item.id === current.id).state, 'held');
});

test('cancel releases queue position and rejects unsafe paths', async (t) => {
  const { project, worktree } = await fixture(t);
  for (const resource of ['file:../outside', 'file:/absolute', 'file:src/../../outside', 'resource:../runner']) {
    assert.notEqual((await command(project, ['request', 'invalid', resource])).status, 0, resource);
  }
  const first = await request(project, 'first', 'file:Src/Shared');
  const second = await request(worktree, 'second', 'file:src/shared/child');
  assert.equal((await act(worktree, 'claim', second)).state, 'queued');
  assert.equal((await act(project, 'cancel', first)).state, 'cancelled');
  assert.equal((await act(worktree, 'claim', second)).state, 'held');
  assert.notEqual((await command(project, ['claim', first.id], first.capability)).status, 0);
});
