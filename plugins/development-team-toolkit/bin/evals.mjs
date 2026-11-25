// Improvement loop, phase 1: measurement. Ground truth comes from outside the agent loop:
//   golden tasks     frozen, owner-accepted work (base commit, handoff, accepted result, must-pass checks)
//   regression cases past failures kept forever so no later change can undo their fix
//   seeded tasks     a known bug planted in accepted work; a reviewer passes only by finding it
// `eval run` replays tasks per contender in throwaway worktrees and scores them deterministically into a ledger.
// `eval outcome` records how real handoffs went; `eval report` summarizes both. Self-assessment never counts.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { run } from './eval.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA = /^[0-9a-f]{7,40}$/i;
export const CAPTURE = 2; // judged outputs and scores from before the deliverable file was captured (no 2) never count
const KINDS = ['golden', 'regression', 'seeded', 'judged'];
const SPLITS = ['train', 'holdout'];
const RESULTS = ['accepted', 'rework', 'rejected'];
const SEVERITIES = { high: 3, medium: 2, low: 1 };
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
  if (task.severity !== undefined && !SEVERITIES[task.severity]) fail(`severity must be ${Object.keys(SEVERITIES).join(', ')}.`);
  if (task.kind === 'judged') {
    // Subjective roles (improvement-loop decisions 16-21): an output is judged blind against the role's rubric,
    // with the owner-accepted output as context. `rubric` is a path inside the evals folder.
    if (typeof task.rubric !== 'string' || !task.rubric.trim() || isAbsolute(task.rubric) || task.rubric.split(/[\\/]/).includes('..')) {
      fail('judged tasks need a rubric path inside the evals folder.');
    }
    if (typeof task.reference !== 'string' || !task.reference.trim()) fail('judged tasks need the accepted output as reference text.');
  } else if (task.kind === 'seeded') {
    const seeded = task.seeded;
    if (!seeded || typeof seeded.patch !== 'string' || !seeded.patch.trim() || typeof seeded.file !== 'string'
        || !Array.isArray(seeded.keywords) || !seeded.keywords.length) fail('seeded tasks need a patch, the file it breaks and keywords a finding must mention.');
  } else if (!Array.isArray(task.checks) || !task.checks.length
      || task.checks.some((check) => !Array.isArray(check) || !check.length || check.some((arg) => typeof arg !== 'string' || !arg))) {
    fail('needs must-pass checks (lists of command arguments).');
  }
  return task;
}

export async function loadTasks(dir, { role, kind, split, task: only } = {}) {
  const root = join(dir, 'tasks');
  if (!existsSync(root)) return [];
  const tasks = [];
  for (const roleDir of await readdir(root)) {
    if (role && roleDir !== role) continue;
    for (const name of (await readdir(join(root, roleDir))).filter((file) => file.endsWith('.json')).sort()) {
      const task = validateTask(JSON.parse(await readFile(join(root, roleDir, name), 'utf8')));
      if ((!kind || task.kind === kind) && (!split || split === 'all' || only || task.split === split) && (!only || task.id === only)) tasks.push(task);
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
export async function readContenders(specFile) {
  const spec = JSON.parse(await readFile(specFile, 'utf8'));
  const runs = spec.runs ?? 2;
  const contenders = Object.entries(spec.contenders ?? {});
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('runs must be 1 to 10.');
  if (!contenders.length || contenders.some(([name, c]) => !SLUG.test(name) || !Array.isArray(c?.command) || !c.command.length)) {
    throw new Error('Name contenders with slug names, each with a command list (and an optional version label).');
  }
  return { runs, contenders };
}

export async function evalRun(project, dir, specFile, { role, split = 'train', kind, task: only } = {}) {
  const { runs, contenders } = await readContenders(specFile);
  // Judged tasks are not scored here: `eval generate` saves their outputs and `eval judge` scores them.
  const tasks = (await loadTasks(dir, { role, split, kind, task: only })).filter((task) => task.kind !== 'judged');
  if (!tasks.length) throw new Error('No eval tasks match. Harvest some first (judged tasks use eval generate and eval judge).');
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
          // An agent that never started is not a miss: flag it so reports and comparisons leave the row out.
          if (agent.code === null) row.agentError = agent.error ?? 'the agent did not start';
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
  const file = await writeRows(dir, 'ledger', rows);
  return { tasks: tasks.length, runs, rows: rows.length, summary: summarize(rows), ledger: relative(project, file).split('\\').join('/') };
}

// Older rows have no agentError field; a null exit code means the same thing.
const failedToRun = (row) => Boolean(row.agentError) || row.agentExit === null;
const rate = (rows) => (rows.length ? rows.filter((row) => row.passed).length / rows.length : null);
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const round = (value) => (value === null ? null : Math.round(value * 100) / 100);

/**
 * Coach input: the training tasks a charter version missed. Holdout tasks are only counted, never named,
 * so a challenger cannot be written to fit them.
 */
export async function misses(dir, { role, version } = {}) {
  if (!SLUG.test(role ?? '') || !version) throw new Error('Usage: eval misses --role <id> --version <label>');
  const tasks = await loadTasks(dir, { role, split: 'all' });
  const rows = (await readRows(dir, 'ledger')).filter((row) => row.role === role && row.version === version && !failedToRun(row));
  const train = [];
  let holdoutMissed = 0;
  for (const task of tasks) {
    const runs = rows.filter((row) => row.task === task.id);
    const missed = runs.filter((row) => !row.passed).length;
    if (!missed) continue;
    if (task.split === 'holdout') { holdoutMissed += 1; continue; }
    train.push({ task: task.id, kind: task.kind, missed, runs: runs.length, prompt: task.prompt,
      ...(task.kind === 'seeded' ? { file: task.seeded.file, keywords: task.seeded.keywords } : { failedChecks: [...new Set(runs.map((row) => row.failedCheck).filter(Boolean))] }) });
  }
  const unrun = tasks.filter((task) => !rows.some((row) => row.task === task.id)).length;
  return { role, version, train, holdoutMissed, unrun,
    note: 'Holdout tasks are counted, never shown. Write challengers from the training misses only.' };
}

/**
 * Watch window after a promotion (improvement-loop decision 8). Live handoff outcomes for the promoted version since
 * the promotion are compared with the previous version's. A clear drop is an acceptance rate at least 20 points lower
 * or at least 0.5 more defects per handoff, over at least 3 handoffs on each side.
 *   watching  the window (default 10 handoffs or 14 days) is still open and there is no clear drop
 *   revert    a clear drop: at once for a hot-path role, otherwise when the window closes
 *   keep      the window closed without a clear drop (or without enough handoffs to judge one)
 */
export async function watch(dir, { role, promoted, previous, since, today = new Date(), handoffs = 10, days = 14, hot = false } = {}) {
  if (!SLUG.test(role ?? '') || !promoted || !previous || !since) {
    throw new Error('Usage: eval watch --role <id> --promoted <version> --previous <version> --since <YYYY-MM-DD> [--hot] [--today YYYY-MM-DD]');
  }
  const start = new Date(since);
  const now = today instanceof Date ? today : new Date(`${today}T12:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(now.getTime())) throw new Error('--since and --today must be dates such as 2026-11-30.');
  const rows = (await readRows(dir, 'outcomes')).filter((row) => row.role === role);
  const stat = (list) => ({ handoffs: list.length,
    acceptRate: round(list.length ? list.filter((row) => row.result === 'accepted').length / list.length : null),
    defectsPerHandoff: round(list.length ? list.reduce((sum, row) => sum + (row.defects ?? 0), 0) / list.length : null) });
  const after = stat(rows.filter((row) => row.version === promoted && new Date(row.at) >= start));
  const before = stat(rows.filter((row) => row.version === previous));
  const elapsed = Math.floor((now - start) / 86400000);
  const closed = after.handoffs >= handoffs || elapsed >= days;
  const comparable = after.handoffs >= 3 && before.handoffs >= 3;
  const drops = [];
  if (comparable && before.acceptRate - after.acceptRate >= 0.2) drops.push(`acceptance ${before.acceptRate} -> ${after.acceptRate}`);
  if (comparable && after.defectsPerHandoff - before.defectsPerHandoff >= 0.5) drops.push(`defects per handoff ${before.defectsPerHandoff} -> ${after.defectsPerHandoff}`);
  let verdict = 'watching';
  let reason = `window open: ${after.handoffs}/${handoffs} handoffs, ${elapsed}/${days} days`;
  if (drops.length && (hot || closed)) { verdict = 'revert'; reason = `clear drop${hot && !closed ? ' on a hot-path role' : ''}: ${drops.join('; ')}`; }
  else if (closed) { verdict = 'keep'; reason = comparable ? 'window closed without a clear drop' : 'window closed; too few handoffs to judge a drop'; }
  return { role, promoted, previous, since, verdict, reason, after, before, windowClosed: closed, drops,
    note: 'A revert verdict means opening a pull request that restores the previous charter; the owner merges it.' };
}

/**
 * Is the judge trusted for a role? Owner blind labels (decision 4) are compared with the judge's verdict on the same
 * pairs; judged scores count only while the judge agrees on at least `minAgreement` of the latest `window` labels.
 */
export async function calibration(dir, { role, minLabels = 5, minAgreement = 0.8, window = 20 } = {}) {
  if (!SLUG.test(role ?? '')) throw new Error('Usage: eval calibration --role <id>');
  const labels = (await readRows(dir, 'labels')).filter((row) => row.role === role).sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-window);
  const agree = labels.filter((row) => row.agree).length;
  const agreement = labels.length ? round(agree / labels.length) : null;
  const calibrated = labels.length >= minLabels && agreement >= minAgreement;
  return { role, labels: labels.length, agreement, calibrated,
    reason: calibrated ? `judge agrees with the owner on ${agree} of ${labels.length} recent labels`
      : labels.length < minLabels ? `needs ${minLabels} owner labels, has ${labels.length}` : `agreement ${agreement} is below ${minAgreement}` };
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * When the coach should propose for a role, so it reacts fast to serious misses and waits for more data on minor ones.
 * Misses are weighted by task severity (high 3, medium 2, low 1; default medium).
 *   wait    not enough runs yet, only holdout misses (nothing the coach may learn from), or minor misses seen too few times
 *   urgent  a high-severity task missed on at least half its runs, or a weighted miss rate at or above `urgentRate`
 *   review  on the weekly review day: real misses to fix, or no misses at all (then removal challengers, decision 14)
 */
export async function readiness(dir, { role, version, minRuns = 2, reviewDay = 'monday', today = new Date(),
  urgentRate = 0.25, minorRate = 0.1, minorRuns = 4 } = {}) {
  if (!SLUG.test(role ?? '') || !version) throw new Error('Usage: eval readiness --role <id> --version <label> [--review-day monday] [--today YYYY-MM-DD]');
  const day = String(reviewDay).toLowerCase();
  if (!DAYS.includes(day)) throw new Error(`--review-day must be one of ${DAYS.join(', ')}.`);
  const date = today instanceof Date ? today : new Date(`${today}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error('--today must be a date such as 2026-11-30.');
  const isReviewDay = DAYS[date.getUTCDay()] === day;
  const tasks = await loadTasks(dir, { role, split: 'all' });
  if (!tasks.length) throw new Error(`No eval tasks for ${role}.`);
  if (tasks.some((task) => task.kind === 'judged')) {
    const judge = await calibration(dir, { role });
    if (!judge.calibrated) {
      return { role, version, urgency: 'wait', ready: false, mode: null, next: 'keep collecting', reasons: [`judge not calibrated: ${judge.reason}`] };
    }
  }
  const rows = (await readRows(dir, 'ledger')).filter((row) => row.role === role && row.version === version && !failedToRun(row));
  const stats = tasks.map((task) => {
    const runs = rows.filter((row) => row.task === task.id);
    return { task, runs: runs.length, missRate: runs.length ? 1 - rate(runs) : 0, weight: SEVERITIES[task.severity ?? 'medium'] };
  });
  const short = stats.filter((item) => item.runs < minRuns).map((item) => item.task.id);
  const weighted = round(stats.reduce((sum, item) => sum + item.weight * item.missRate, 0) / stats.reduce((sum, item) => sum + item.weight, 0));
  const trainMisses = stats.filter((item) => item.task.split === 'train' && item.missRate > 0);
  const holdoutMisses = stats.filter((item) => item.task.split === 'holdout' && item.missRate > 0).length;
  const severe = stats.filter((item) => item.weight === SEVERITIES.high && item.missRate >= 0.5).map((item) => item.task.id);
  const base = { role, version, weightedMissRate: weighted, trainMisses: trainMisses.length, holdoutMisses, reviewDay: day, isReviewDay };
  const result = (urgency, mode, reasons) => ({ ...base, urgency, ready: urgency !== 'wait', mode, reasons,
    next: urgency === 'wait' ? 'keep collecting' : 'propose now' });
  if (short.length) return result('wait', null, [`collecting: fewer than ${minRuns} runs on ${short.join(', ')}`]);
  if (!trainMisses.length) {
    if (holdoutMisses) return result('wait', null, ['only holdout tasks missed; add training tasks like them before coaching']);
    return isReviewDay ? result('review', 'removal', ['no misses: try one removal challenger (ties go to the smaller charter)'])
      : result('wait', null, [`no misses; removal challengers wait for ${day}`]);
  }
  if (severe.length) return result('urgent', 'fix', [`high-severity task missed on half its runs or more: ${severe.join(', ')}`]);
  if (weighted >= urgentRate) return result('urgent', 'fix', [`weighted miss rate ${weighted} is at or above ${urgentRate}`]);
  if (weighted < minorRate && trainMisses.some((item) => item.runs < minorRuns)) {
    return result('wait', null, [`minor misses (weighted ${weighted}); collect ${minorRuns} runs on each missed task first`]);
  }
  return isReviewDay ? result('review', 'fix', [`weekly review: ${trainMisses.length} training task(s) missed`])
    : result('wait', null, [`misses are not urgent; propose on ${day}`]);
}

/**
 * Strict-win test (improvement-loop decision 7, ADR promotion): the challenger must have enough runs, lose no
 * task the champion always passes and no regression task, and score higher on both the training and the
 * holdout set, or tie on both at clearly lower cost (decision 14: ties go to the smaller charter).
 */
export async function compare(dir, { role, champion, challenger, minRuns = 2, championCost, challengerCost } = {}) {
  if (!SLUG.test(role ?? '') || !champion || !challenger || champion === challenger) {
    throw new Error('Usage: eval compare --role <id> --champion <version> --challenger <version> [--min-runs <n>] [--champion-cost <n> --challenger-cost <n>]');
  }
  const tasks = await loadTasks(dir, { role, split: 'all' });
  if (!tasks.length) throw new Error(`No eval tasks for ${role}.`);
  if (tasks.some((task) => task.kind === 'judged')) {
    const judge = await calibration(dir, { role });
    if (!judge.calibrated) {
      return { role, champion, challenger, verdict: 'judge-not-calibrated', reasons: [judge.reason], calibration: judge,
        note: 'Judged scores count toward promotion only while the judge agrees with owner labels (decision 4).' };
    }
  }
  const rows = (await readRows(dir, 'ledger')).filter((row) => row.role === role && !failedToRun(row));
  const perTask = [];
  const insufficient = [];
  for (const task of tasks) {
    const a = rows.filter((row) => row.task === task.id && row.version === champion);
    const b = rows.filter((row) => row.task === task.id && row.version === challenger);
    if (a.length < minRuns || b.length < minRuns) insufficient.push(`${task.id} (${a.length}/${b.length} runs)`);
    perTask.push({ task: task.id, split: task.split, kind: task.kind, champion: round(rate(a)), challenger: round(rate(b)),
      championSeconds: mean(a.map((row) => row.seconds ?? 0)), challengerSeconds: mean(b.map((row) => row.seconds ?? 0)) });
  }
  const score = (split, side) => round(mean(perTask.filter((item) => item.split === split && item[side] !== null).map((item) => item[side])));
  const sets = {};
  for (const split of SPLITS) sets[split] = { champion: score(split, 'champion'), challenger: score(split, 'challenger') };
  const regressions = perTask.filter((item) => item.champion !== null && item.challenger !== null && item.challenger < item.champion
    && (item.kind === 'regression' || item.champion === 1)).map((item) => item.task);
  const cost = (side, given) => (given !== undefined ? Number(given) : mean(perTask.map((item) => item[`${side}Seconds`]).filter((value) => value !== null)));
  const costs = { champion: cost('champion', championCost), challenger: cost('challenger', challengerCost),
    measure: championCost !== undefined ? 'given' : 'seconds' };
  const used = SPLITS.filter((split) => sets[split].champion !== null);
  const better = used.every((split) => sets[split].challenger > sets[split].champion);
  const tied = used.every((split) => sets[split].challenger === sets[split].champion);
  const cheaper = costs.challenger !== null && costs.champion !== null && costs.challenger <= costs.champion * 0.9;
  let verdict = 'keep';
  const reasons = [];
  if (insufficient.length) { verdict = 'insufficient-runs'; reasons.push(`need ${minRuns} runs per task for both: ${insufficient.join(', ')}`); }
  else if (regressions.length) reasons.push(`loses tasks the champion passes: ${regressions.join(', ')}`);
  else if (better) { verdict = 'promote'; reasons.push(`higher on ${used.join(' and ')}`); }
  else if (tied && cheaper) { verdict = 'promote'; reasons.push(`ties on ${used.join(' and ')} at clearly lower cost (${costs.measure})`); }
  else reasons.push(tied ? 'ties without clearly lower cost' : `not higher on every set (${used.map((split) => `${split} ${sets[split].champion}->${sets[split].challenger}`).join(', ')})`);
  return { role, champion, challenger, verdict, reasons, sets, regressions, costs, tasks: perTask,
    note: 'A promote verdict only qualifies the challenger for an owner pull request; merging it is the promotion.' };
}

function summarize(rows) {
  const out = {};
  for (const row of rows) {
    const entry = (((out[row.role] ??= {})[row.version ? `${row.contender}@${row.version}` : row.contender] ??= {}));
    if (failedToRun(row)) { entry.errors = (entry.errors ?? 0) + 1; continue; }
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
  const file = await writeRows(dir, 'outcomes', [row]);
  return { ...row, file: relative(project, file).split('\\').join('/'), next: result === 'accepted' ? 'Consider eval harvest to freeze it as a golden task (owner approves).'
    : 'Record the failure as a regression case once fixed: eval harvest --kind regression.' };
}

// Each run writes its own file under <dir>/<kind>/, so runs on different branches (for example nightly pull
// requests) never edit the same file and never conflict. A legacy single <kind>.jsonl is still read as history.
export async function writeRows(dir, kind, rows) {
  const folder = join(dir, kind);
  await mkdir(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const file = join(folder, `${stamp}-${createHash('sha256').update(`${process.pid}-${Math.random()}`).digest('hex').slice(0, 6)}.jsonl`);
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' });
  return file;
}

export async function readRows(dir, kind) {
  const rows = await jsonl(join(dir, `${kind}.jsonl`));
  const folder = join(dir, kind);
  if (existsSync(folder)) {
    for (const name of (await readdir(folder)).filter((file) => file.endsWith('.jsonl')).sort()) rows.push(...await jsonl(join(folder, name)));
  }
  return kind === 'ledger' ? rows.filter((row) => row.kind !== 'judged' || row.capture === CAPTURE) : rows;
}

async function jsonl(file) {
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export async function report(dir, { role } = {}) {
  const tasks = await loadTasks(dir, { role });
  const ledger = (await readRows(dir, 'ledger')).filter((row) => !role || row.role === role);
  const outcomes = (await readRows(dir, 'outcomes')).filter((row) => !role || row.role === role);
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

// ---- Phase 2: checking the checks -------------------------------------------------------------------------------
// A check earns its place by failing when work is missing or broken and passing when it is right:
//   golden / regression task  base (work or fix missing) -> should FAIL; accepted -> should PASS
//   seeded task               accepted with the planted bug -> the source task's checks should FAIL
// A failure on accepted work is a false alarm. Reviewer catch rates come from seeded rows in the ledger.

async function checkAt(project, commit, checks, { patch, timeoutMs }) {
  const scratch = await mkdtemp(join(tmpdir(), 'toolkit-checks-'));
  const worktree = join(scratch, 'work');
  git(project, 'worktree', 'add', '--detach', worktree, commit);
  try {
    if (patch) {
      await writeFile(join(scratch, 'seed.patch'), patch);
      git(worktree, 'apply', join(scratch, 'seed.patch'));
    }
    const results = [];
    for (const check of checks) {
      const outcome = await run(check, worktree, '', timeoutMs);
      results.push({ check: check.join(' '), failed: outcome.code !== 0, seconds: outcome.seconds ?? null });
    }
    return results;
  } finally {
    git(project, 'worktree', 'remove', '--force', worktree);
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Run every task's checks on the states that tell whether they discriminate, and append to checks.jsonl. */
export async function evalChecks(project, dir, { role, task: only, split = 'all' } = {}) {
  const all = await loadTasks(dir, { split: 'all' });
  const byId = new Map(all.map((task) => [task.id, task]));
  const selected = all.filter((task) => (!role || task.role === role) && (!only || task.id === only)
    && (split === 'all' || task.split === split));
  const rows = [];
  for (const task of selected) {
    const timeoutMs = (task.timeoutSeconds ?? 1800) * 1000;
    const at = new Date().toISOString();
    if (task.kind === 'seeded') {
      const source = byId.get(task.source?.from);
      if (!source?.checks?.length) continue;
      for (const result of await checkAt(project, task.base, source.checks, { patch: task.seeded.patch, timeoutMs })) {
        rows.push({ at, task: task.id, kind: 'seeded', state: 'planted-bug', expect: 'fail', ...result, caught: result.failed });
      }
      continue;
    }
    if (!task.source?.accepted) continue;
    for (const result of await checkAt(project, task.base, task.checks, { timeoutMs })) {
      rows.push({ at, task: task.id, kind: task.kind, state: 'base', expect: 'fail', ...result, caught: result.failed });
    }
    for (const result of await checkAt(project, task.source.accepted, task.checks, { timeoutMs })) {
      rows.push({ at, task: task.id, kind: task.kind, state: 'accepted', expect: 'pass', ...result, falseAlarm: result.failed });
    }
  }
  if (!rows.length) throw new Error('No tasks with runnable checks match.');
  const file = await writeRows(dir, 'checks', rows);
  return { tasks: selected.length, rows: rows.length, file: relative(project, file).split('\\').join('/'), report: summarizeChecks(rows, []) };
}

export function summarizeChecks(rows, protectedPatterns) {
  const checks = {};
  for (const row of rows) {
    const entry = (checks[row.check] ??= { catchable: 0, caught: 0, cleanRuns: 0, falseAlarms: 0, seconds: 0, runs: 0, missed: [] });
    entry.runs += 1;
    entry.seconds += row.seconds ?? 0;
    if (row.expect === 'fail') {
      entry.catchable += 1;
      if (row.caught) entry.caught += 1;
      else entry.missed.push(`${row.task}:${row.state}`);
    } else {
      entry.cleanRuns += 1;
      if (row.falseAlarm) entry.falseAlarms += 1;
    }
  }
  for (const [check, entry] of Object.entries(checks)) {
    entry.catchRate = entry.catchable ? Math.round((entry.caught / entry.catchable) * 100) / 100 : null;
    entry.falseAlarmRate = entry.cleanRuns ? Math.round((entry.falseAlarms / entry.cleanRuns) * 100) / 100 : null;
    entry.avgSeconds = entry.runs ? Math.round(entry.seconds / entry.runs) : null;
    entry.protected = protectedPatterns.some((pattern) => check.includes(pattern));
    if (entry.falseAlarmRate > 0) entry.suggestion = 'fix false alarms: it fails on accepted work';
    else if (entry.catchable < 5) entry.suggestion = 'too few samples to judge';
    else if (entry.catchRate < 0.2) entry.suggestion = entry.protected ? 'weak but protected: keep' : 'weak: consider retiring (owner decides)';
    else entry.suggestion = 'earning its place';
  }
  return checks;
}

/** Whole picture: per-check value, reviewer catch rates on planted bugs, and failure states no check caught. */
export async function checkReport(dir, { protectedChecks = [] } = {}) {
  const rows = await readRows(dir, 'checks');
  const ledger = await readRows(dir, 'ledger');
  const reviewers = {};
  for (const row of ledger.filter((item) => item.kind === 'seeded' && !failedToRun(item))) {
    const key = row.version ? `${row.contender}@${row.version}` : row.contender;
    const entry = ((reviewers[row.role] ??= {})[key] ??= { planted: 0, caught: 0 });
    entry.planted += 1;
    entry.caught += row.passed ? 1 : 0;
  }
  for (const contenders of Object.values(reviewers)) {
    for (const entry of Object.values(contenders)) entry.catchRate = Math.round((entry.caught / entry.planted) * 100) / 100;
  }
  // A failure state no check caught is a gap: a check, or a reviewer duty, is missing there.
  const byState = {};
  for (const row of rows.filter((item) => item.expect === 'fail')) (byState[`${row.task}:${row.state}`] ??= []).push(row.caught);
  const gaps = Object.entries(byState).filter(([, caught]) => !caught.some(Boolean)).map(([state]) => state);
  return { checks: summarizeChecks(rows, protectedChecks), reviewers, gaps,
    note: 'Protected checks (hot-zone and security) are never proposed for retirement. Every suggestion is an owner decision.' };
}
