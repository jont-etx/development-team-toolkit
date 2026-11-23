import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

const BUGGY = 'export const round = (x) => Math.floor(x);\n';
const FIXED = 'export const round = (x) => Math.round(x);\n';
const CHECK = "import { round } from './src/price.mjs';\nprocess.exit(round(2.6) === 3 ? 0 : 1);\n";

test('golden and seeded tasks score contenders from checks, scope and planted bugs, never self-assessment', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'toolkit-evals-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(join(project, 'src'), { recursive: true });
  git(project, 'init', '-q');
  git(project, 'config', 'core.autocrlf', 'false');
  await writeFile(join(project, 'src', 'price.mjs'), BUGGY);
  await writeFile(join(project, 'check.mjs'), CHECK);
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'base');
  const base = git(project, 'rev-parse', 'HEAD');
  await writeFile(join(project, 'src', 'price.mjs'), FIXED);
  git(project, 'commit', '-q', '-am', 'fix rounding');
  const accepted = git(project, 'rev-parse', 'HEAD');

  const handoff = join(root, 'fix-rounding.md');
  await writeFile(handoff, `# Handoff\n\n## Decision\nD-7: prices round to nearest\n\n## Base revision\n${base}\n\n## Owned files\n- src/price.mjs\n\n## Acceptance checks\n- \`node check.mjs\`\n\n## Next owner\nqa-code\n`);
  const golden = ok(project, 'eval', 'harvest', handoff, '--accepted', accepted, '--role', 'developer', '--split', 'train');
  const task = JSON.parse(await readFile(golden.file, 'utf8'));
  assert.deepEqual(task.checks, [['node', 'check.mjs']]);
  assert.deepEqual(task.expect, { ownedFiles: ['src/price.mjs'], changedFiles: ['src/price.mjs'] });

  // Plant the original bug back into the accepted code for reviewers to find.
  const patch = join(root, 'bug.patch');
  await writeFile(patch, git(project, 'diff', accepted, base) + '\n');
  const seeded = ok(project, 'eval', 'seed', golden.task, '--patch', patch, '--file', 'src/price.mjs', '--keyword', 'floor', '--keyword', 'rounding', '--split', 'train');
  assert.equal(JSON.parse(await readFile(seeded.file, 'utf8')).role, 'qa-code');
  await writeFile(join(root, 'bad.patch'), '--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-a\n+b\n');
  assert.match(toolkit(project, 'eval', 'seed', golden.task, '--patch', join(root, 'bad.patch'), '--file', 'x', '--keyword', 'y').stderr, /does not apply/);

  // Stand-in agents: good does the work and finds the bug; lazy does nothing; overreach edits a file it does not own.
  const agent = join(root, 'agent.mjs');
  await writeFile(agent, `import { writeFileSync } from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const mode = process.argv[2];
if (input.includes('Review the uncommitted change')) {
  console.log(mode === 'lazy' ? 'Looks fine to me.' : 'src/price.mjs line 1: uses Math.floor, so rounding is wrong for 2.6.');
} else if (mode !== 'lazy') {
  writeFileSync('src/price.mjs', ${JSON.stringify(FIXED)});
  if (mode === 'overreach') writeFileSync('src/extra.mjs', 'export {};\\n');
}
`);
  const spec = join(root, 'contenders.json');
  await writeFile(spec, JSON.stringify({ runs: 1, contenders: {
    good: { command: [process.execPath, agent, 'good'], version: 'v2' },
    lazy: { command: [process.execPath, agent, 'lazy'], version: 'v1' },
    overreach: { command: [process.execPath, agent, 'overreach'] },
  } }));
  const developer = ok(project, 'eval', 'run', spec, '--role', 'developer');
  assert.deepEqual(developer.summary.developer['good@v2'].train, { passed: 1, runs: 1 });
  assert.deepEqual(developer.summary.developer['lazy@v1'].train, { passed: 0, runs: 1 });
  assert.deepEqual(developer.summary.developer.overreach.train, { passed: 0, runs: 1 }); // checks pass, scope fails
  const reviewer = ok(project, 'eval', 'run', spec, '--role', 'qa-code', '--task', seeded.task);
  assert.deepEqual(reviewer.summary['qa-code']['good@v2'].seeded, { passed: 1, runs: 1 });
  assert.deepEqual(reviewer.summary['qa-code']['lazy@v1'].seeded, { passed: 0, runs: 1 });
  const ledger = (await readFile(join(project, '.development-team', 'evals', 'ledger.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(ledger.length, 6);
  assert.deepEqual(ledger.find((row) => row.contender === 'overreach').outside, ['src/extra.mjs']);
  assert.ok(!(await readdir(join(project, '.git', 'worktrees')).catch(() => [])).length, 'throwaway worktrees are removed');

  const rework = ok(project, 'eval', 'outcome', handoff, '--role', 'developer', '--result', 'rework', '--defects', '2', '--version', 'v2');
  assert.match(rework.next, /regression/);
  ok(project, 'eval', 'outcome', handoff, '--role', 'developer', '--result', 'accepted', '--version', 'v2');
  const summary = ok(project, 'eval', 'report');
  assert.deepEqual(summary.tasks, { developer: { 'golden/train': 1 }, 'qa-code': { 'seeded/train': 1 } });
  assert.deepEqual(summary.outcomes.developer.v2, { handoffs: 2, accepted: 1, rework: 1, rejected: 0, defects: 2 });
  assert.deepEqual(summary.scores['qa-code']['good@v2'].seeded, { passed: 1, runs: 1 });

  // --evals-dir keeps tasks in another repository; the replayed code stays in this one.
  const external = join(root, 'wiki-evals');
  ok(project, 'eval', '--evals-dir', external, 'harvest', handoff, '--accepted', accepted, '--role', 'developer', '--id', 'elsewhere');
  assert.deepEqual(ok(project, 'eval', 'report', '--evals-dir', external).tasks, { developer: { [`golden/${JSON.parse(await readFile(join(external, 'tasks', 'developer', 'elsewhere.json'), 'utf8')).split}`]: 1 } });
  await writeFile(join(root, 'nochecks.md'), `## Base revision\n${base}\n\n## Owned files\n- src/price.mjs\n\n## Acceptance checks\n- prices look right\n`);
  assert.match(toolkit(project, 'eval', 'harvest', join(root, 'nochecks.md'), '--accepted', accepted, '--role', 'developer').stderr, /No runnable checks/);
  assert.match(toolkit(project, 'eval', 'outcome', handoff, '--role', 'developer', '--result', 'great').stderr, /Usage: eval outcome/);
});
