import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, globRegex, shellOk } from '../plugins/development-team-toolkit/bin/role-guard.mjs';

const plugin = fileURLToPath(new URL('../plugins/development-team-toolkit/', import.meta.url));
const cli = join(plugin, 'bin', 'toolkit.mjs');
const guard = join(plugin, 'bin', 'role-guard.mjs');
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const run = (cwd, args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('read-only shell commands pass and anything that can write is refused', () => {
  for (const command of ['rg -n foo src', 'git diff HEAD~1 -- a.js', 'git log --oneline -5 | head -3', 'Get-Content a.js',
    'rtk git status', 'cd sub && rg x', 'git -C sub show HEAD:a.js', 'ls -la']) {
    assert.ok(shellOk(command), command);
  }
  for (const command of ['echo hi > a.txt', 'Set-Content a hi', 'rm -rf x', 'git commit -m x', 'git checkout main',
    'git worktree add ../x', 'python -c "x"', 'python script.py', 'npm install', 'cat a | tee b', 'git branch -D x',
    "sed -i 's/a/b/' f", 'curl http://x', 'echo $(whoami)', 'find . -delete', '']) {
    assert.ok(!shellOk(command), command);
  }
  assert.ok(shellOk('node --test tests/a.test.mjs') && !shellOk('node --test tests/a.test.mjs', false));
  assert.ok(globRegex('**/*.scss').test('a/b/c.scss') && globRegex('**/*.scss').test('c.scss') && !globRegex('src/*.js').test('src/a/b.js'));
});

test('roles are held to their access in both runtimes, and the parent session is never blocked', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'role-guard-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'base');
  const linked = join(root, 'wt');
  git(root, 'worktree', 'add', '-q', linked);
  const policy = { linkedWorktreeOnly: false, roles: {
    'toolkit-qa-code': { access: 'read-only', shell: 'read-only+unit-tests', writeScope: [], readTools: [] },
    'toolkit-qa-ux': { access: 'read-only', shell: 'read-only+unit-tests', writeScope: [], readTools: ['browser'] },
    'toolkit-designer': { access: 'scoped-writer', shell: 'read-only', writeScope: ['**/*.scss'], readTools: [] },
    'toolkit-developer': { access: 'scoped-writer', shell: 'full', writeScope: ['**'], readTools: [] },
  } };
  const check = (role, tool, input, cwd = root, rules = policy) => decide({ agent_type: role, tool_name: tool, tool_input: input, cwd }, rules);

  assert.equal(check(undefined, 'Edit', { file_path: join(root, 'a.py') }), null);
  assert.equal(check('toolkit-qa-code', 'Read', {}), null);
  assert.equal(check('toolkit-qa-code', 'mcp__coordinator__coordinator_call', {}), null);
  assert.match(check('toolkit-qa-code', 'Edit', { file_path: join(root, 'a.py') }), /read-only role/);
  assert.match(check('Toolkit QA Code', 'Bash', { command: 'rm x' }), /shell command can change state/); // Codex display name
  assert.equal(check('toolkit-qa-code', 'Bash', { command: 'node --test t.mjs' }), null);
  assert.match(check('toolkit-qa-code', 'mcp__Claude_Browser__navigate', {}), /not allowed/);
  assert.equal(check('toolkit-qa-ux', 'mcp__Claude_Browser__navigate', {}), null);

  assert.equal(check('toolkit-designer', 'Write', { file_path: join(root, 'web', 'site.scss') }), null);
  assert.match(check('toolkit-designer', 'Write', { file_path: join(root, 'models', 'sale.py') }), /outside this role's write scope/);
  assert.match(check('toolkit-designer', 'Bash', { command: 'node --test t.mjs' }), /shell is read-only/);
  assert.match(check('toolkit-designer', 'Skill', {}), /not allowed/);
  // Exact shape Codex sends for apply_patch: paths relative to the session cwd.
  const patch = (path) => ({ command: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` });
  assert.equal(check('toolkit-designer', 'apply_patch', patch('web/site.scss')), null);
  assert.match(check('toolkit-designer', 'apply_patch', patch('models/sale.py')), /outside this role's write scope/);
  assert.match(check('toolkit-designer', 'Write', { file_path: join(tmpdir(), 'loose.scss') }), /not inside a Git worktree|outside/);

  assert.equal(check('toolkit-developer', 'Edit', { file_path: join(root, 'a.py') }), null);
  assert.equal(check('toolkit-developer', 'Bash', { command: 'git commit -m x' }), null);
  const strict = { ...policy, linkedWorktreeOnly: true };
  assert.match(check('toolkit-developer', 'Edit', { file_path: join(root, 'a.py') }, root, strict), /primary checkout/);
  assert.equal(check('toolkit-developer', 'Edit', { file_path: join(linked, 'a.py') }, root, strict), null);
});

test('sync writes the shared policy with project overrides, and install-codex-hooks is idempotent', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'role-policy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'base');
  await writeFile(join(root, 'seed.json'), JSON.stringify({ schemaVersion: 1, id: 'p', title: 'P',
    roles: { designer: { writeScope: ['web/**/*.scss'] }, 'qa-code': { tier: 'top' } }, rolePolicy: { linkedWorktreeOnly: true } }));
  run(root, ['init', 'seed.json']);
  const synced = run(root, ['sync-claude']);
  const policy = JSON.parse(await readFile(synced.policy, 'utf8'));
  assert.equal(synced.policy, join(root, '.git', 'development-team-role-policy.json'));
  assert.deepEqual(policy.roles['toolkit-designer'].writeScope, ['web/**/*.scss']);
  assert.equal(policy.linkedWorktreeOnly, true);
  assert.equal(policy.roles['toolkit-qa-code'].access, 'read-only');
  assert.match(await readFile(join(root, '.claude', 'agents', 'toolkit-qa-code.md'), 'utf8'), /\nmodel: "opus"\n/);

  // The real guard process denies a designer writing Python and allows its SCSS, reading the policy from Git.
  const hook = (event) => spawnSync(process.execPath, [guard], { input: JSON.stringify({ cwd: root, ...event }), encoding: 'utf8' });
  await mkdir(join(root, 'web'), { recursive: true });
  const denied = hook({ agent_type: 'toolkit-designer', tool_name: 'Write', tool_input: { file_path: join(root, 'web', 'a.py') } });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const first = run(root, ['install-codex-hooks']);
  assert.equal(first.changed, true);
  assert.equal(run(root, ['install-codex-hooks']).changed, false);
  const hooks = JSON.parse(await readFile(join(root, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.PreToolUse.length, 1);
  assert.match(hooks.hooks.PreToolUse[0].hooks[0].command, /role-guard\.mjs"$/);
  assert.equal(await readFile(first.guard, 'utf8'), await readFile(guard, 'utf8'));

  await writeFile(join(root, 'bad.json'), JSON.stringify({ schemaVersion: 1, id: 'p', title: 'P', roles: { designer: { access: 'admin' } } }));
  const bad = spawnSync(process.execPath, [cli, 'save', 'bad.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Invalid role override for designer/);
});

test('the Claude plugin ships the guard as a PreToolUse hook', async () => {
  const manifest = JSON.parse(await readFile(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.hooks.PreToolUse[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/bin/role-guard.mjs"');
});
