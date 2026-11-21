// Champion vs challenger: replays frozen tasks in throwaway worktrees and runs each task's must-pass checks.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const safeArg = /^[A-Za-z0-9_.,:\/=@+-]+$/;

function validate(spec) {
  const fail = (message) => { throw new Error(`Eval spec: ${message}`); };
  if (!spec || typeof spec !== 'object') fail('expected an object.');
  const runs = spec.runs ?? 2;
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) fail('runs must be 1 to 10.');
  const commandList = (value, label) => {
    if (!Array.isArray(value) || !value.length || value.some((arg) => typeof arg !== 'string' || !arg)) fail(`${label} must be a non-empty list of arguments.`);
    return value;
  };
  const contenders = Object.entries(spec.contenders ?? {});
  if (contenders.length < 2) fail('name at least two contenders (champion and challenger).');
  for (const [name, contender] of contenders) commandList(contender?.command, `contenders.${name}.command`);
  if (!Array.isArray(spec.tasks) || !spec.tasks.length) fail('add at least one task.');
  const ids = new Set();
  for (const task of spec.tasks) {
    if (typeof task?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(task.id) || ids.has(task.id)) fail('each task needs a unique slug id.');
    ids.add(task.id);
    if (typeof task.role !== 'string' || !task.role) fail(`task ${task.id} needs a role.`);
    if (typeof task.base !== 'string' || !/^[0-9a-f]{7,40}$/i.test(task.base)) fail(`task ${task.id} needs a base commit.`);
    if (typeof task.prompt !== 'string' || !task.prompt.trim()) fail(`task ${task.id} needs a prompt.`);
    if (!Array.isArray(task.checks) || !task.checks.length) fail(`task ${task.id} needs must-pass checks.`);
    task.checks.forEach((check, index) => commandList(check, `task ${task.id} check ${index + 1}`));
    if (task.timeoutSeconds !== undefined && !(Number.isInteger(task.timeoutSeconds) && task.timeoutSeconds > 0)) fail(`task ${task.id} timeoutSeconds must be a positive integer.`);
  }
  return { runs, contenders, tasks: spec.tasks };
}

// Windows starts .cmd shims such as codex or npm only through the shell, so bare names there go through it with plain arguments.
function run(argv, cwd, input, timeoutMs) {
  const shell = process.platform === 'win32' && !isAbsolute(argv[0]) && !/[\\/]|\.exe$/i.test(argv[0]);
  if (shell && argv.some((arg) => !safeArg.test(arg))) {
    return Promise.resolve({ code: null, error: `On Windows, use an absolute executable path for commands with special characters: ${argv[0]}` });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const [file, args] = shell ? [argv.join(' '), []] : [argv[0], argv.slice(1)];
    const child = spawn(file, args, { cwd, shell, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, error: error.message }); });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, seconds: Math.round((Date.now() - started) / 1000), ...(code ? { error: stderr.trim().split('\n').at(-1) ?? '' } : {}) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function modelsEval(project, specFile) {
  const { runs, contenders, tasks } = validate(JSON.parse(await readFile(specFile, 'utf8')));
  const results = [];
  for (const task of tasks) {
    const timeoutMs = (task.timeoutSeconds ?? 1800) * 1000;
    for (const [contender, { command }] of contenders) {
      for (let attempt = 1; attempt <= runs; attempt += 1) {
        const scratch = await mkdtemp(join(tmpdir(), 'toolkit-eval-'));
        const worktree = join(scratch, 'work');
        execFileSync('git', ['worktree', 'add', '--detach', worktree, task.base], { cwd: project, stdio: 'ignore' });
        try {
          // The prompt goes on standard input, so it never needs shell quoting.
          const agent = await run(command, worktree, task.prompt, timeoutMs);
          let failedCheck = null;
          for (const check of task.checks) {
            if ((await run(check, worktree, '', timeoutMs)).code !== 0) {
              failedCheck = check.join(' ');
              break;
            }
          }
          const changed = execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }).split('\n').filter(Boolean).length;
          results.push({ task: task.id, role: task.role, contender, run: attempt, agentExit: agent.code, agentSeconds: agent.seconds ?? null,
            ...(agent.error ? { agentError: agent.error } : {}), passed: failedCheck === null, failedCheck, changedFiles: changed });
        } finally {
          execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: project, stdio: 'ignore' });
          await rm(scratch, { recursive: true, force: true });
        }
      }
    }
  }
  const summary = {};
  for (const result of results) {
    const entry = ((summary[result.contender] ??= {})[result.role] ??= { passed: 0, runs: 0, agentSeconds: 0 });
    entry.runs += 1;
    entry.passed += result.passed ? 1 : 0;
    entry.agentSeconds += result.agentSeconds ?? 0;
  }
  return { spec: specFile, runs, summary, results,
    note: 'Must-pass checks are the hard gate. Compare per role, review diffs and cost, and get owner approval before changing a tier.' };
}
