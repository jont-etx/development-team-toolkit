import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { judgePrompt, parseVerdict } from '../plugins/development-team-toolkit/bin/judged.mjs';

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

test('judged roles: outputs are saved, judged blind, and count only once owner labels calibrate the judge', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'toolkit-judged-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  git(project, 'init', '-q');
  await writeFile(join(project, 'spec.md'), '# Spec\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'base');
  const base = git(project, 'rev-parse', 'HEAD');

  const evals = join(root, 'evals');
  await mkdir(join(evals, 'tasks', 'designer'), { recursive: true });
  await mkdir(join(evals, 'rubrics'), { recursive: true });
  await writeFile(join(evals, 'rubrics', 'designer.md'), '- Covers empty, loading, error and mobile states.\n');
  await writeFile(join(evals, 'tasks', 'designer', 'checkout-states.json'), JSON.stringify({ schemaVersion: 1, id: 'checkout-states', role: 'designer',
    kind: 'judged', split: 'train', base, prompt: 'Design the checkout states.', rubric: 'rubrics/designer.md', reference: 'GOOD: all four states, accepted.' }));

  // Stand-ins: the good designer covers the states; the weak one does not. The judge prefers outputs marked GOOD.
  const agent = join(root, 'agent.mjs');
  await writeFile(agent, `let input = ''; for await (const c of process.stdin) input += c;\nconsole.log(process.argv[2] === 'good' ? 'GOOD: empty, loading, error, mobile.' : 'Just the happy path.');\n`);
  const judgeScript = join(root, 'judge.mjs');
  await writeFile(judgeScript, `let input = ''; for await (const c of process.stdin) input += c;
const part = (name) => input.split('## Output ' + name)[1].split('>>>')[0];
const a = part('A').includes('GOOD'); const b = part('B').includes('GOOD');
console.log('thinking...');
console.log(JSON.stringify({ winner: a === b ? 'tie' : a ? 'A' : 'B', reasons: 'state coverage' }));\n`);
  const spec = join(root, 'contenders.json');
  await writeFile(spec, JSON.stringify({ runs: 3, contenders: {
    designer: { command: [process.execPath, agent, 'weak'], version: 'v1' },
    'designer-challenger': { command: [process.execPath, agent, 'good'], version: 'v2' } } }));
  const judgeFile = join(root, 'judge.json');
  await writeFile(judgeFile, JSON.stringify({ name: 'stand-in-judge', command: [process.execPath, judgeScript] }));

  const generated = ok(project, 'eval', 'generate', spec, '--role', 'designer', '--evals-dir', evals);
  assert.equal(generated.outputs, 6);
  assert.equal((await readdir(join(evals, 'outputs', 'designer', 'checkout-states'))).length, 6);
  assert.match(toolkit(project, 'eval', 'run', spec, '--role', 'designer', '--split', 'all', '--evals-dir', evals).stderr, /eval generate and eval judge/);

  const scorecard = ok(project, 'eval', 'judge', judgeFile, '--role', 'designer', '--evals-dir', evals);
  assert.equal(scorecard.judged, 6);
  assert.equal(ok(project, 'eval', 'judge', judgeFile, '--role', 'designer', '--evals-dir', evals).judged, 0, 'judged pairs are not judged again');
  const pairs = ok(project, 'eval', 'judge', judgeFile, '--role', 'designer', '--champion', 'v1', '--challenger', 'v2', '--evals-dir', evals);
  assert.equal(pairs.judged, 3);
  const report = ok(project, 'eval', 'report', '--evals-dir', evals);
  assert.deepEqual(report.scores.designer['designer-challenger@v2'].train, { passed: 6, runs: 6 }); // ties with accepted, beats v1
  assert.deepEqual(report.scores.designer['designer@v1'].train, { passed: 0, runs: 6 });

  // Until the owner has labeled enough pairs, judged scores cannot promote anything.
  const compare = () => ok(project, 'eval', 'compare', '--role', 'designer', '--champion', 'v1', '--challenger', 'v2', '--evals-dir', evals);
  assert.equal(compare().verdict, 'judge-not-calibrated');
  assert.match(ok(project, 'eval', 'readiness', '--role', 'designer', '--version', 'v1', '--evals-dir', evals).reasons[0], /judge not calibrated/);

  // The owner grades blind: the export shows only A and B, never which version wrote which.
  const pack = ok(project, 'eval', 'labels', 'export', '--role', 'designer', '--count', '5', '--evals-dir', evals);
  assert.equal(pack.items.length, 5);
  assert.ok(!JSON.stringify(pack.items).includes('v2') && !JSON.stringify(pack.items).includes('challenger'));
  const choose = (item) => (item.A.includes('GOOD') === item.B.includes('GOOD') ? 'tie' : item.A.includes('GOOD') ? 'A' : 'B');
  const answers = join(root, 'answers.json');
  await writeFile(answers, JSON.stringify({ pack: pack.pack, answers: pack.items.map((item) => ({ item: item.item, choice: choose(item) })) }));
  const imported = ok(project, 'eval', 'labels', 'import', answers, '--evals-dir', evals);
  assert.deepEqual([imported.recorded, imported.agreed], [5, 5]);
  assert.equal(ok(project, 'eval', 'labels', 'import', answers, '--evals-dir', evals).recorded, 0, 'a pack is imported once');
  assert.equal(ok(project, 'eval', 'calibration', '--role', 'designer', '--evals-dir', evals).calibrated, true);
  const verdict = compare();
  assert.equal(verdict.verdict, 'promote');

  // An owner who disagrees with the judge pulls it below 80% and judged scores stop counting again.
  const next = ok(project, 'eval', 'labels', 'export', '--role', 'designer', '--count', '4', '--evals-dir', evals);
  const flip = (item) => ({ A: 'B', B: 'A', tie: 'A' }[choose(item)]);
  await writeFile(answers, JSON.stringify({ pack: next.pack, answers: next.items.map((item) => ({ item: item.item, choice: flip(item), note: 'judge missed this' })) }));
  assert.equal(ok(project, 'eval', 'labels', 'import', answers, '--evals-dir', evals).agreed, 0);
  const judgeState = ok(project, 'eval', 'calibration', '--role', 'designer', '--evals-dir', evals);
  assert.deepEqual([judgeState.labels, judgeState.agreement, judgeState.calibrated], [9, 0.56, false]);
  assert.equal(compare().verdict, 'judge-not-calibrated');
});

test('judge prompt hides authorship and the verdict parser takes only a valid last verdict', () => {
  const prompt = judgePrompt({ rubric: 'R', brief: 'B', a: 'first', b: 'second', context: 'accepted text' });
  assert.match(prompt, /context only/);
  assert.match(prompt, /Do not score closeness/);
  assert.ok(!/v1|v2|champion|challenger/.test(prompt));
  assert.equal(judgePrompt({ rubric: 'R', brief: 'B', a: 'x', b: 'y' }).includes('context only'), false);
  assert.deepEqual(parseVerdict('blah {"winner": "A", "reasons": "x"} more {"winner": "tie", "reasons": "y"}'), { winner: 'tie', reasons: 'y' });
  assert.equal(parseVerdict('{"winner": "C"}'), null);
  assert.equal(parseVerdict('no verdict'), null);
});
