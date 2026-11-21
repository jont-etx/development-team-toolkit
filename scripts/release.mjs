// Cut a release: bump the version in both plugin manifests and the role catalog, add a CHANGELOG entry from the
// commits since the last tag, run the tests, then commit and tag. Pushing stays a separate, deliberate step.
//   node scripts/release.mjs <version> [--dry-run]
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const plugin = join(root, 'plugins', 'development-team-toolkit');
const files = {
  claude: join(plugin, '.claude-plugin', 'plugin.json'),
  codex: join(plugin, '.codex-plugin', 'plugin.json'),
  catalog: join(plugin, 'toolkit-wiki', 'roles.json'),
  changelog: join(root, 'CHANGELOG.md'),
};
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const parse = (version) => (/^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : null);
const newer = (a, b) => {
  const i = a.findIndex((part, at) => part !== b[at]);
  return i >= 0 && a[i] > b[i];
};

export function releaseEntry(version, date, subjects) {
  return `## ${version} - ${date}\n\n${subjects.map((subject) => `- ${subject}`).join('\n')}\n`;
}

export function insertEntry(changelog, entry) {
  const at = changelog.search(/^## /m);
  return at < 0 ? `${changelog.trimEnd()}\n\n${entry}` : `${changelog.slice(0, at)}${entry}\n${changelog.slice(at)}`;
}

function main([version, flag]) {
  const next = parse(version ?? '');
  if (!next || (flag && flag !== '--dry-run')) throw new Error('Usage: node scripts/release.mjs <major.minor.patch> [--dry-run]');
  const manifests = [files.claude, files.codex].map((file) => JSON.parse(readFileSync(file, 'utf8')));
  const current = manifests[0].version;
  if (manifests[1].version !== current) throw new Error(`Manifest versions differ: ${current} vs ${manifests[1].version}.`);
  if (!newer(next, parse(current))) throw new Error(`${version} is not newer than ${current}.`);
  if (git('status', '--porcelain')) throw new Error('Commit or stash changes before releasing.');
  if (git('tag', '--list', `v${version}`)) throw new Error(`Tag v${version} already exists.`);
  const last = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*');
  const subjects = git('log', '--no-merges', '--reverse', '--format=%s', `${last}..HEAD`).split('\n').filter(Boolean);
  if (!subjects.length) throw new Error(`No commits since ${last}.`);
  const entry = releaseEntry(version, new Date().toISOString().slice(0, 10), subjects);
  if (flag === '--dry-run') return { version, from: current, since: last, entry };

  const tests = spawnSync(process.execPath, ['--test', 'tests/'], { cwd: root, stdio: 'inherit' });
  if (tests.status !== 0) throw new Error('Tests failed; nothing was changed.');
  manifests.forEach((manifest, i) => writeFileSync([files.claude, files.codex][i], `${JSON.stringify({ ...manifest, version }, null, 2)}\n`));
  const catalog = JSON.parse(readFileSync(files.catalog, 'utf8'));
  writeFileSync(files.catalog, `${JSON.stringify({ ...catalog, revision: version }, null, 2)}\n`);
  writeFileSync(files.changelog, insertEntry(readFileSync(files.changelog, 'utf8').replaceAll('\r\n', '\n'), entry));
  git('add', files.claude, files.codex, files.catalog, files.changelog);
  git('commit', '-q', '-m', `Release ${version}`);
  git('tag', '-a', `v${version}`, '-m', `Release ${version}`);
  return { version, from: current, since: last, tag: `v${version}`, next: 'Push with: git push origin HEAD:main --follow-tags' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
