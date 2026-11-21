// Update this machine's toolkit installs after a release. Codex pins the marketplace to an exact commit (`ref` in
// config.toml), so move the pin first, then refresh both runtimes. Neither runtime updates on its own.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const SHA = /^[0-9a-f]{40}$/;

/** Returns config text with the marketplace's `ref` set, or null when that marketplace has no pinned ref. */
export function setCodexRef(text, marketplace, ref) {
  const header = `[marketplaces.${marketplace}]`;
  const start = text.indexOf(header);
  if (start < 0) return null;
  const end = text.indexOf('\n[', start + header.length);
  const block = text.slice(start, end < 0 ? text.length : end);
  if (!/^ref = "[^"]*"$/m.test(block)) return null;
  return text.slice(0, start) + block.replace(/^ref = "[^"]*"$/m, `ref = "${ref}"`) + (end < 0 ? '' : text.slice(end));
}

export function codexSource(text, marketplace) {
  const start = text.indexOf(`[marketplaces.${marketplace}]`);
  if (start < 0) return null;
  const end = text.indexOf('\n[', start + 1);
  return text.slice(start, end < 0 ? text.length : end).match(/^source = "([^"]+)"$/m)?.[1] ?? null;
}

function run(command) {
  // Fixed command strings built from validated names; Windows starts the npm .cmd shims only through the shell.
  const result = spawnSync(command, { encoding: 'utf8', shell: true, timeout: 300000, windowsHide: true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-2).join(' ');
  return { command, ok: result.status === 0 && !/access is denied|failed to/i.test(output), output };
}

export function updateInstalls({ marketplace = 'development-team-private', plugin = 'development-team-toolkit', ref } = {}) {
  if (!SLUG.test(marketplace) || !SLUG.test(plugin)) throw new Error('Marketplace and plugin names must be simple slugs.');
  if (ref !== undefined && !SHA.test(ref)) throw new Error('--ref must be a full 40-character commit SHA.');
  const steps = [];
  const config = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  if (existsSync(config)) {
    const text = readFileSync(config, 'utf8');
    let target = ref;
    const source = codexSource(text, marketplace);
    if (!target && source && setCodexRef(text, marketplace, 'x') !== null) {
      target = execFileSync('git', ['ls-remote', source, 'refs/heads/main'], { encoding: 'utf8', timeout: 60000 }).split('\t')[0];
    }
    const updated = target ? setCodexRef(text, marketplace, target) : null;
    if (updated !== null && updated !== text) writeFileSync(config, updated);
    steps.push({ runtime: 'codex', pinned: target ?? 'not pinned' });
    steps.push(run(`codex plugin marketplace upgrade ${marketplace}`), run(`codex plugin add ${plugin}@${marketplace}`));
  } else {
    steps.push({ runtime: 'codex', skipped: 'no Codex config found' });
  }
  steps.push(run(`claude plugin marketplace update ${marketplace}`), run(`claude plugin update ${plugin}@${marketplace}`));
  const blocked = steps.some((step) => /access is denied/i.test(step.output ?? ''));
  return {
    ok: steps.every((step) => step.ok !== false),
    steps,
    next: blocked ? 'The Codex app holds the old plugin folder: close Codex, then run update-installs again.'
      : 'Restart open Claude Code and Codex sessions to load the new version.',
  };
}
