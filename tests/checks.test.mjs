import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizeChecks } from '../plugins/development-team-toolkit/bin/evals.mjs';

const cli = fileURLToPath(new URL('../plugins/development-team-toolkit/bin/toolkit.mjs', import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const ok = (cwd, ...args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('the check report separates useful, useless and noisy checks, and lists failures no check caught', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'toolkit-checks-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(join(project, 'src'), { recursive: true });
  git(project, 'init', '-q');
  git(project, 'config', 'core.autocrlf', 'false');
  await writeFile(join(project, 'src', 'price.mjs'), 'export const round = (x) => Math.floor(x);\n');
  await writeFile(join(project, 'useful.mjs'), "import { round } from './src/price.mjs';\nprocess.exit(round(2.6) === 3 ? 0 : 1);\n");
  await writeFile(join(project, 'useless.mjs'), 'process.exit(0);\n');
  await writeFile(join(project, 'noisy.mjs'), 'process.exit(1);\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'base');
  const base = git(project, 'rev-parse', 'HEAD');
  await writeFile(join(project, 'src', 'price.mjs'), 'export const round = (x) => Math.round(x);\n');
  git(project, 'commit', '-q', '-am', 'fix rounding');
  const accepted = git(project, 'rev-parse', 'HEAD');

  const handoff = join(root, 'fix.md');
  await writeFile(handoff, `## Decision\nD-1\n\n## Base revision\n${base}\n\n## Owned files\n- src/price.mjs\n\n## Acceptance checks\n- rounds\n\n## Next owner\nqa-code\n`);
  const golden = ok(project, 'eval', 'harvest', handoff, '--accepted', accepted, '--role', 'developer', '--id', 'fix-rounding',
    '--check', 'node useful.mjs', '--check', 'node useless.mjs', '--check', 'node noisy.mjs');
  const patch = join(root, 'bug.patch');
  await writeFile(patch, `${git(project, 'diff', accepted, base)}\n`);
  ok(project, 'eval', 'seed', golden.task, '--patch', patch, '--file', 'src/price.mjs', '--keyword', 'floor');

  const measured = ok(project, 'eval', 'checks');
  assert.equal(measured.rows, 9); // 3 checks x (base, accepted, planted bug)
  const useful = measured.report['node useful.mjs'];
  assert.deepEqual([useful.catchable, useful.caught, useful.falseAlarms], [2, 2, 0]);
  assert.deepEqual([measured.report['node useless.mjs'].caught, measured.report['node useless.mjs'].falseAlarms], [0, 0]);
  assert.equal(measured.report['node noisy.mjs'].falseAlarms, 1);
  assert.match(measured.report['node noisy.mjs'].suggestion, /false alarms/);
  assert.match(useful.suggestion, /too few samples/);

  // A ledger row from a reviewer run feeds the reviewer section of the report.
  const dir = join(project, '.development-team', 'evals');
  await writeFile(join(dir, 'ledger.jsonl'), `${JSON.stringify({ kind: 'seeded', role: 'qa-code', contender: 'claude', version: 'v1', passed: true })}\n`, { flag: 'a' });
  await writeFile(join(project, '.development-team', 'seed.json'), JSON.stringify({ schemaVersion: 1, id: 'p', title: 'P', evals: { protectedChecks: ['useless.mjs'] } }));
  ok(project, 'init', '.development-team/seed.json');
  const report = ok(project, 'eval', 'check-report');
  assert.equal(report.checks['node useless.mjs'].protected, true);
  assert.deepEqual(report.reviewers['qa-code']['claude@v1'], { planted: 1, caught: 1, catchRate: 1 });
  assert.deepEqual(report.gaps, []); // the useful check caught every failure state
  assert.ok((await readFile(join(dir, 'checks.jsonl'), 'utf8')).trim().split('\n').length === 9);
});

test('suggestions need enough samples, never retire protected checks, and flag weak ones for the owner', () => {
  const rows = (check, caught) => Array.from({ length: 6 }, (_, i) => ({ task: `t${i}`, state: 'base', expect: 'fail', check, caught: i < caught, seconds: 2 }));
  const summary = summarizeChecks([...rows('node weak.mjs', 0), ...rows('node guard.mjs', 0), ...rows('node strong.mjs', 5)], ['guard.mjs']);
  assert.match(summary['node weak.mjs'].suggestion, /consider retiring \(owner decides\)/);
  assert.match(summary['node guard.mjs'].suggestion, /protected: keep/);
  assert.equal(summary['node strong.mjs'].suggestion, 'earning its place');
  assert.equal(summary['node strong.mjs'].catchRate, 0.83);
  assert.deepEqual(summary['node weak.mjs'].missed.length, 6);
});
