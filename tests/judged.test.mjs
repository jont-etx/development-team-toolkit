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
  await writeFile(agent, `let input = ''; for await (const c of process.stdin) input += c;\n(await import('node:fs')).writeFileSync('DELIVERABLE.md', process.argv[2] === 'good' ? 'GOOD: empty, loading, error, mobile.' : 'Just the happy path.');\n`);
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

test('only a delivered file counts, the workspace hides history and evals, and old captures never score', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'toolkit-capture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const evals = join(project, 'wiki', 'evals');
  await mkdir(join(evals, 'tasks', 'designer'), { recursive: true });
  await mkdir(join(evals, 'rubrics'));
  git(project, 'init', '-q');
  await writeFile(join(project, 'spec.md'), '# Spec\n');
  await writeFile(join(evals, 'answer.md'), 'SECRET-EVALS\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'base');
  const base = git(project, 'rev-parse', 'HEAD');
  await writeFile(join(project, 'accepted.md'), 'SECRET-LATER\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'accepted page');
  // Generate from a linked worktree's evals folder, as CPD does.
  const linked = join(root, 'linked');
  git(project, 'worktree', 'add', '-q', '--detach', linked);
  const dir = join(linked, 'wiki', 'evals');
  await mkdir(join(dir, 'tasks', 'designer'), { recursive: true });
  await mkdir(join(dir, 'rubrics'), { recursive: true });
  await writeFile(join(dir, 'rubrics', 'designer.md'), '- R\n');
  await writeFile(join(dir, 'tasks', 'designer', 't.json'), JSON.stringify({ schemaVersion: 1, id: 't', role: 'designer', kind: 'judged', split: 'train', base,
    prompt: 'Design it.', rubric: 'rubrics/designer.md', reference: 'accepted' }));
  const outside = join(root, 'outside.md');
  await writeFile(outside, 'SECRET-OUTSIDE\n');
  const agent = join(root, 'agent.mjs');
  await writeFile(agent, `import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
for await (const c of process.stdin) void c;
const mode = process.argv[2];
console.log('I wrote the spec elsewhere.');
if (mode === 'linked') fs.linkSync(${JSON.stringify(outside)}, 'DELIVERABLE.md');
if (mode === 'empty') fs.writeFileSync('DELIVERABLE.md', '  ');
if (mode === 'file') {
  fs.appendFileSync('spec.md', 'more');
  fs.writeFileSync('REASONS.md', 'because');
  fs.writeFileSync('DELIVERABLE.md', JSON.stringify({ files: fs.readdirSync('.').sort(), evals: fs.existsSync('wiki/evals'), log: spawnSync('git', ['log', '--all']).status }));
}\n`);
  const spec = join(root, 'contenders.json');
  const command = (mode) => ({ command: [process.execPath, agent, mode], version: 'v1' });
  await writeFile(spec, JSON.stringify({ runs: 1, contenders: { file: command('file'), summary: command('summary'), empty: command('empty'), linked: command('linked') } }));
  const result = ok(project, 'eval', 'generate', spec, '--role', 'designer', '--evals-dir', dir);
  assert.equal(result.outputs, 1);
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors.every((error) => /no usable DELIVERABLE/.test(error)), result.errors.join('\n'));
  const folder = join(dir, 'outputs', 'designer', 't');
  const [name] = await readdir(folder);
  const saved = JSON.parse(await readFile(join(folder, name), 'utf8'));
  const seen = JSON.parse(saved.output);
  assert.deepEqual(seen.files, ['REASONS.md', 'spec.md']);
  assert.equal(seen.evals, false);
  assert.notEqual(seen.log, 0, 'no Git history in the workspace');
  assert.deepEqual([saved.reasons, saved.message.trim()], ['because', 'I wrote the spec elsewhere.']);
  assert.deepEqual(saved.changed, ['DELIVERABLE.md', 'REASONS.md', 'spec.md']);
  assert.equal(git(project, 'status', '--porcelain'), '', 'the export leaves the project index alone');

  // An old-capture output and its score are ignored; the judge runs in an empty folder and sees no reasons.
  await writeFile(join(folder, 'old.json'), JSON.stringify({ ...saved, schemaVersion: 1 }));
  await mkdir(join(dir, 'ledger'), { recursive: true });
  await writeFile(join(dir, 'ledger', 'old.jsonl'), `${JSON.stringify({ role: 'designer', task: 't', kind: 'judged', split: 'train', contender: 'old', version: 'v0', passed: true, pair: 'p' })}\n`);
  const judgeScript = join(root, 'judge.mjs');
  await writeFile(judgeScript, `import fs from 'node:fs'; let input = ''; for await (const c of process.stdin) input += c;
if (fs.readdirSync('.').length || input.includes('because') || input.includes('elsewhere')) process.exit(3);
console.log('{"winner": "tie", "reasons": "r"}');\n`);
  const judgeFile = join(root, 'judge.json');
  await writeFile(judgeFile, JSON.stringify({ name: 'j', command: [process.execPath, judgeScript] }));
  const judged = ok(project, 'eval', 'judge', judgeFile, '--role', 'designer', '--evals-dir', dir);
  assert.deepEqual([judged.judged, judged.errors], [1, []]);
  assert.deepEqual(Object.keys(ok(project, 'eval', 'report', '--evals-dir', dir).scores.designer), ['file@v1']);
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
