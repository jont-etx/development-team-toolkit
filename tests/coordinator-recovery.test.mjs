import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const cli = fileURLToPath(new URL('../plugins/development-team-toolkit/bin/toolkit.mjs', import.meta.url));
const checkout = fileURLToPath(new URL('..', import.meta.url));
const supervisor = 'a'.repeat(64);
const successor = 'b'.repeat(64);
const replacement = 'c'.repeat(64);

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function fixture(t, wiki = false) {
  const root = await mkdtemp(join(tmpdir(), 'toolkit-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  git(root, 'init', project);
  git(project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
  const worktree = join(root, 'other');
  git(project, 'worktree', 'add', '-b', 'other', worktree);
  if (wiki) await mkdir(join(project, '.wiki'));
  const config = {
    schemaVersion: 1, id: 'clean-repo', title: 'Clean repo',
    coordinator: { fixtures: { 'resource:fixture': 'restore-baseline' } },
  };
  await writeFile(join(project, 'seed.json'), JSON.stringify(config));
  assert.equal((await invoke(project, ['init', 'seed.json'])).status, 0);
  return { root, project, worktree, config };
}

function invoke(cwd, args, input = '', program = cli) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [program, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ? `${input}\n` : '');
  });
}

async function command(cwd, args, input = '') {
  const result = await invoke(cwd, ['coordinate', ...args], input);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function denied(cwd, args, input = '') {
  const result = await invoke(cwd, ['coordinate', ...args], input);
  assert.notEqual(result.status, 0, `Unexpected success: ${args.join(' ')}`);
}

const request = (cwd, owner, ...resources) => command(cwd, ['request', owner, ...resources]);
const act = (cwd, action, ticket, ...args) => command(cwd, [action, ticket.id, ...args], ticket.capability);

test('handoff keeps active claims and FIFO queue and fences the former supervisor', async (t) => {
  const { project, worktree } = await fixture(t);
  assert.equal((await command(project, ['authority-init'], supervisor)).epoch, 1);
  const active = await request(project, 'worker', 'resource:runner');
  const first = await request(worktree, 'first', 'resource:runner');
  const second = await request(project, 'second', 'resource:runner');
  assert.equal((await act(project, 'claim', active)).state, 'held');
  assert.equal((await act(worktree, 'claim', first)).state, 'queued');
  await denied(project, ['handoff', '2'], `${supervisor}\n${successor}`);
  assert.equal((await command(project, ['handoff', '1'], `${supervisor}\n${successor}`)).epoch, 2);
  await denied(project, ['handoff', '2'], `${supervisor}\n${replacement}`);
  assert.equal((await act(project, 'release', active)).state, 'released');
  assert.equal((await act(project, 'claim', second)).state, 'queued');
  assert.equal((await act(worktree, 'claim', first)).state, 'held');
});

test('quarantine fences stale holder and recovery preserves place in queue', async (t) => {
  const { project, worktree } = await fixture(t);
  await command(project, ['authority-init'], supervisor);
  const holder = await request(project, 'worker', 'resource:runner');
  const waiting = await request(worktree, 'waiting', 'resource:runner');
  await act(project, 'claim', holder);
  await denied(project, ['recover', holder.id, 'worker-stopped'], `${supervisor}\n${replacement}`);
  await command(project, ['quarantine', holder.id, 'worker-unknown'], supervisor);
  await denied(project, ['release', holder.id], holder.capability);
  assert.equal((await act(worktree, 'claim', waiting)).state, 'queued');
  await command(project, ['recover', holder.id, 'worker-stopped'], `${supervisor}\n${replacement}`);
  await denied(project, ['claim', holder.id], holder.capability);
  assert.equal((await command(project, ['claim', holder.id], replacement)).state, 'held');
  assert.equal((await act(worktree, 'claim', waiting)).state, 'queued');
  await command(project, ['release', holder.id], replacement);
  assert.equal((await act(worktree, 'claim', waiting)).state, 'held');
});

test('recovery rotates a lost queued capability without changing FIFO position', async (t) => {
  const { project, worktree } = await fixture(t);
  await command(project, ['authority-init'], supervisor);
  const holder = await request(project, 'holder', 'resource:runner');
  const waiting = await request(worktree, 'waiting', 'resource:runner');
  const later = await request(project, 'later', 'resource:runner');
  await act(project, 'claim', holder);
  await denied(project, ['recover', waiting.id, 'queue-inspected'], `${supervisor}\n${waiting.capability}`);
  await command(project, ['recover', waiting.id, 'queue-inspected'], `${supervisor}\n${replacement}`);
  await denied(worktree, ['claim', waiting.id], waiting.capability);
  await act(project, 'release', holder);
  assert.equal((await act(project, 'claim', later)).state, 'queued');
  assert.equal((await command(worktree, ['claim', waiting.id], replacement)).state, 'held');
});

test('concurrent supervisor handoffs allow only one successor', async (t) => {
  const { project, worktree } = await fixture(t);
  await command(project, ['authority-init'], supervisor);
  const results = await Promise.all([
    invoke(project, ['coordinate', 'handoff', '1'], `${supervisor}\n${successor}`),
    invoke(worktree, ['coordinate', 'handoff', '1'], `${supervisor}\n${replacement}`),
  ]);
  assert.equal(results.filter((result) => result.status === 0).length, 1);
  assert.equal(results.filter((result) => result.status !== 0).length, 1);
  assert.equal(JSON.parse(results.find((result) => result.status === 0).stdout).epoch, 2);
});

test('a previously used supervisor capability cannot regain authority', async (t) => {
  const { project } = await fixture(t);
  await command(project, ['authority-init'], supervisor);
  await command(project, ['handoff', '1'], `${supervisor}\n${successor}`);
  await denied(project, ['handoff', '2'], `${successor}\n${supervisor}`);
  assert.equal((await command(project, ['status'])).epoch, 2);
});

test('a quarantined running worker blocks reuse until stopped and fixture cleanup is recorded', async (t) => {
  const { root, project, worktree } = await fixture(t);
  await command(project, ['authority-init'], supervisor);
  await command(project, ['policy-sync'], supervisor);
  const holder = await request(project, 'worker', 'resource:fixture');
  const waiting = await request(worktree, 'rival', 'resource:fixture');
  await act(project, 'claim', holder);
  const dirty = join(root, 'dirty-fixture.txt');
  const child = spawn(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], 'dirty'); console.log('READY'); setInterval(() => {}, 1000)", dirty], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', resolve);
    child.once('exit', (code) => reject(new Error(`Worker exited before ready: ${code}`)));
  });
  await command(project, ['quarantine', holder.id, 'worker-still-running'], supervisor);
  assert.equal((await act(worktree, 'claim', waiting)).state, 'queued');
  await denied(project, ['release', holder.id], holder.capability);
  const stopped = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await stopped;
  await rm(dirty);
  const proof = join(root, 'cleanup.json');
  await writeFile(proof, JSON.stringify({ 'resource:fixture': { method: 'restore-baseline', ref: 'worker-exited-and-fixture-removed' } }));
  await command(project, ['recover', holder.id, 'worker-exited', proof], `${supervisor}\n${replacement}`);
  assert.equal((await command(project, ['claim', holder.id], replacement)).state, 'held');
  await denied(project, ['release', holder.id], holder.capability);
  await command(project, ['release', holder.id, proof], replacement);
  assert.equal((await act(worktree, 'claim', waiting)).state, 'held');
});

test('wiki fixture policy survives handoff and requires matching cleanup evidence', async (t) => {
  const { root, project, worktree, config } = await fixture(t, true);
  await command(project, ['authority-init'], supervisor);
  await command(project, ['policy-sync'], supervisor);
  await denied(worktree, ['policy-sync'], supervisor);
  const holder = await request(project, 'worker', 'resource:fixture');
  await act(project, 'claim', holder);
  await denied(project, ['release', holder.id], holder.capability);
  const wrong = join(root, 'wrong.json');
  const good = join(root, 'good.json');
  await writeFile(wrong, JSON.stringify({ 'resource:fixture': { method: 'delete', ref: 'cleanup-log' } }));
  await writeFile(good, JSON.stringify({ 'resource:fixture': { method: 'restore-baseline', ref: 'cleanup-log' } }));
  await denied(project, ['release', holder.id, wrong], holder.capability);
  const changed = { ...config, coordinator: { fixtures: { 'resource:fixture': 'delete' } } };
  await writeFile(join(project, '.wiki', 'development-team', 'project.json'), JSON.stringify(changed));
  await denied(project, ['policy-sync'], supervisor);
  await command(project, ['handoff', '1'], `${supervisor}\n${successor}`);
  await command(project, ['quarantine', holder.id, 'worker-stopped'], successor);
  await denied(project, ['recover', holder.id, 'worker-stopped', wrong], `${successor}\n${replacement}`);
  await command(project, ['recover', holder.id, 'worker-stopped', good], `${successor}\n${replacement}`);
  assert.equal((await command(project, ['claim', holder.id], replacement)).state, 'held');
  await denied(project, ['release', holder.id], replacement);
  assert.equal((await command(project, ['release', holder.id, good], replacement)).state, 'released');
  await command(project, ['policy-sync'], successor);
  await rename(join(project, '.wiki'), join(project, 'offline-wiki'));
  await denied(project, ['policy-sync'], successor);
  const afterOffline = await request(worktree, 'offline-worker', 'resource:fixture');
  await act(worktree, 'claim', afterOffline);
  await denied(worktree, ['release', afterOffline.id], afterOffline.capability);
  assert.equal((await act(worktree, 'release', afterOffline, wrong)).state, 'released');
  const audit = await command(project, ['audit']);
  assert.ok(audit.events.some((event) => event.event === 'handoff'));
  assert.ok(audit.events.some((event) => event.event === 'recover' && event.request_id === holder.id));
});

test('supervisor withdraws an abandoned queued request in one step and finished requests are pruned', async (t) => {
  const { project, worktree } = await fixture(t);
  await command(project, ['authority-init'], supervisor);
  const holder = await request(project, 'holder', 'resource:runner');
  const abandoned = await request(worktree, 'abandoned', 'resource:runner');
  const next = await request(project, 'next', 'resource:runner');
  await act(project, 'claim', holder);
  await denied(project, ['withdraw', holder.id, 'lost-credential'], supervisor);
  await denied(project, ['withdraw', abandoned.id, 'lost-credential'], successor);
  assert.equal((await command(project, ['withdraw', abandoned.id, 'lost-credential'], supervisor)).state, 'cancelled');
  await denied(worktree, ['claim', abandoned.id], abandoned.capability);
  await act(project, 'release', holder);
  assert.equal((await act(project, 'claim', next)).state, 'held');
  const events = (await command(project, ['audit'])).events;
  assert.deepEqual(events.find((event) => event.event === 'withdraw').detail, { stopRef: 'lost-credential' });

  // Age the finished requests past the one-week window; the next request prunes them.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(project, '.git', 'development-team-coordinator.sqlite'));
  db.prepare("UPDATE coordinator_requests SET requested_at = '2020-01-01T00:00:00.000Z' WHERE state != 'held'").run();
  db.close();
  await request(project, 'later', 'resource:other');
  const remaining = (await command(project, ['status'])).requests.map((entry) => entry.owner);
  assert.deepEqual(remaining, ['next', 'later']);
  assert.ok((await command(project, ['audit'])).events.some((event) => event.event === 'release' && event.request_id === holder.id));
});

test('a delayed policy load cannot replace a newer synchronized policy', async (t) => {
  const { root, project, config } = await fixture(t);
  await command(project, ['authority-init'], supervisor);
  await command(project, ['policy-sync'], supervisor);
  const started = join(root, 'policy-started');
  const continueFile = join(root, 'continue-policy');
  const harness = join(root, 'slow-policy.mjs');
  const moduleUrl = pathToFileURL(join(checkout, 'plugins/development-team-toolkit/bin/coordinator.mjs')).href;
  const script = `import { access, writeFile } from 'node:fs/promises';
import { coordinate } from ${JSON.stringify(moduleUrl)};
try {
  const result = await coordinate(['policy-sync'], { loadPolicy: async () => {
    const stalePolicy = { fixtures: { 'resource:fixture': 'restore-baseline' } };
    await writeFile(process.argv[2], 'started');
    for (;;) {
      try { await access(process.argv[3]); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    return stalePolicy;
  } });
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
`;
  await writeFile(harness, script);
  const delayed = invoke(project, [started, continueFile], supervisor, harness);
  let ready = false;
  for (let count = 0; count < 200; count += 1) {
    try { await access(started); ready = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assert.equal(ready, true, 'Delayed policy loader did not start');
  const changed = { ...config, coordinator: { fixtures: { 'resource:fixture': 'delete' } } };
  await writeFile(join(project, '.development-team', 'project.json'), JSON.stringify(changed));
  await command(project, ['policy-sync'], supervisor);
  await writeFile(continueFile, 'continue');
  assert.notEqual((await delayed).status, 0);
  assert.equal((await command(project, ['status'])).fixtures['resource:fixture'], 'delete');
});

test('legacy migration preserves state and prevents the old binary from mutating it', async (t) => {
  const { root, project } = await fixture(t);
  const oldSource = git(checkout, 'show', '3e9e436:plugins/development-team-toolkit/bin/coordinator.mjs');
  const legacy = join(root, 'old-coordinator.mjs');
  const wrapper = join(root, 'old-wrapper.mjs');
  await writeFile(legacy, oldSource);
  await writeFile(wrapper, "import { coordinate } from './old-coordinator.mjs'; try { console.log(JSON.stringify(await coordinate(process.argv.slice(2)))); } catch (error) { console.error(error.message); process.exitCode = 1; }\n");
  const oldResult = await invoke(project, ['request', 'legacy', 'resource:runner'], '', wrapper);
  assert.equal(oldResult.status, 0, oldResult.stderr);
  const legacyClaim = JSON.parse(oldResult.stdout);
  const held = await invoke(project, ['claim', legacyClaim.id], legacyClaim.capability, wrapper);
  assert.equal(JSON.parse(held.stdout).state, 'held');
  await command(project, ['authority-init'], supervisor);
  assert.equal((await command(project, ['status'])).requests.find((item) => item.id === legacyClaim.id).state, 'held');
  const staleRelease = await invoke(project, ['release', legacyClaim.id], legacyClaim.capability, wrapper);
  assert.notEqual(staleRelease.status, 0);
  assert.equal((await command(project, ['status'])).requests.find((item) => item.id === legacyClaim.id).state, 'held');
});
