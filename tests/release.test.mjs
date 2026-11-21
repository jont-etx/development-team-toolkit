import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertEntry, releaseEntry } from '../scripts/release.mjs';
import { codexSource, setCodexRef } from '../plugins/development-team-toolkit/bin/update-installs.mjs';

test('release entries go above the newest version in the changelog', () => {
  const entry = releaseEntry('0.6.0', '2026-11-22', ['Add a thing', 'Fix a test']);
  assert.equal(entry, '## 0.6.0 - 2026-11-22\n\n- Add a thing\n- Fix a test\n');
  const log = '# Changelog\n\nIntro.\n\n## 0.5.0 - 2026-11-21\n\n- Old\n';
  assert.equal(insertEntry(log, entry), '# Changelog\n\nIntro.\n\n## 0.6.0 - 2026-11-22\n\n- Add a thing\n- Fix a test\n\n## 0.5.0 - 2026-11-21\n\n- Old\n');
});

test('update-installs moves only the pinned ref of the named Codex marketplace', () => {
  const config = [
    '[marketplaces.other]', 'source = "https://example.invalid/other.git"', 'ref = "1111111111111111111111111111111111111111"', '',
    '[marketplaces.development-team-private]', 'source_type = "git"', 'source = "https://example.invalid/toolkit.git"',
    'ref = "2222222222222222222222222222222222222222"', '', '[plugins."x@y"]', 'enabled = true', '',
  ].join('\n');
  const next = setCodexRef(config, 'development-team-private', '3'.repeat(40));
  assert.match(next, /ref = "3{40}"/);
  assert.match(next, /ref = "1{40}"/);
  assert.doesNotMatch(next, /2{40}/);
  assert.equal(codexSource(config, 'development-team-private'), 'https://example.invalid/toolkit.git');
  assert.equal(setCodexRef('[marketplaces.development-team-private]\nsource = "x"\n', 'development-team-private', '3'.repeat(40)), null);
  assert.equal(setCodexRef(config, 'missing', '3'.repeat(40)), null);
});
