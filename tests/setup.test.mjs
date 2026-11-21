import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const plugin = fileURLToPath(new URL('../plugins/development-team-toolkit/', import.meta.url));
const cli = join(plugin, 'bin', 'toolkit.mjs');
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
const toolkit = (cwd, args, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const json = (result) => JSON.parse(result.stdout);
const check = (report, name) => report.checks.find((item) => item.check === name);

async function project(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'toolkit-setup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  for (const [file, text] of [['web/styles/site.scss', '.a{}'], ['src/billing/charge.js', 'x'], ['src/ui/list.js', 'y'],
    ['tests/charge.test.js', 'z'], ['db/migrations/001.sql', 'w']]) {
    await mkdir(join(root, ...file.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(root, ...file.split('/')), text);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

test('setup scan suggests hot paths and shows how much each default role scope covers', async (t) => {
  const root = await project(t);
  const scan = json(toolkit(root, ['setup', 'scan']));
  assert.equal(scan.files, 5);
  assert.deepEqual(scan.hotPathCandidates, ['db/migrations/**', 'src/billing/**']);
  assert.equal(scan.roles.designer.matches, 1);
  assert.equal(scan.roles['test-engineer'].matches, 1);
  assert.equal(scan.roles['concept-artist'].matches, 0);
  assert.equal(scan.otherCoordinator, false);
  assert.ok(scan.runtimes.node.startsWith('v'));
});

test('doctor reports each missing step with its fix, then passes once set up', async (t) => {
  const root = await project(t);
  const codexHome = join(root, '.codex-home');
  await mkdir(codexHome);
  const env = { CODEX_HOME: codexHome };
  const before = toolkit(root, ['doctor'], env);
  assert.equal(before.status, 1);
  assert.match(check(json(before), 'Project settings').fix, /setup skill/);
  assert.equal(check(json(before), 'Codex guard hook installed').ok, false);

  await writeFile(join(root, 'seed.json'), JSON.stringify({ schemaVersion: 1, id: 'shop', title: 'Shop',
    roles: { 'concept-artist': { enabled: false }, designer: { writeScope: ['web/**/*.scss'] } }, review: { hotPaths: ['src/billing/**'] } }));
  assert.equal(toolkit(root, ['init', 'seed.json']).status, 0);
  assert.equal(json(toolkit(root, ['sync-claude'])).roles, 10);
  assert.equal(existsSync(join(root, '.claude', 'agents', 'toolkit-concept-artist.md')), false);
  toolkit(root, ['sync-codex']);
  const installed = json(toolkit(root, ['install-codex-hooks']));
  const policy = JSON.parse(await readFile(installed.policy, 'utf8'));
  assert.equal(policy.roles['toolkit-concept-artist'], undefined);

  const untrusted = json(toolkit(root, ['doctor'], env));
  assert.equal(untrusted.ok, false);
  assert.deepEqual(untrusted.checks.filter((item) => !item.ok).map((item) => item.check), ['Codex guard hook trusted']);
  assert.match(check(untrusted, 'Codex guard hook trusted').fix, /\/hooks/);

  // Codex records trust per hook entry in config.toml; doctor looks for this project's entry.
  const key = join(root, '.codex', 'hooks.json').replaceAll('\\', '\\\\');
  await writeFile(join(codexHome, 'config.toml'), `[hooks.state."${key}:pre_tool_use:0:0"]\ntrusted_hash = "sha256:abc"\n`);
  const trusted = toolkit(root, ['doctor'], env);
  assert.equal(trusted.status, 0, trusted.stdout);
  assert.equal(json(trusted).ok, true);

  // Changing settings makes the profiles and policy stale until the next sync.
  await writeFile(join(root, 'update.json'), JSON.stringify({ schemaVersion: 1, id: 'shop', title: 'Shop', roles: { 'qa-code': { tier: 'top' } } }));
  assert.equal(toolkit(root, ['save', 'update.json']).status, 0);
  const stale = json(toolkit(root, ['doctor'], env));
  assert.equal(check(stale, 'Claude Code profiles').ok, false);
  assert.equal(check(stale, 'Role policy').detail, 'out of date');
  await writeFile(join(root, 'bad.json'), JSON.stringify({ schemaVersion: 1, id: 'shop', title: 'Shop', roles: { designer: { enabled: 'no' } } }));
  assert.match(toolkit(root, ['save', 'bad.json']).stderr, /Invalid role override for designer/);
});

test('the setup skill ships in the plugin skills folder both runtimes load', async () => {
  const skill = await readFile(join(plugin, 'skills', 'setup', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: setup\n/);
  assert.equal(JSON.parse(await readFile(join(plugin, '.codex-plugin', 'plugin.json'), 'utf8')).skills, './skills');
});
