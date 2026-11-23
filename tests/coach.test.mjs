import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../plugins/development-team-toolkit/bin/toolkit.mjs', import.meta.url));
const toolkit = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const ok = (cwd, ...args) => {
  const result = toolkit(cwd, ...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

const BASE = 'a'.repeat(40);
const task = (id, split, severity) => ({ schemaVersion: 1, id, role: 'qa-code', kind: 'seeded', split, base: BASE, prompt: 'Review it.',
  ...(severity ? { severity } : {}), seeded: { patch: '--- a/x\n+++ b/x\n', file: `src/${id}.mjs`, keywords: ['bug'] } });
// passes: one boolean per run
const rows = (version, id, split, passes, seconds = 10) => passes.map((passed, i) => ({
  contender: 'qa-code', version, role: 'qa-code', task: id, kind: 'seeded', split, run: i + 1, agentExit: 0, seconds, passed }));

async function project(t, tasks, ledger) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'toolkit-coach-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'evals');
  await mkdir(join(dir, 'tasks', 'qa-code'), { recursive: true });
  await mkdir(join(dir, 'ledger'), { recursive: true });
  for (const item of tasks) await writeFile(join(dir, 'tasks', 'qa-code', `${item.id}.json`), JSON.stringify(item));
  await writeFile(join(dir, 'ledger', '20261123T080000Z-aaaaaa.jsonl'), `${ledger.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return { root, dir };
}

const TASKS = [task('t1', 'train'), task('t2', 'train', 'high'), task('h1', 'holdout')];

test('misses name training misses only and count holdout misses without naming them', async (t) => {
  const { root, dir } = await project(t, TASKS, [
    ...rows('v1', 't1', 'train', [false, true]), ...rows('v1', 't2', 'train', [true, true]), ...rows('v1', 'h1', 'holdout', [false, false]),
    { ...rows('v1', 't2', 'train', [false])[0], agentExit: null, agentError: 'spawn failed' }, // never started: not a miss
  ]);
  const result = ok(root, 'eval', 'misses', '--role', 'qa-code', '--version', 'v1', '--evals-dir', dir);
  assert.deepEqual(result.train.map((item) => [item.task, item.missed, item.runs, item.file]), [['t1', 1, 2, 'src/t1.mjs']]);
  assert.equal(result.holdoutMissed, 1);
  assert.ok(!JSON.stringify(result).includes('h1'), 'holdout task ids stay hidden from the coach');
});

test('readiness proposes at once for serious misses, waits for minor ones, and otherwise waits for the review day', async (t) => {
  const many = Array.from({ length: 10 }, (_, i) => task(`m${i}`, i < 8 ? 'train' : 'holdout', 'low'));
  const ask = (dir, root, version, today) => ok(root, 'eval', 'readiness', '--role', 'qa-code', '--version', version, '--today', today, '--evals-dir', dir);
  const { root, dir } = await project(t, [...TASKS, ...many], [
    // v-short: not enough runs yet
    ...rows('v-short', 't1', 'train', [true]),
    // v-severe: the high-severity task missed twice
    ...['t1', 'h1', ...many.map((item) => item.id)].flatMap((id) => rows('v-severe', id, id.startsWith('h') || id === 'm8' || id === 'm9' ? 'holdout' : 'train', [true, true])),
    ...rows('v-severe', 't2', 'train', [false, false]),
    // v-minor: one low-severity training miss in two runs, everything else passes
    ...[...TASKS, ...many].flatMap((item) => rows('v-minor', item.id, item.split, item.id === 'm0' ? [false, true] : [true, true])),
    // v-clean: nothing missed
    ...[...TASKS, ...many].flatMap((item) => rows('v-clean', item.id, item.split, [true, true])),
    // v-moderate: two medium training misses over enough runs, below the urgent rate
    ...[...TASKS, ...many].flatMap((item) => rows('v-moderate', item.id, item.split, item.id === 't1' ? [false, true, true, true] : [true, true, true, true])),
  ]);
  assert.equal(ask(dir, root, 'v-short', '2026-11-24').urgency, 'wait');
  const severe = ask(dir, root, 'v-severe', '2026-11-24'); // a Tuesday
  assert.deepEqual([severe.urgency, severe.mode, severe.next], ['urgent', 'fix', 'propose now']);
  assert.match(severe.reasons[0], /t2/);
  const minor = ask(dir, root, 'v-minor', '2026-11-30'); // a Monday, but too few runs on a minor miss
  assert.equal(minor.urgency, 'wait');
  assert.match(minor.reasons[0], /minor/);
  assert.equal(ask(dir, root, 'v-moderate', '2026-11-25').urgency, 'wait');
  const monday = ask(dir, root, 'v-moderate', '2026-11-30');
  assert.deepEqual([monday.urgency, monday.mode], ['review', 'fix']);
  assert.equal(ask(dir, root, 'v-clean', '2026-11-25').urgency, 'wait');
  assert.deepEqual([ask(dir, root, 'v-clean', '2026-11-30').urgency, ask(dir, root, 'v-clean', '2026-11-30').mode], ['review', 'removal']);
  assert.match(toolkit(root, 'eval', 'readiness', '--role', 'qa-code', '--version', 'v1', '--review-day', 'someday', '--evals-dir', dir).stderr, /review-day/);
});

test('compare promotes only a strict win, or a tie at clearly lower cost', async (t) => {
  const { root, dir } = await project(t, TASKS, [
    ...rows('champ', 't1', 'train', [false, false]), ...rows('champ', 't2', 'train', [true, true]), ...rows('champ', 'h1', 'holdout', [false, true]),
    // better: higher on train and holdout, keeps t2
    ...rows('better', 't1', 'train', [true, true]), ...rows('better', 't2', 'train', [true, true]), ...rows('better', 'h1', 'holdout', [true, true]),
    // overfit: fixes t1 but not holdout
    ...rows('overfit', 't1', 'train', [true, true]), ...rows('overfit', 't2', 'train', [true, true]), ...rows('overfit', 'h1', 'holdout', [false, true]),
    // breaks: fixes t1 and h1 but loses t2, which the champion always passed
    ...rows('breaks', 't1', 'train', [true, true]), ...rows('breaks', 't2', 'train', [true, false]), ...rows('breaks', 'h1', 'holdout', [true, true]),
    // smaller: same scores as the champion
    ...rows('smaller', 't1', 'train', [false, false]), ...rows('smaller', 't2', 'train', [true, true]), ...rows('smaller', 'h1', 'holdout', [false, true]),
    ...rows('thin', 't1', 'train', [true]),
  ]);
  const cmp = (challenger, ...extra) => ok(root, 'eval', 'compare', '--role', 'qa-code', '--champion', 'champ', '--challenger', challenger, '--evals-dir', dir, ...extra);
  const better = cmp('better');
  assert.equal(better.verdict, 'promote');
  assert.deepEqual(better.sets.train, { champion: 0.5, challenger: 1 });
  assert.equal(cmp('overfit').verdict, 'keep');
  const breaks = cmp('breaks');
  assert.deepEqual([breaks.verdict, breaks.regressions], ['keep', ['t2']]);
  assert.equal(cmp('smaller').verdict, 'keep'); // a tie needs clearly lower cost
  assert.equal(cmp('smaller', '--champion-cost', '1400', '--challenger-cost', '1100').verdict, 'promote');
  assert.equal(cmp('smaller', '--champion-cost', '1400', '--challenger-cost', '1350').verdict, 'keep');
  assert.equal(cmp('thin').verdict, 'insufficient-runs');
  assert.match(toolkit(root, 'eval', 'compare', '--role', 'qa-code', '--champion', 'champ', '--challenger', 'champ', '--evals-dir', dir).stderr, /Usage: eval compare/);
});

test('the watch window keeps or reverts a promotion from live handoff outcomes', async (t) => {
  const { root, dir } = await project(t, TASKS, []);
  await mkdir(join(dir, 'outcomes'), { recursive: true });
  const outcome = (version, at, result, defects = 0) => ({ at, role: 'qa-code', version, result, defects, handoff: 'h.md' });
  const old = Array.from({ length: 4 }, (_, i) => outcome('v1', `2026-11-0${i + 1}T10:00:00Z`, 'accepted'));
  const bad = Array.from({ length: 3 }, (_, i) => outcome('v2', `2026-12-0${i + 1}T10:00:00Z`, 'rework', 1));
  await writeFile(join(dir, 'outcomes', '20261101T000000Z-aaaaaa.jsonl'), `${old.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await writeFile(join(dir, 'outcomes', '20261201T000000Z-bbbbbb.jsonl'), `${bad.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const watch = (today, ...extra) => ok(root, 'eval', 'watch', '--role', 'qa-code', '--promoted', 'v2', '--previous', 'v1', '--since', '2026-11-30', '--today', today, '--evals-dir', dir, ...extra);
  const open = watch('2026-12-04');
  assert.deepEqual([open.verdict, open.after.handoffs, open.after.acceptRate, open.before.acceptRate], ['watching', 3, 0, 1]);
  assert.equal(watch('2026-12-04', '--hot').verdict, 'revert'); // hot-path roles revert at once
  const closed = watch('2026-12-15');
  assert.equal(closed.verdict, 'revert');
  assert.match(closed.reason, /acceptance 1 -> 0/);
  const quiet = ok(root, 'eval', 'watch', '--role', 'qa-code', '--promoted', 'v3', '--previous', 'v1', '--since', '2026-11-30', '--today', '2026-12-20', '--evals-dir', dir);
  assert.deepEqual([quiet.verdict, quiet.reason], ['keep', 'window closed; too few handoffs to judge a drop']);
  // eval outcome now writes one file per outcome, so parallel sessions never edit the same file.
  const recorded = ok(root, 'eval', 'outcome', join(root, 'h.md'), '--role', 'qa-code', '--result', 'accepted', '--version', 'v2', '--evals-dir', dir);
  assert.match(recorded.file, /outcomes\/\d{8}T\d{6}Z-[0-9a-f]{6}\.jsonl$/);
});
