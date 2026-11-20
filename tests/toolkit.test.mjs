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
