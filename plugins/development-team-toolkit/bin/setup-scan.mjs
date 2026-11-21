// Read-only repository scan that feeds the setup interview: what the project is made of, where styles,
// tests, docs and visuals live, which paths look high-stakes, and how many files each role's default write
// scope would cover. It only suggests; the user decides.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { globRegex } from './role-guard.mjs';

const HOT = /(^|[/_.-])(billing|payments?|checkout|invoices?|pricing|prices|auth|authentication|login|oauth|security|permissions?|secrets?|crypto|migrations?)([/_.-]|$)/i;

function trackedFiles(project) {
  try {
    return execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: project, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function version(command) {
  // One fixed command string: Windows starts the npm .cmd shims only through the shell.
  const result = spawnSync(`${command} --version`, { encoding: 'utf8', shell: true, timeout: 15000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split('\n')[0] : null;
}

export function setupScan(project, catalog) {
  const files = trackedFiles(project);
  const extensions = {};
  for (const file of files) {
    const ext = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1).toLowerCase() : '(none)';
    extensions[ext] = (extensions[ext] ?? 0) + 1;
  }
  const top = Object.entries(extensions).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const hotPaths = new Set();
  for (const file of files) {
    const parts = file.split('/');
    const at = parts.findIndex((part, i) => i < parts.length - 1 && HOT.test(part));
    if (at >= 0) hotPaths.add(`${parts.slice(0, at + 1).join('/')}/**`);
  }
  const roles = {};
  for (const role of catalog.roles.filter((item) => item.writeScope?.length)) {
    const patterns = role.writeScope.map(globRegex);
    roles[role.id] = { defaultScope: role.writeScope, matches: files.filter((file) => patterns.some((re) => re.test(file))).length };
  }
  const agents = (dir) => (existsSync(join(project, dir)) ? readdirSync(join(project, dir)).filter((name) => !name.startsWith('toolkit-')) : []);
  return {
    files: files.length,
    extensions: Object.fromEntries(top),
    wiki: ['.wiki', 'wiki', 'docs'].filter((dir) => existsSync(join(project, dir))),
    hotPathCandidates: [...hotPaths].sort().slice(0, 30),
    roles,
    existingAgents: { claude: agents(join('.claude', 'agents')), codex: agents(join('.codex', 'agents')) },
    otherCoordinator: existsSync(join(project, '.coordinator', 'state.sqlite3')),
    runtimes: { node: process.version, claude: version('claude'), codex: version('codex') },
    note: 'Suggestions only. A role scope with 0 matches probably needs a project override; confirm hot paths with the owner.',
  };
}
