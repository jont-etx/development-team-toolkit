// Improvement loop, phase 1: measurement. Ground truth comes from outside the agent loop:
//   golden tasks     frozen, owner-accepted work (base commit, handoff, accepted result, must-pass checks)
//   regression cases past failures kept forever so no later change can undo their fix
//   seeded tasks     a known bug planted in accepted work; a reviewer passes only by finding it
// `eval run` replays tasks per contender in throwaway worktrees and scores them deterministically into a ledger.
// `eval outcome` records how real handoffs went; `eval report` summarizes both. Self-assessment never counts.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { run } from './eval.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA = /^[0-9a-f]{7,40}$/i;
const KINDS = ['golden', 'regression', 'seeded'];
const SPLITS = ['train', 'holdout'];
const RESULTS = ['accepted', 'rework', 'rejected'];
const REVIEW_PROMPT = 'Review the uncommitted change in this working tree (run `git diff`) for defects against its intent. '
  + 'Report each defect with its file path and line, and what is wrong.';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function evalsDir(project, config) {
  const dir = config?.evals?.dir ?? '.development-team/evals';
  if (typeof dir !== 'string' || isAbsolute(dir) || dir.split(/[\\/]/).includes('..')) throw new Error('evals.dir must be a repo-relative path.');
  return join(project, dir);
}

function sections(text) {
  const found = {};
  const clean = text.replaceAll('\r\n', '\n').replace(/<!--[\s\S]*?-->/g, '');
  for (const [, heading, body] of clean.matchAll(/^## +(.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)) found[heading.trim().toLowerCase()] = body.trim();
  return found;
}
const bullets = (body) => (body ?? '').split('\n').map((line) => line.match(/^\s*[-*] +(.*\S)/)?.[1]).filter(Boolean);
// A deterministic ~20% holdout: the coach never tunes on these.
const defaultSplit = (id) => (createHash('sha256').update(id).digest()[0] % 5 === 0 ? 'holdout' : 'train');

export function validateTask(task) {
  const fail = (message) => { throw new Error(`Eval task ${task?.id ?? '?'}: ${message}`); };
  if (task?.schemaVersion !== 1 || !SLUG.test(task.id ?? '')) fail('needs schemaVersion 1 and a slug id.');
  if (!SLUG.test(task.role ?? '')) fail('needs a role id.');
  if (!KINDS.includes(task.kind)) fail(`kind must be ${KINDS.join(', ')}.`);
  if (!SPLITS.includes(task.split)) fail(`split must be ${SPLITS.join(' or ')}.`);
  if (!SHA.test(task.base ?? '')) fail('needs a base commit.');
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) fail('needs a prompt.');
  if (task.kind === 'seeded') {
    const seeded = task.seeded;
    if (!seeded || typeof seeded.patch !== 'string' || !seeded.patch.trim() || typeof seeded.file !== 'string'
        || !Array.isArray(seeded.keywords) || !seeded.keywords.length) fail('seeded tasks need a patch, the file it breaks and keywords a finding must mention.');
  } else if (!Array.isArray(task.checks) || !task.checks.length
      || task.checks.some((check) => !Array.isArray(check) || !check.length || check.some((arg) => typeof arg !== 'string' || !arg))) {
    fail('needs must-pass checks (lists of command arguments).');
  }
  return task;
}

export async function loadTasks(dir, { role, kind, split } = {}) {
  const root = join(dir, 'tasks');
  if (!existsSync(root)) return [];
  const tasks = [];
  for (const roleDir of await readdir(root)) {
    if (role && roleDir !== role) continue;
    for (const name of (await readdir(join(root, roleDir))).filter((file) => file.endsWith('.json')).sort()) {
      const task = validateTask(JSON.parse(await readFile(join(root, roleDir, name), 'utf8')));
      if ((!kind || task.kind === kind) && (!split || split === 'all' || task.split === split)) tasks.push(task);
    }
  }
  return tasks;
}

async function saveTask(dir, task) {
  validateTask(task);
  const file = join(dir, 'tasks', task.role, `${task.id}.json`);
  if (existsSync(file)) throw new Error(`Eval task ${task.id} already exists for ${task.role}.`);
  await mkdir(join(dir, 'tasks', task.role), { recursive: true });
  await writeFile(file, `${JSON.stringify(task, null, 2)}\n`, { flag: 'wx' });
  return file;
}

/** Freeze an accepted handoff as a golden task, or a failure as a regression case. */
export async function harvest(project, dir, handoffFile, { accepted, role, kind = 'golden', split, checks = [], id } = {}) {
  if (!SHA.test(accepted ?? '')) throw new Error('--accepted <commit> is required: the commit the owner accepted (or, for a regression case, the fixed one).');
  if (!SLUG.test(role ?? '')) throw new Error('--role <id> is required: the role that did the work.');
  if (!['golden', 'regression'].includes(kind)) throw new Error('--kind is golden or regression.');
  const text = await readFile(handoffFile, 'utf8');
  const found = sections(text);
  const base = found['base revision']?.split(/\s/, 1)[0].replaceAll('`', '');
  if (!SHA.test(base ?? '')) throw new Error('The handoff needs a base revision commit.');
  git(project, 'cat-file', '-e', `${base}^{commit}`);
  git(project, 'cat-file', '-e', `${accepted}^{commit}`);
  const commands = checks.length ? checks : bullets(found['acceptance checks']).map((item) => item.match(/^`([^`]+)`$/)?.[1]).filter(Boolean);
  if (!commands.length) throw new Error('No runnable checks: pass --check "<command>", or write acceptance checks as `command` bullets.');
  const taskId = id ?? `${basename(handoffFile).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)}-${accepted.slice(0, 7)}`;
  const task = {
    schemaVersion: 1, id: taskId, role, kind, split: split ?? defaultSplit(taskId), base: git(project, 'rev-parse', `${base}^{commit}`),
    prompt: text, checks: commands.map((command) => command.split(/\s+/).filter(Boolean)),
    expect: { ownedFiles: bullets(found['owned files']).map((item) => item.replaceAll('`', '')),
      changedFiles: git(project, 'diff', '--name-only', base, accepted).split('\n').filter(Boolean) },
    source: { handoff: relative(project, handoffFile).split('\\').join('/'), accepted: git(project, 'rev-parse', `${accepted}^{commit}`),
      harvestedAt: new Date().toISOString() },
  };
  return { task: task.id, split: task.split, file: await saveTask(dir, task) };
}

/** Plant a known bug in a golden task's accepted result; a reviewer passes only by finding it. */
export async function seed(project, dir, fromId, { patchFile, file, keywords = [], role = 'qa-code', id, split } = {}) {
  const source = (await loadTasks(dir)).find((task) => task.id === fromId);
  if (!source?.source?.accepted) throw new Error(`No golden task ${fromId} with an accepted commit to seed from.`);
  if (!patchFile || !file || !keywords.length) throw new Error('Usage: eval seed <task-id> --patch <file> --file <path the bug is in> --keyword <word>... [--role qa-code]');
  const patch = (await readFile(patchFile, 'utf8')).replaceAll('\r\n', '\n');
  const scratch = await mkdtemp(join(tmpdir(), 'toolkit-seed-'));
  const worktree = join(scratch, 'work');
  git(project, 'worktree', 'add', '--detach', worktree, source.source.accepted);
  try {
    await writeFile(join(scratch, 'seed.patch'), patch);
    git(worktree, 'apply', '--check', join(scratch, 'seed.patch'));
  } catch (error) {
    throw new Error(`The patch does not apply to ${source.source.accepted.slice(0, 7)}: ${String(error.stderr ?? error.message).trim().split('\n')[0]}`);
  } finally {
    git(project, 'worktree', 'remove', '--force', worktree);
    await rm(scratch, { recursive: true, force: true });
  }
  const taskId = id ?? `${fromId.slice(0, 40)}-seed-${createHash('sha256').update(patch).digest('hex').slice(0, 6)}`;
  const task = { schemaVersion: 1, id: taskId, role, kind: 'seeded', split: split ?? defaultSplit(taskId), base: source.source.accepted,
    prompt: REVIEW_PROMPT, seeded: { patch, file: file.replaceAll('\\', '/'), keywords }, source: { from: fromId, seededAt: new Date().toISOString() } };
  return { task: task.id, split: task.split, file: await saveTask(dir, task) };
}

// Untrimmed, NUL-separated status: each entry is "XY path"; a rename adds the old path as its own entry.
export function changedFiles(worktree) {
  const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktree, encoding: 'utf8' });
  const entries = raw.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    files.push(entries[i].slice(3));
    if (/^[RC]/.test(entries[i])) i += 1; // skip the rename source
  }
  return files;
}

const declared = (owned, path) => owned.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, '')}/`));

export function scoreSeeded(task, output) {
  const text = String(output ?? '').toLowerCase();
  const file = task.seeded.file.toLowerCase();
  const mentionsFile = text.includes(file) || text.includes(basename(file));
  const keyword = task.seeded.keywords.find((word) => text.includes(word.toLowerCase()));
  return { caught: Boolean(mentionsFile && keyword), mentionsFile, keyword: keyword ?? null };
}

export function scoreChanges(task, changed) {
  const owned = task.expect?.ownedFiles ?? [];
  const expected = new Set(task.expect?.changedFiles ?? []);
  const outside = owned.length ? changed.filter((path) => !declared(owned, path)) : [];
  const union = new Set([...changed, ...expected]);
  const overlap = union.size ? changed.filter((path) => expected.has(path)).length / union.size : 1;
  return { scopeOk: !outside.length, outside, overlap: Math.round(overlap * 100) / 100 };
}

/** Replay tasks for each contender and append deterministic scores to the ledger. */
export async function evalRun(project, dir, specFile, { role, split = 'train', kind } = {}) {
  const spec = JSON.parse(await readFile(specFile, 'utf8'));
  const runs = spec.runs ?? 2;
  const contenders = Object.entries(spec.contenders ?? {});
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('runs must be 1 to 10.');
  if (!contenders.length || contenders.some(([name, c]) => !SLUG.test(name) || !Array.isArray(c?.command) || !c.command.length)) {
    throw new Error('Name contenders with slug names, each with a command list (and an optional version label).');
  }
  const tasks = await loadTasks(dir, { role, split, kind });
  if (!tasks.length) throw new Error('No eval tasks match. Harvest some first.');
  const rows = [];
  for (const task of tasks) {
    const timeoutMs = (task.timeoutSeconds ?? 1800) * 1000;
    for (const [contender, { command, version }] of contenders) {
      for (let attempt = 1; attempt <= runs; attempt += 1) {
        const scratch = await mkdtemp(join(tmpdir(), 'toolkit-evalrun-'));
        const worktree = join(scratch, 'work');
        git(project, 'worktree', 'add', '--detach', worktree, task.base);
        try {
          if (task.kind === 'seeded') {
            await writeFile(join(scratch, 'seed.patch'), task.seeded.patch);
            git(worktree, 'apply', join(scratch, 'seed.patch'));
          }
          const agent = await run(command, worktree, task.prompt, timeoutMs, { captureOutput: true });
          const row = { at: new Date().toISOString(), contender, version: version ?? null, role: task.role, task: task.id,
            kind: task.kind, split: task.split, run: attempt, agentExit: agent.code, seconds: agent.seconds ?? null };
          if (task.kind === 'seeded') {
            const found = scoreSeeded(task, agent.output);
            Object.assign(row, found, { passed: found.caught });
          } else {
            let failedCheck = null;
            for (const check of task.checks) {
              if ((await run(check, worktree, '', timeoutMs)).code !== 0) { failedCheck = check.join(' '); break; }
            }
            const changed = changedFiles(worktree);
            const scope = scoreChanges(task, changed);
            Object.assign(row, { passed: failedCheck === null && scope.scopeOk, failedCheck, ...scope, changedFiles: changed.length });
          }
          rows.push(row);
        } finally {
          git(project, 'worktree', 'remove', '--force', worktree);
          await rm(scratch, { recursive: true, force: true });
        }
      }
    }
  }
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, 'ledger.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return { tasks: tasks.length, runs, rows: rows.length, summary: summarize(rows), ledger: relative(project, join(dir, 'ledger.jsonl')).split('\\').join('/') };
}

function summarize(rows) {
  const out = {};
  for (const row of rows) {
    const entry = (((out[row.role] ??= {})[row.version ? `${row.contender}@${row.version}` : row.contender] ??= {}));
    const bucket = (entry[row.kind === 'seeded' ? 'seeded' : row.split] ??= { passed: 0, runs: 0 });
    bucket.runs += 1;
    bucket.passed += row.passed ? 1 : 0;
  }
  return out;
}

/** Record how a real handoff went: the slow, honest layer of ground truth. */
export async function outcome(project, dir, handoffFile, { role, result, defects = 0, version } = {}) {
  if (!SLUG.test(role ?? '') || !RESULTS.includes(result) || !Number.isInteger(defects) || defects < 0) {
    throw new Error(`Usage: eval outcome <handoff.md> --role <id> --result ${RESULTS.join('|')} [--defects <n>] [--version <label>]`);
  }
  const row = { at: new Date().toISOString(), role, version: version ?? null, result, defects,
    handoff: relative(project, handoffFile).split('\\').join('/') };
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, 'outcomes.jsonl'), `${JSON.stringify(row)}\n`);
  return { ...row, next: result === 'accepted' ? 'Consider eval harvest to freeze it as a golden task (owner approves).'
    : 'Record the failure as a regression case once fixed: eval harvest --kind regression.' };
}

async function jsonl(file) {
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export async function report(dir, { role } = {}) {
  const tasks = await loadTasks(dir, { role });
  const ledger = (await jsonl(join(dir, 'ledger.jsonl'))).filter((row) => !role || row.role === role);
  const outcomes = (await jsonl(join(dir, 'outcomes.jsonl'))).filter((row) => !role || row.role === role);
  const counts = {};
  for (const task of tasks) ((counts[task.role] ??= {})[`${task.kind}/${task.split}`] = (counts[task.role]?.[`${task.kind}/${task.split}`] ?? 0) + 1);
  const live = {};
  for (const row of outcomes) {
    const entry = ((live[row.role] ??= {})[row.version ?? 'unversioned'] ??= { handoffs: 0, accepted: 0, rework: 0, rejected: 0, defects: 0 });
    entry.handoffs += 1;
    entry[row.result] += 1;
    entry.defects += row.defects;
  }
  return { tasks: counts, scores: summarize(ledger), outcomes: live,
    note: 'Scores come only from checks, planted bugs and real outcomes, never from an agent grading itself.' };
}
