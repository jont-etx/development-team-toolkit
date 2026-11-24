// Parallel workers: each worker gets a linked worktree and a Coordinator reservation for exactly the files
// (and named resources) it declared. `finish` refuses undeclared changes, merges only by fast-forward, then
// releases the reservation and removes the worktree. State lives in Git's common directory, so every
// worktree and both runtimes see the same workers and the same request credentials.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./toolkit.mjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function paths(project) {
  const common = git(project, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const primary = git(project, 'worktree', 'list', '--porcelain').split('\n')[0].replace(/^worktree /, '');
  return { common, primary, workers: join(common, 'development-team-workers'), credentials: join(common, 'development-team-credentials') };
}

function coordinate(project, args, capability = '') {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'coordinate', ...args],
    { cwd: project, input: capability ? `${capability}\n` : '', encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Coordinator refused the operation.');
  return JSON.parse(result.stdout);
}

const readMeta = (file) => JSON.parse(readFileSync(file, 'utf8'));
const metaFile = (dirs, name) => join(dirs.workers, `${name}.json`);
const credential = (dirs, id) => readFileSync(join(dirs.credentials, id), 'utf8').trim();
const declared = (files, path) => files.some((file) => path === file || path.startsWith(`${file.replace(/\/$/, '')}/`));

function validate(name, files, resources) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name ?? '')) throw new Error('Worker names are lowercase slugs, e.g. billing-api.');
  if (!files.length) throw new Error('Declare the files or directories this worker owns.');
  for (const file of files) {
    if (isAbsolute(file) || file.split(/[\\/]/).includes('..') || !file.trim()) throw new Error(`Worker files must be repo-relative: ${file}`);
  }
  for (const resource of resources) if (!resource.startsWith('resource:')) throw new Error(`Named resources start with resource:, e.g. resource:contract-billing (${resource}).`);
}

export function workerStart(project, name, files, { resources = [], base = 'HEAD', maxWorkers = 2, role = null } = {}) {
  files = files.map((file) => file.replaceAll('\\', '/'));
  validate(name, files, resources);
  const dirs = paths(project);
  mkdirSync(dirs.workers, { recursive: true });
  mkdirSync(dirs.credentials, { recursive: true });
  const file = metaFile(dirs, name);
  let meta = existsSync(file) ? readMeta(file) : null;
  if (meta?.state === 'held') return { ...meta, note: 'Already running.' };
  if (!meta) {
    const active = readdirSync(dirs.workers).filter((entry) => entry.endsWith('.json') && readMeta(join(dirs.workers, entry)).state === 'held');
    if (active.length >= maxWorkers) throw new Error(`${active.length} workers are already running (parallel.maxWorkers is ${maxWorkers}). Finish one first.`);
    const request = coordinate(project, ['request', name, ...files.map((f) => `file:${f}`), ...resources]);
    writeFileSync(join(dirs.credentials, request.id), `${request.capability}\n`, { flag: 'wx', mode: 0o600 });
    const into = git(dirs.primary, 'branch', '--show-current');
    meta = { name, role, files, resources, id: request.id, into, state: 'queued' };
    writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`); // record before claiming so a retry finds the request
  }
  const claimed = coordinate(project, ['claim', meta.id], credential(dirs, meta.id));
  if (claimed.state !== 'held') {
    writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);
    return { ...meta, note: `Queued behind conflicting work. Run worker start ${name} again to retry.` };
  }
  const exclude = join(dirs.common, 'info', 'exclude');
  if (!(existsSync(exclude) ? readFileSync(exclude, 'utf8') : '').split(/\r?\n/).includes('/.worktrees/')) {
    mkdirSync(join(dirs.common, 'info'), { recursive: true });
    writeFileSync(exclude, '\n/.worktrees/\n', { flag: 'a' });
  }
  const path = join(dirs.primary, '.worktrees', name);
  const baseSha = git(project, 'rev-parse', `${base}^{commit}`);
  git(dirs.primary, 'worktree', 'add', '-q', '-b', `worker/${name}`, path, baseSha);
  meta = { ...meta, state: 'held', path, branch: `worker/${name}`, base: baseSha };
  writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);
  return { ...meta, note: 'Held. Work and commit only inside path; then run worker finish.' };
}

export function workerStatus(project) {
  const dirs = paths(project);
  if (!existsSync(dirs.workers)) return { workers: [] };
  return { workers: readdirSync(dirs.workers).filter((e) => e.endsWith('.json')).map((e) => readMeta(join(dirs.workers, e))) };
}

export function workerFinish(project, name) {
  const dirs = paths(project);
  const file = metaFile(dirs, name);
  if (!existsSync(file)) throw new Error(`No worker named ${name}.`);
  const meta = readMeta(file);
  if (meta.state !== 'held') throw new Error(`Worker ${name} is still queued; nothing to finish. Cancel with: coordinate cancel ${meta.id}.`);
  if (git(meta.path, 'status', '--porcelain')) throw new Error(`Worker ${name} has uncommitted changes in ${meta.path}. Commit or discard them first.`);
  const target = meta.into;
  const forkPoint = git(dirs.primary, 'merge-base', target, meta.branch);
  const changed = git(dirs.primary, 'diff', '--name-only', forkPoint, meta.branch).split('\n').filter(Boolean);
  const outside = changed.filter((path) => !declared(meta.files, path));
  if (outside.length) throw new Error(`Worker ${name} changed undeclared files: ${outside.join(', ')}. Revert them or start a worker that owns them.`);
  const targetSha = git(dirs.primary, 'rev-parse', target);
  if (forkPoint !== targetSha) {
    throw new Error(`${target} moved on since ${name} started. Rebase first: git -C "${meta.path}" rebase ${target}, rerun its checks, then finish again.`);
  }
  if (git(dirs.primary, 'branch', '--show-current') !== target || git(dirs.primary, 'status', '--porcelain', '--untracked-files=no')) {
    throw new Error(`The primary checkout must be clean and on ${target} to merge ${name}.`);
  }
  git(dirs.primary, 'merge', '--ff-only', '-q', meta.branch);
  coordinate(project, ['release', meta.id], credential(dirs, meta.id));
  rmSync(join(dirs.credentials, meta.id), { force: true });
  git(dirs.primary, 'worktree', 'remove', meta.path);
  git(dirs.primary, 'branch', '-q', '-d', meta.branch);
  rmSync(file);
  return { name, merged: git(dirs.primary, 'rev-parse', 'HEAD'), into: target, changed, released: meta.id };
}
