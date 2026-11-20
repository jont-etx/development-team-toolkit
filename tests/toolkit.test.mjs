import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const plugin = new URL('../plugins/development-team-toolkit/', import.meta.url);
const cli = fileURLToPath(new URL('bin/toolkit.mjs', plugin));
const toolkitWiki = fileURLToPath(new URL('toolkit-wiki/', plugin));
const projectConfig = { schemaVersion: 1, id: 'fresh-project', title: 'Fresh Project' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'development-team-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'seed.json'), JSON.stringify(projectConfig));
  await writeFile(join(root, 'update.json'), JSON.stringify({ ...projectConfig, title: 'Updated' }));
  return root;
}

function run(cwd, args, failure) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  assert.ifError(result.error);
  if (failure) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, failure);
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('clean project uses local config and wiki-sourced native agent profiles', async (t) => {
  const root = await fixture(t);
  assert.equal(run(root, ['status']).initialized, false);
  assert.equal(run(root, ['init', 'seed.json']).store, 'local');
  assert.deepEqual(run(root, ['config']), projectConfig);
  assert.equal(run(root, ['save', 'update.json']).store, 'local');
  assert.equal(run(root, ['config']).title, 'Updated');
  run(root, ['init', 'seed.json'], /already exist/);
  const agents = run(root, ['sync-codex']);
  assert.equal(agents.roles, 9);
  assert.equal(agents.updated, 9);
  assert.equal(run(root, ['sync-codex']).updated, 0);
  const interviewer = join(agents.directory, 'toolkit-interviewer.toml');
  assert.match(await readFile(interviewer, 'utf8'), /gpt-6\.2-sol/);
  assert.match(await readFile(interviewer, 'utf8'), /Curious and concise/);
  await writeFile(interviewer, '# project customization\n', { flag: 'a' });
  run(root, ['sync-codex'], /conflicts with toolkit setup/);
  assert.match(await readFile(interviewer, 'utf8'), /project customization/);
  assert.equal(existsSync(join(root, '.wiki')), false);
});

test('Claude Code subagents come from the same role catalog and keep project edits', async (t) => {
  const root = await fixture(t);
  run(root, ['init', 'seed.json']);
  const agents = run(root, ['sync-claude']);
  assert.equal(agents.roles, 9);
  assert.equal(agents.updated, 9);
  assert.match(agents.directory, /[\\/]\.claude[\\/]agents$/);
  assert.equal(run(root, ['sync-claude']).updated, 0);
  const architect = join(agents.directory, 'toolkit-architect.md');
  const contents = await readFile(architect, 'utf8');
  assert.match(contents, /^---\n# Development Team Toolkit generated content SHA256 [0-9a-f]{64}\nname: "toolkit-architect"\n/);
  assert.match(contents, /\nmodel: "opus"\n---\n\nFollow the current project's instructions/);
  assert.match(await readFile(join(agents.directory, 'toolkit-coordinator.md'), 'utf8'), /\nmodel: "inherit"\n/);
  assert.equal(existsSync(join(root, '.codex')), false);
  await writeFile(architect, 'project customization\n', { flag: 'a' });
  run(root, ['sync-claude'], /conflicts with toolkit setup/);
  assert.match(await readFile(architect, 'utf8'), /project customization/);
});

test('model tiers drive profiles, project overrides apply, and models check flags drift', async (t) => {
  const root = await fixture(t);
  const catalog = join(root, 'models.json');
  await writeFile(catalog, JSON.stringify({ fetched_at: new Date().toISOString(), models: [
    { slug: 'gpt-6.2-sol', visibility: 'list' }, { slug: 'gpt-6.1-terra', visibility: 'list' },
    { slug: 'gpt-7-sol', visibility: 'list' }, { slug: 'hidden-model', visibility: 'hide' },
  ] }));
  run(root, ['init', 'seed.json']);
  const agents = run(root, ['sync-codex']);
  assert.match(await readFile(join(agents.directory, 'toolkit-architect.toml'), 'utf8'), /model = "gpt-6\.2-sol"\nmodel_reasoning_effort = "high"/);
  await mkdir(join(root, '.claude', 'agents'), { recursive: true });
  const handWritten = join(root, '.claude', 'agents', 'team-architect.md');
  await writeFile(handWritten, '---\nname: team-architect\nmodel: opus\n---\n\nKeep this text.\n');
  await mkdir(join(root, '.codex', 'agents'), { recursive: true });
  const codexHand = join(root, '.codex', 'agents', 'team-architect.toml');
  await writeFile(codexHand, 'name = "Team Architect"\nmodel = "gpt-5-old"\ndeveloper_instructions = "Keep this text."\n');

  const report = run(root, ['models', 'check', '--codex-catalog', catalog]);
  assert.deepEqual(report.codex.candidates, ['gpt-7-sol']);
  assert.equal(report.codex.tiers.top.available, true);
  assert.ok(report.attention.some((line) => line.includes('team-architect.toml uses gpt-5-old')));
  assert.ok(report.attention.some((line) => line.includes('gpt-7-sol')));
  assert.equal(report.claude.profiles.find((profile) => profile.file.endsWith('team-architect.md')).model, 'opus');
  assert.ok(!report.attention.some((line) => line.includes('catalog is')));
  const stale = join(root, 'stale.json');
  await writeFile(stale, JSON.stringify({ fetched_at: '2020-01-01T00:00:00Z', models: [] }));
  assert.ok(run(root, ['models', 'check', '--codex-catalog', stale]).attention.some((line) => /catalog is \d+ days old/.test(line)));
  run(root, ['models', 'check', '--record', '--codex-catalog', catalog]);
  const reviewed = run(root, ['models', 'check', '--codex-catalog', catalog]);
  assert.deepEqual(reviewed.codex.candidates, []);
  assert.equal(reviewed.codex.baseline, join('.development-team', 'model-catalog.json'));

  run(root, ['models', 'retarget', 'codex', 'gpt-5-old', 'gpt-missing', '--codex-catalog', catalog], /does not offer gpt-missing/);
  const moved = run(root, ['models', 'retarget', 'codex', 'gpt-5-old', 'gpt-7-sol', '--codex-catalog', catalog]);
  assert.deepEqual(moved.changed, [join('.codex', 'agents', 'team-architect.toml')]);
  assert.equal(await readFile(codexHand, 'utf8'), 'name = "Team Architect"\nmodel = "gpt-7-sol"\ndeveloper_instructions = "Keep this text."\n');
  assert.deepEqual(run(root, ['models', 'retarget', 'codex', 'gpt-6.2-sol', 'gpt-7-sol', '--codex-catalog', catalog]).changed, []);
  run(root, ['models', 'retarget', 'claude', 'opus', 'sonnet']);
  assert.equal(await readFile(handWritten, 'utf8'), '---\nname: team-architect\nmodel: "sonnet"\n---\n\nKeep this text.\n');

  const settings = JSON.parse(await readFile(join(root, '.development-team', 'project.json')));
  await writeFile(join(root, 'models.settings.json'), JSON.stringify({ ...settings, models: { codex: { top: 'gpt-7-sol' }, claude: { strong: 'opus' } } }));
  run(root, ['save', 'models.settings.json']);
  assert.equal(run(root, ['sync-codex']).updated, 3);
  assert.match(await readFile(join(agents.directory, 'toolkit-architect.toml'), 'utf8'), /model = "gpt-7-sol"/);
  assert.match(await readFile(join(agents.directory, 'toolkit-developer.toml'), 'utf8'), /model = "gpt-6\.1-terra"/);
  run(root, ['sync-claude']);
  assert.match(await readFile(join(root, '.claude', 'agents', 'toolkit-developer.md'), 'utf8'), /\nmodel: "opus"\n/);
  await writeFile(join(root, 'bad.json'), JSON.stringify({ ...settings, models: { codex: { best: 'x' } } }));
  run(root, ['save', 'bad.json'], /known runtimes and tiers/);
});

test('detected project wiki is authoritative even after it becomes unavailable', async (t) => {
  const root = await fixture(t);
  const wiki = join(root, '.wiki');
  await mkdir(wiki);
  assert.equal(run(root, ['init', 'seed.json']).store, 'wiki');
  assert.deepEqual(run(root, ['config']), projectConfig);
  assert.equal(run(root, ['save', 'update.json']).store, 'wiki');
  assert.equal(JSON.parse(await readFile(join(wiki, 'development-team', 'project.json'))).title, 'Updated');
  await rename(wiki, join(root, 'offline-wiki'));
  run(root, ['save', 'update.json'], /wiki unavailable/);
  assert.equal(existsSync(join(root, '.development-team', 'project.json')), false);
});

test('ambiguity, conflicts and toolkit wiki cannot create a second settings source', async (t) => {
  const root = await fixture(t);
  run(root, ['init', 'seed.json', '--wiki', toolkitWiki], /cannot be stored in the toolkit wiki/);
  await mkdir(join(root, 'wiki'));
  await mkdir(join(root, '.wiki'));
  run(root, ['init', 'seed.json'], /Multiple project wikis/);
  assert.equal(run(root, ['init', 'seed.json', '--wiki', 'wiki']).store, 'wiki');
  run(root, ['init', 'seed.json', '--wiki', '.wiki'], /already has a configured wiki/);
  assert.equal(existsSync(join(root, '.wiki', 'development-team')), false);
});

test('detecting a new wiki does not silently migrate existing local project data', async (t) => {
  const root = await fixture(t);
  run(root, ['init', 'seed.json']);
  await mkdir(join(root, '.wiki'));
  run(root, ['save', 'update.json'], /local project config already exists/);
  assert.deepEqual(JSON.parse(await readFile(join(root, '.development-team', 'project.json'))), projectConfig);
});
