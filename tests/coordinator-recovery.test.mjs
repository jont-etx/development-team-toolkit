import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

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
  assert.notEqual(result.status, 0, `Unexpected success: ${args[0]}`);
}

const request = (cwd, owner, ...resources) => command(cwd, ['request', owner, ...resources]);
const act = (cwd, action, ticket, ...args) => command(cwd, [action, ticket.id, ...args], ticket.capability);

test('a reserved Critical slot requires exact approval and a passing run requests staging priority', async (t) => {
  const { root, project, worktree } = await fixture(t);
  const routine = 'resource:local-odoo-isolated';
  const critical = 'resource:local-odoo-critical';
  const stage = 'resource:staging';
  const candidate = 'c'.repeat(40);
  await command(project, ['authority-init'], supervisor);
  const a = await request(project, 'module-a', routine);
  const b = await request(worktree, 'module-b', routine);
  const c = await request(project, 'module-c', routine);
  assert.equal((await act(project, 'claim', a)).state, 'held');
  assert.equal((await act(worktree, 'claim', b)).state, 'held');
  assert.equal((await act(project, 'claim', c)).state, 'queued');
  const unapproved = await request(project, 'unapproved', critical);
  const hot = await request(worktree, 'critical', critical);
  const next = await request(project, 'next-critical', critical);
  assert.equal((await act(project, 'claim', unapproved)).state, 'queued');
  await denied(project, ['authorize-critical-test', hot.id, candidate, 'critical-ref'], hot.capability);
  await command(project, ['authorize-critical-test', hot.id, candidate, 'critical-ref'], supervisor);
  await command(project, ['authorize-critical-test', next.id, 'd'.repeat(40), 'next-ref'], supervisor);
  const held = await act(worktree, 'claim', hot);
  assert.equal(held.state, 'held');
  assert.equal((await act(project, 'claim', next)).state, 'queued');
  await denied(worktree, ['check-held', hot.id, critical, 'd'.repeat(40)], hot.capability);
  assert.equal((await act(worktree, 'check-held', hot, critical, candidate)).generation, held.generation);

  const ordinary = await request(project, 'ordinary', stage);
  const staging = await request(worktree, 'critical', stage);
  const receipt = join(root, 'critical-run.json');
  const evidence = { source_revision: candidate, source_dirty: false, database: 'cpd_local_test_critical',
    database_oid: 123, outcome: 'green', expected_tests: 1, actual_tests: 1, child_exit: 0, skips: 0 };
  const complete = ['request-hotfix-priority', hot.id, String(held.generation), staging.id, receipt];
  const credentials = `${hot.capability}\n${staging.capability}`;
  await writeFile(receipt, JSON.stringify({ ...evidence, outcome: 'failed' }));
  await denied(worktree, complete, credentials);
  await writeFile(receipt, JSON.stringify({ ...evidence, source_revision: 'e'.repeat(40) }));
  await denied(worktree, complete, credentials);
  await writeFile(receipt, JSON.stringify(evidence));
  await denied(worktree, complete, `${hot.capability}\n${ordinary.capability}`);
  assert.equal((await command(worktree, complete, credentials)).state, 'requested');
  assert.equal((await command(worktree, complete, credentials)).state, 'requested');
  assert.equal((await act(worktree, 'claim', staging)).state, 'queued');
  await command(project, ['authorize-hotfix', staging.id, candidate, 'owner', 'release-ref'], supervisor);
  assert.equal((await act(project, 'claim', ordinary)).state, 'queued');
  assert.equal((await act(worktree, 'claim', staging)).state, 'held');
  await act(worktree, 'release', hot, `--generation=${held.generation}`);
  assert.equal((await act(project, 'claim', next)).state, 'held');
});

test('supervisor binds an immutable exact staging authorization to the held generation', async (t) => {
  const { project } = await fixture(t);
  await command(project, ['authority-init'], supervisor);
  const ticket = await request(project, 'release', 'resource:staging');
  const held = await act(project, 'claim', ticket);
  const record = { version: 1, generation: held.generation, old: 'a'.repeat(40), build: '42411483',
    new: 'b'.repeat(40), tree: 'c'.repeat(40), local_ref: 'refs/heads/cpd-scoped/fixture',
    remote: 'origin', url: 'https://example.invalid/repo', ref: 'refs/heads/Development',
    selected: ['d'.repeat(40)], approvals: ['owner-ref'], excluded: ['e'.repeat(40)],
    source_ref: 'refs/heads/Development', mode: 'scoped' };
  const authorize = ['authorize-release', ticket.id, JSON.stringify(record)];
  await denied(project, authorize, ticket.capability);
  await denied(project, ['authorize-release', ticket.id, JSON.stringify({ ...record, url: 'https://example.invalid/repo?token=secret' })], supervisor);
  await denied(project, ['authorize-release', ticket.id, JSON.stringify({ ...record, excluded: record.selected })], supervisor);
  await denied(project, ['authorize-release', ticket.id, JSON.stringify({ ...record, mode: 'hotfix', source_ref: 'refs/heads/cpd-hotfix/fixture', hotfix_signer: 'owner', hotfix_approval_ref: 'ref' })], supervisor);
  const escapedCredential = JSON.stringify({ ...record, approvals: [ticket.capability] }).replace(ticket.capability, `\\u00${ticket.capability.charCodeAt(0).toString(16)}${ticket.capability.slice(1)}`);
  await denied(project, ['authorize-release', ticket.id, escapedCredential], supervisor);
  await command(project, authorize, supervisor);
  await denied(project, authorize, supervisor);
  const checked = await act(project, 'release-check', ticket, String(held.generation), record.new, record.mode);
  assert.equal(checked.mode, 'scoped');
  assert.deepEqual(checked.selected, record.selected);
  assert.equal(JSON.stringify(checked).includes(ticket.capability), false);
  await denied(project, ['release-check', ticket.id, String(held.generation + 1), record.new, record.mode], ticket.capability);
  await denied(project, ['release-check', ticket.id, String(held.generation), 'f'.repeat(40), record.mode], ticket.capability);
  await denied(project, ['release-check', ticket.id, String(held.generation), record.new, 'hotfix'], ticket.capability);
  await act(project, 'release', ticket);
  await denied(project, ['release-check', ticket.id, String(held.generation), record.new, record.mode], ticket.capability);
});

test('hotfix release authorization requires explicit supervisor sign-off and cannot be inferred from a held grant', async (t) => {
  const { project } = await fixture(t);
  await command(project, ['authority-init'], supervisor);
  const ticket = await request(project, 'hotfix', 'resource:staging');
  await command(project, ['authorize-hotfix', ticket.id, 'b'.repeat(40), 'mark', 'hot-zone-ref'], supervisor);
  const held = await act(project, 'claim', ticket);
  const record = { version: 1, generation: held.generation, old: 'a'.repeat(40), build: '42411483',
    new: 'b'.repeat(40), tree: 'c'.repeat(40), local_ref: 'refs/heads/cpd-scoped/fixture',
    remote: 'origin', url: 'https://example.invalid/repo', ref: 'refs/heads/Development',
    selected: ['d'.repeat(40)], approvals: ['owner-ref'], excluded: [], source_ref: 'refs/heads/cpd-hotfix/fixture', mode: 'hotfix' };
  await denied(project, ['release-check', ticket.id, String(held.generation), record.new, 'hotfix'], ticket.capability);
  await denied(project, ['authorize-release', ticket.id, JSON.stringify(record)], supervisor);
  await denied(project, ['authorize-release', ticket.id, JSON.stringify({ ...record, hotfix_signer: 'other', hotfix_approval_ref: 'ref' })], supervisor);
  const signed = { ...record, hotfix_signer: 'Mark Berg', hotfix_approval_ref: 'hot-zone-ref' };
  await denied(project, ['authorize-release', ticket.id, JSON.stringify({ ...signed, hotfix_approval_ref: 'other-ref' })], supervisor);
  await denied(project, ['authorize-release', ticket.id, JSON.stringify({ ...signed, new: 'f'.repeat(40) })], supervisor);
  await denied(project, ['authorize-release', ticket.id, JSON.stringify({ ...signed, mode: 'scoped', source_ref: 'refs/heads/Development', hotfix_signer: undefined, hotfix_approval_ref: undefined })], supervisor);
  await command(project, ['authorize-release', ticket.id, JSON.stringify(signed)], supervisor);
  const checked = await act(project, 'release-check', ticket, String(held.generation), record.new, 'hotfix');
  assert.equal(checked.hotfix_signer, 'Mark Berg');
  const db = new DatabaseSync(join(project, '.git', 'development-team-coordinator.sqlite'));
  db.prepare('UPDATE coordinator_hotfix SET signer = NULL WHERE singleton = 1').run();
  db.close();
  await denied(project, ['release-check', ticket.id, String(held.generation), record.new, 'hotfix'], ticket.capability);
  await denied(project, ['release-check', ticket.id, String(held.generation), record.new, 'scoped'], ticket.capability);
  await denied(project, ['release-check', ticket.id, String(held.generation), 'f'.repeat(40), 'hotfix'], ticket.capability);
});

test('authorized staging hotfix waits for a safe checkpoint, then the holder resumes first', async (t) => {
  const { root, project, worktree } = await fixture(t);
  await command(project, ['authority-init'], supervisor);
  const stage = 'resource:staging';
  const candidate = 'd'.repeat(40);
  const holder = await request(project, 'holder', stage, 'resource:fixture');
  const ordinary = await request(worktree, 'ordinary', stage);
  const hotfix = await request(project, 'hotfix', stage);
  const duplicate = await request(project, 'second-hotfix', stage);
  const fixtureUser = await request(project, 'fixture-user', 'resource:fixture');
  await act(project, 'claim', holder);
  const before = await act(worktree, 'check-held', holder, stage);
  assert.deepEqual(Object.keys(before).sort(), ['generation', 'id', 'project']);
  await denied(project, ['check-held', holder.id, stage], successor);
  await denied(project, ['check-held', holder.id, 'resource:other'], holder.capability);
  await denied(project, ['check-held', hotfix.id, stage], hotfix.capability);
  const other = join(root, 'unrelated');
  git(root, 'init', other);
  await denied(other, ['check-held', holder.id, stage], holder.capability);

  const authorization = ['authorize-hotfix', hotfix.id, candidate, 'mark', 'release-approval-42'];
  await denied(project, authorization, hotfix.capability);
  await denied(project, [...authorization.slice(0, -1), `receipt available through ${supervisor}`], supervisor);
  await command(project, authorization, supervisor);
  await denied(project, authorization, supervisor);
  await denied(project, ['authorize-hotfix', duplicate.id, candidate, 'owner', 'other-approval'], supervisor);
  assert.equal((await act(project, 'claim', hotfix)).state, 'queued');
  await denied(project, ['checkpoint-hotfix', holder.id, String(before.generation + 1), 'checkpoint.json'], holder.capability);
  const evidence = join(root, 'checkpoint.json');
  await writeFile(evidence, JSON.stringify({ [stage]: 'staging-idle' }));
  await denied(project, ['checkpoint-hotfix', holder.id, String(before.generation), evidence], holder.capability);
  await writeFile(evidence, JSON.stringify({ [stage]: 'staging-idle', 'resource:fixture': 'fixture-clean' }));
  await denied(project, ['checkpoint-hotfix', holder.id, String(before.generation), evidence], hotfix.capability);
  await writeFile(evidence, JSON.stringify({ [stage]: `staging-idle ${holder.capability}`, 'resource:fixture': 'fixture-clean' }));
  await denied(project, ['checkpoint-hotfix', holder.id, String(before.generation), evidence], holder.capability);
  await writeFile(evidence, JSON.stringify({ [stage]: 'staging-idle', 'resource:fixture': 'fixture-clean' }));
  await act(project, 'checkpoint-hotfix', holder, String(before.generation), evidence);
  await denied(project, ['checkpoint-hotfix', holder.id, String(before.generation), evidence], holder.capability);
  assert.equal((await act(project, 'claim', ordinary)).state, 'queued');
  assert.equal((await act(project, 'claim', fixtureUser)).state, 'queued');
  assert.equal((await act(project, 'claim', holder)).state, 'queued');
  assert.equal((await act(project, 'claim', hotfix)).state, 'held');
  const priority = await act(project, 'check-held', hotfix, stage, candidate);
  await denied(project, ['check-held', hotfix.id, stage, 'e'.repeat(40)], hotfix.capability);
  assert.ok(priority.generation > before.generation);
  await act(project, 'release', hotfix, `--generation=${priority.generation}`);
  assert.equal((await act(project, 'claim', ordinary)).state, 'queued');
  assert.equal((await act(project, 'claim', holder)).state, 'held');
  const resumed = await act(project, 'check-held', holder, stage);
  assert.ok(resumed.generation > priority.generation);
  await denied(project, ['release', holder.id, `--generation=${before.generation}`], holder.capability);
  await denied(project, ['release', holder.id], holder.capability);
  await act(project, 'release', holder, `--generation=${resumed.generation}`);
  assert.equal((await act(worktree, 'claim', ordinary)).state, 'held');
});

test('hotfix cancellation and quarantine preserve staging exclusivity', async (t) => {
  const { root, project } = await fixture(t);
  const stage = 'resource:staging';
  const candidate = 'd'.repeat(40);
  await command(project, ['authority-init'], supervisor);
  const holder = await request(project, 'holder', stage);
  const ordinary = await request(project, 'ordinary', stage);
  await act(project, 'claim', holder);
  const before = await act(project, 'check-held', holder, stage);
  const hotfix = await request(project, 'hotfix', stage);
  await command(project, ['authorize-hotfix', hotfix.id, candidate, 'owner', 'approval-a'], supervisor);
  const evidence = join(root, 'checkpoint.json');
  await writeFile(evidence, JSON.stringify({ [stage]: 'staging-idle' }));
  await act(project, 'checkpoint-hotfix', holder, String(before.generation), evidence);
  await act(project, 'cancel', hotfix);
  assert.equal((await act(project, 'claim', ordinary)).state, 'queued');
  await act(project, 'claim', holder);
  const resumed = await act(project, 'check-held', holder, stage);
  assert.ok(resumed.generation > before.generation);
  const second = await request(project, 'second-hotfix', stage);
  await command(project, ['authorize-hotfix', second.id, candidate, 'owner', 'approval-b'], supervisor);
  await act(project, 'checkpoint-hotfix', holder, String(resumed.generation), evidence);
  await act(project, 'claim', second);
  await command(project, ['quarantine', second.id, 'worker-unknown'], supervisor);
  await denied(project, ['check-held', second.id, stage, candidate], second.capability);
  assert.equal((await act(project, 'claim', ordinary)).state, 'queued');
  assert.equal((await act(project, 'claim', holder)).state, 'queued');
  await command(project, ['recover', second.id, 'worker-stopped'], `${supervisor}\n${replacement}`);
  await command(project, ['cancel', second.id], replacement);
  assert.equal((await act(project, 'claim', holder)).state, 'held');
});

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
  db.prepare("UPDATE coordinator_grants_v5 SET requested_at = '2020-01-01T00:00:00.000Z' WHERE state != 'held'").run();
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

for (const [version, table] of [[1, 'requests'], [2, 'coordinator_requests']]) {
  test(`v${version} migration preserves held grants and fences legacy writes`, async (t) => {
    const { project } = await fixture(t);
    const { DatabaseSync } = await import('node:sqlite');
    const database = join(project, '.git', 'development-team-coordinator.sqlite');
    const legacy = new DatabaseSync(database);
    const id = randomUUID();
    const digest = createHash('sha256').update(replacement).digest();
    legacy.exec(`CREATE TABLE ${table} (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, capability_hash BLOB NOT NULL,
      owner TEXT NOT NULL, resources TEXT NOT NULL, state TEXT NOT NULL,
      requested_at TEXT, claimed_at TEXT
    ); PRAGMA user_version = ${version};`);
    if (version === 2) legacy.exec('CREATE VIEW requests AS SELECT * FROM coordinator_requests');
    legacy.prepare(`INSERT INTO ${table} (id, capability_hash, owner, resources, state) VALUES (?, ?, ?, ?, ?)`)
      .run(id, digest, 'legacy', JSON.stringify(['resource:runner']), 'held');
    legacy.close();

    await command(project, ['authority-init'], supervisor);
    const held = await command(project, ['check-held', id, 'resource:runner'], replacement);
    assert.equal(held.id, id);
    assert.ok(held.generation > 0);
    const stale = new DatabaseSync(database);
    try {
      assert.throws(() => stale.prepare(`UPDATE ${table} SET state = 'released' WHERE id = ?`).run(id), /cannot modify .*view/);
    } finally {
      stale.close();
    }
    assert.equal((await command(project, ['status'])).requests.find((item) => item.id === id).state, 'held');
    await command(project, ['release', id], replacement);
  });
}
