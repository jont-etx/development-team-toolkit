// Improvement loop, phase 3: judged roles. Roles whose work is prose (interview plans, architecture, designs) have no
// deterministic check, so a judge from the other model family compares outputs blind against the role's rubric, and
// the owner's weekly blind labels decide whether the judge is trusted (`eval calibration`).
//   eval generate   run contenders on judged tasks and save their outputs (no scoring; can run where no judge is)
//   eval judge      score saved outputs blind: against the accepted output, or champion against challenger
//   eval labels     export a few judged pairs for the owner to grade blind, then import the answers
import { createHash, randomInt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { run } from './eval.mjs';
import { loadTasks, readContenders, readRows, writeRows } from './evals.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const rand = () => createHash('sha256').update(`${process.pid}-${Math.random()}`).digest('hex').slice(0, 6);
const rel = (from, file) => relative(from, file).split('\\').join('/');

/** Run contenders on judged tasks in throwaway worktrees and save each output as its own file. */
export async function generate(project, dir, specFile, { role, split = 'all', task: only } = {}) {
  const { runs, contenders } = await readContenders(specFile);
  const tasks = (await loadTasks(dir, { role, split, task: only })).filter((task) => task.kind === 'judged');
  if (!tasks.length) throw new Error('No judged tasks match.');
  const files = [];
  const errors = [];
  for (const task of tasks) {
    const timeoutMs = (task.timeoutSeconds ?? 1800) * 1000;
    for (const [contender, { command, version }] of contenders) {
      for (let attempt = 1; attempt <= runs; attempt += 1) {
        const scratch = await mkdtemp(join(tmpdir(), 'toolkit-generate-'));
        const worktree = join(scratch, 'work');
        git(project, 'worktree', 'add', '--detach', worktree, task.base);
        try {
          const agent = await run(command, worktree, task.prompt, timeoutMs, { captureOutput: true });
          if (agent.code === null || agent.code !== 0 || !String(agent.output ?? '').trim()) {
            errors.push(`${task.id} ${contender} run ${attempt}: ${agent.error ?? `exit ${agent.code}, ${String(agent.output ?? '').trim() ? 'output kept' : 'no output'}`}`);
            if (agent.code === null || !String(agent.output ?? '').trim()) continue;
          }
          const folder = join(dir, 'outputs', task.role, task.id);
          await mkdir(folder, { recursive: true });
          const file = join(folder, `${stamp()}-${rand()}.json`);
          await writeFile(file, `${JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), role: task.role, task: task.id, split: task.split,
            contender, version: version ?? null, run: attempt, agentExit: agent.code, seconds: agent.seconds ?? null, output: agent.output }, null, 2)}\n`, { flag: 'wx' });
          files.push(rel(project, file));
        } finally {
          git(project, 'worktree', 'remove', '--force', worktree);
          await rm(scratch, { recursive: true, force: true });
        }
      }
    }
  }
  return { tasks: tasks.length, outputs: files.length, files, errors };
}

async function readOutputs(dir, role) {
  const root = join(dir, 'outputs', role);
  if (!existsSync(root)) return [];
  const out = [];
  for (const taskDir of (await readdir(root)).sort()) {
    for (const name of (await readdir(join(root, taskDir))).filter((file) => file.endsWith('.json')).sort()) {
      out.push({ ...JSON.parse(await readFile(join(root, taskDir, name), 'utf8')), file: `${taskDir}/${name}` });
    }
  }
  return out;
}

export function judgePrompt({ rubric, brief, a, b, context }) {
  return [
    'You are a blind judge comparing two outputs for the same task. You do not know who wrote either one.',
    '', '## Rubric', rubric.trim(), '', '## Task brief', brief.trim(), '',
    ...(context ? ['## What the owner accepted for this task (context only)',
      'Use this to spot missed or invented requirements. Do not score closeness to it: a different answer that meets the rubric better should win.',
      '<<<', context.trim(), '>>>', ''] : []),
    '## Output A', '<<<', a.trim(), '>>>', '', '## Output B', '<<<', b.trim(), '>>>', '',
    'Compare A and B on the rubric only. Ignore length, tone and formatting unless the rubric names them.',
    'End your reply with one line holding only a JSON object: {"winner": "A" | "B" | "tie", "reasons": "one or two sentences"}',
  ].join('\n');
}

export function parseVerdict(text) {
  const found = String(text ?? '').match(/\{[^{}]*"winner"[^{}]*\}/g);
  if (!found) return null;
  try {
    const verdict = JSON.parse(found[found.length - 1]);
    return ['A', 'B', 'tie'].includes(verdict.winner) ? { winner: verdict.winner, reasons: String(verdict.reasons ?? '').slice(0, 500) } : null;
  } catch { return null; }
}

/**
 * Score saved outputs blind. Default: each output against the accepted output (passes on a win or tie, so a
 * scorecard shows how often a version is at least as good as accepted work). With --champion and --challenger:
 * their outputs are paired per task, with the accepted output as context, and each side passes on a win or tie.
 */
export async function judge(dir, judgeFile, { role, champion, challenger, task: only, timeoutSeconds = 600 } = {}) {
  if (!SLUG.test(role ?? '') || Boolean(champion) !== Boolean(challenger)) {
    throw new Error('Usage: eval judge <judge.json> --role <id> [--champion <version> --challenger <version>] [--task <id>]');
  }
  const spec = JSON.parse(await readFile(judgeFile, 'utf8'));
  if (!Array.isArray(spec.command) || !spec.command.length || !SLUG.test(spec.name ?? '')) {
    throw new Error('A judge file needs a slug "name" and a "command" list; the command reads the prompt on standard input.');
  }
  const tasks = new Map((await loadTasks(dir, { role, split: 'all', task: only })).filter((task) => task.kind === 'judged').map((task) => [task.id, task]));
  if (!tasks.size) throw new Error(`No judged tasks for ${role}.`);
  const done = new Set((await readRows(dir, 'ledger')).filter((row) => row.kind === 'judged').map((row) => row.pair));
  const outputs = (await readOutputs(dir, role)).filter((item) => tasks.has(item.task));
  const pairs = [];
  if (!champion) {
    for (const item of outputs) pairs.push({ task: tasks.get(item.task), sides: { output: item, accepted: null }, mode: 'accepted' });
  } else {
    for (const task of tasks.values()) {
      const left = outputs.filter((item) => item.task === task.id && item.version === champion);
      const right = outputs.filter((item) => item.task === task.id && item.version === challenger);
      for (let i = 0; i < Math.min(left.length, right.length); i += 1) pairs.push({ task, sides: { champion: left[i], challenger: right[i] }, mode: 'pair' });
    }
  }
  const rows = [];
  const errors = [];
  for (const pair of pairs) {
    const id = createHash('sha256').update(`${pair.mode}:${Object.values(pair.sides).map((side) => side?.file ?? 'accepted').join('|')}`).digest('hex').slice(0, 16);
    if (done.has(id)) continue;
    const names = Object.keys(pair.sides);
    const order = randomInt(2) ? names : [...names].reverse();
    const text = (name) => pair.sides[name]?.output ?? pair.task.reference;
    const rubric = await readFile(join(dir, pair.task.rubric), 'utf8');
    const prompt = judgePrompt({ rubric, brief: pair.task.prompt, a: text(order[0]), b: text(order[1]), context: pair.mode === 'pair' ? pair.task.reference : null });
    const answer = await run(spec.command, dir, prompt, timeoutSeconds * 1000, { captureOutput: true });
    const verdict = answer.code === 0 ? parseVerdict(answer.output) : null;
    if (!verdict) { errors.push(`${pair.task.id} ${id}: ${answer.error ?? (answer.code === 0 ? 'no verdict in the reply' : `judge exit ${answer.code}`)}`); continue; }
    const winner = verdict.winner === 'tie' ? 'tie' : order[verdict.winner === 'A' ? 0 : 1];
    const at = new Date().toISOString();
    for (const name of names.filter((side) => pair.sides[side])) {
      const item = pair.sides[name];
      rows.push({ at, role, task: pair.task.id, kind: 'judged', split: pair.task.split, contender: item.contender, version: item.version, run: item.run,
        agentExit: item.agentExit, seconds: item.seconds, passed: winner === name || winner === 'tie', mode: pair.mode, side: name, winner,
        pair: id, order, judge: spec.name, outputs: Object.values(pair.sides).map((side) => side?.file ?? 'accepted'), reasons: verdict.reasons });
    }
  }
  const file = rows.length ? await writeRows(dir, 'ledger', rows) : null;
  return { role, mode: champion ? 'pair' : 'accepted', judged: new Set(rows.map((row) => row.pair)).size, skippedAlreadyJudged: pairs.length - errors.length - new Set(rows.map((row) => row.pair)).size,
    errors, ledger: file, note: 'Judged scores count toward promotion only while eval calibration says the judge is calibrated.' };
}

/** Pick recent judged pairs the owner has not labeled, in a fresh random order, so the owner grades them blind. */
export async function labelsExport(dir, { role, count = 5 } = {}) {
  if (!SLUG.test(role ?? '') || !Number.isInteger(count) || count < 1 || count > 20) throw new Error('Usage: eval labels export --role <id> [--count 5]');
  const tasks = new Map((await loadTasks(dir, { role, split: 'all' })).map((task) => [task.id, task]));
  const labeled = new Set((await readRows(dir, 'labels')).map((row) => row.pair));
  const byPair = new Map();
  for (const row of (await readRows(dir, 'ledger')).filter((item) => item.kind === 'judged' && item.role === role && !labeled.has(item.pair))) {
    (byPair.get(row.pair) ?? byPair.set(row.pair, []).get(row.pair)).push(row);
  }
  const outputs = new Map((await readOutputs(dir, role)).map((item) => [item.file, item]));
  const pending = [...byPair.values()].sort((a, b) => String(b[0].at).localeCompare(String(a[0].at))).slice(0, count);
  if (!pending.length) throw new Error(`No unlabeled judged pairs for ${role}. Run eval judge first.`);
  const pack = `${stamp()}-${rand()}`;
  const items = [];
  const key = [];
  for (const [index, rows] of pending.entries()) {
    const first = rows[0];
    const task = tasks.get(first.task);
    const sides = first.mode === 'pair' ? ['champion', 'challenger'] : ['output', 'accepted'];
    // outputs[] follows the side names in fixed order (output, accepted / champion, challenger), not the judge's order.
    const files = Object.fromEntries(sides.map((side, i) => [side, first.outputs[i]]));
    const text = (side) => (files[side] === 'accepted' || side === 'accepted' ? task.reference : outputs.get(files[side])?.output ?? '');
    const order = randomInt(2) ? sides : [...sides].reverse();
    const item = `p${index + 1}`;
    items.push({ item, task: task.id, brief: task.prompt, rubric: await readFile(join(dir, task.rubric), 'utf8'),
      ...(first.mode === 'pair' ? { context: task.reference } : {}), A: text(order[0]), B: text(order[1]) });
    key.push({ item, pair: first.pair, task: task.id, mode: first.mode, A: order[0], B: order[1], judgeWinner: first.winner });
  }
  await mkdir(join(dir, 'label-packs'), { recursive: true });
  await writeFile(join(dir, 'label-packs', `${pack}.json`), `${JSON.stringify({ pack, role, key }, null, 2)}\n`, { flag: 'wx' });
  return { pack, role, items, note: 'Show A and B only. The key stays in label-packs/ until eval labels import.' };
}

/** Record the owner's blind answers and whether the judge agreed with each. */
export async function labelsImport(dir, answersFile) {
  const answers = JSON.parse(await readFile(answersFile, 'utf8'));
  if (!/^[0-9TZ]+-[0-9a-f]{6}$/.test(answers.pack ?? '') || !Array.isArray(answers.answers)) throw new Error('Answers need the pack id and an answers list.');
  const packFile = join(dir, 'label-packs', `${answers.pack}.json`);
  if (!existsSync(packFile)) throw new Error(`Unknown label pack ${answers.pack}.`);
  const { role, key } = JSON.parse(await readFile(packFile, 'utf8'));
  const already = new Set((await readRows(dir, 'labels')).map((row) => row.pair));
  const rows = [];
  for (const answer of answers.answers) {
    const entry = key.find((item) => item.item === answer.item);
    if (!entry || !['A', 'B', 'tie'].includes(answer.choice)) throw new Error(`Bad answer ${JSON.stringify(answer)}: choose A, B or tie for a listed item.`);
    if (already.has(entry.pair)) continue;
    const owner = answer.choice === 'tie' ? 'tie' : entry[answer.choice];
    rows.push({ at: new Date().toISOString(), role, pack: answers.pack, pair: entry.pair, task: entry.task, mode: entry.mode,
      owner, judge: entry.judgeWinner, agree: owner === entry.judgeWinner, ...(answer.note ? { note: String(answer.note).slice(0, 500) } : {}) });
  }
  const file = rows.length ? await writeRows(dir, 'labels', rows) : null;
  return { role, recorded: rows.length, agreed: rows.filter((row) => row.agree).length, labels: file && file.split('\\').join('/') };
}
