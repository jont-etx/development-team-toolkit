import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globRegex } from './role-guard.mjs';

const toolkitWiki = await realpath(fileURLToPath(new URL('../toolkit-wiki/', import.meta.url)));
const catalog = JSON.parse(await readFile(join(toolkitWiki, 'roles.json'), 'utf8'));
const project = process.cwd();
const projectDir = join(project, '.development-team');
const localFile = join(projectDir, 'project.json');
const wikiLocator = join(projectDir, 'wiki.json');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function validateProject(config) {
  if (config?.schemaVersion !== 1 || typeof config.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.id)
      || typeof config.title !== 'string' || !config.title.trim()) {
    throw new Error('Project settings require schemaVersion 1, a slug id, and a title.');
  }
  return config;
}

async function settingsStore(explicitWiki) {
  const hasLocator = await exists(wikiLocator);
  const pinned = hasLocator ? (await readJson(wikiLocator))?.path : undefined;
  if (hasLocator && (typeof pinned !== 'string' || !pinned.trim())) {
    throw new Error('Invalid project wiki locator.');
  }
  if (explicitWiki && pinned && resolve(project, explicitWiki) !== resolve(project, pinned)) {
    throw new Error('This project already has a configured wiki.');
  }

  let path = explicitWiki ?? pinned;
  if (!path) {
    const candidates = [];
    for (const directory of ['.wiki', 'wiki']) {
      const candidate = join(project, directory);
      if (await exists(candidate) && (await stat(candidate)).isDirectory()) candidates.push(candidate);
    }
    if (candidates.length > 1) throw new Error('Multiple project wikis found. Select one with init <seed.json> --wiki <path>.');
    [path] = candidates;
  }
  if (!path) return { kind: 'local', file: localFile };

  const requested = resolve(project, path);
  if (!(await exists(requested)) || !(await stat(requested)).isDirectory()) {
    throw new Error(`Configured project wiki unavailable: ${requested}`);
  }
  const wiki = await realpath(requested);
  const fromToolkit = relative(toolkitWiki, wiki);
  if (!isAbsolute(fromToolkit) && fromToolkit !== '..' && !fromToolkit.startsWith(`..${sep}`)) {
    throw new Error('Project settings cannot be stored in the toolkit wiki.');
  }
  if (!relative(project, wiki) || !relative(projectDir, wiki)) throw new Error('Select a separate project wiki directory.');
  if (await exists(localFile)) {
    throw new Error('A local project config already exists. Move it into the project wiki before switching stores.');
  }
  return { kind: 'wiki', wiki, pinned: Boolean(pinned), file: join(wiki, 'development-team', 'project.json') };
}

async function writeJson(path, value, create) {
  await mkdir(dirname(path), { recursive: true });
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (create) {
    await writeFile(path, contents, { flag: 'wx' });
    return;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, contents, { flag: 'wx' });
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

const hash = (value) => createHash('sha256').update(value).digest('hex');
const cleanLines = (value) => value.replaceAll('\r\n', '\n');

const instructions = (role) => [catalog.specialistRules, role.personality, role.instructions].join('\n\n');
const marker = '# Development Team Toolkit generated content SHA256 ';

// Roles name a capability tier; each runtime maps tiers to models. Project settings may override a tier.
function modelTiers(config) {
  const override = config?.models;
  if (override !== undefined && (override === null || typeof override !== 'object' || Array.isArray(override)
      || Object.entries(override).some(([runtime, tiers]) => !catalog.modelTiers[runtime] || !tiers || typeof tiers !== 'object'
        || Array.isArray(tiers) || Object.entries(tiers).some(([tier, model]) => !(tier in catalog.modelTiers[runtime])
          || typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/.test(model))))) {
    throw new Error('Project models settings map a runtime to { tier: model } for known runtimes and tiers.');
  }
  return Object.fromEntries(Object.entries(catalog.modelTiers).map(([runtime, tiers]) => [runtime, { ...tiers, ...override?.[runtime] }]));
}

// Role access: what each specialist may do. Projects override any field per role under `roles.<id>`.
const ACCESS = ['read-only', 'scoped-writer'];
const SHELLS = ['read-only', 'read-only+unit-tests', 'full'];
const OVERRIDABLE = ['enabled', 'access', 'shell', 'writeScope', 'readTools', 'tier', 'effort'];
const BROWSER_TOOLS = ['navigate', 'read_page', 'get_page_text', 'find', 'computer', 'form_input', 'javascript_tool',
  'read_console_messages', 'read_network_requests', 'resize_window', 'tabs_context', 'tabs_create', 'tabs_select',
  'tabs_close', 'browser_batch', 'preview_list', 'preview_logs'].map((name) => `mcp__Claude_Browser__${name}`);

function effectiveRoles(config) {
  const overrides = config?.roles ?? {};
  const policy = config?.rolePolicy ?? {};
  const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item && item.length < 300);
  if (typeof overrides !== 'object' || Array.isArray(overrides) || typeof policy !== 'object' || Array.isArray(policy)
      || Object.keys(policy).some((key) => key !== 'linkedWorktreeOnly')
      || (policy.linkedWorktreeOnly !== undefined && typeof policy.linkedWorktreeOnly !== 'boolean')) {
    throw new Error('Project roles settings map a role id to its overrides; rolePolicy accepts linkedWorktreeOnly.');
  }
  for (const [id, fields] of Object.entries(overrides)) {
    const role = catalog.roles.find((item) => item.id === id);
    if (!role || role.id === 'pm' || !fields || typeof fields !== 'object' || Array.isArray(fields)
        || Object.keys(fields).some((key) => !OVERRIDABLE.includes(key))
        || (fields.enabled !== undefined && typeof fields.enabled !== 'boolean')
        || (fields.access !== undefined && !ACCESS.includes(fields.access))
        || (fields.shell !== undefined && !SHELLS.includes(fields.shell))
        || (fields.writeScope !== undefined && !strings(fields.writeScope))
        || (fields.readTools !== undefined && !strings(fields.readTools))
        || (fields.tier !== undefined && !(fields.tier in catalog.modelTiers.codex))
        || (fields.effort !== undefined && !['low', 'medium', 'high'].includes(fields.effort))) {
      throw new Error(`Invalid role override for ${id}: use ${OVERRIDABLE.join(', ')} with known values.`);
    }
  }
  // A role a project switches off gets no profile and no policy entry.
  return catalog.roles.filter((role) => role.id !== 'pm' && overrides[role.id]?.enabled !== false)
    .map((role) => ({ ...role, ...overrides[role.id] }));
}

// Cross-family review: work on hot paths (or all work) is reviewed by the other runtime's models.
const RUNTIMES = ['codex', 'claude'];
function reviewPolicy(config) {
  const review = config?.review ?? {};
  if (typeof review !== 'object' || Array.isArray(review) || Object.keys(review).some((key) => !['crossFamily', 'hotPaths'].includes(key))
      || (review.crossFamily !== undefined && !['hot-paths', 'always', 'off'].includes(review.crossFamily))
      || (review.hotPaths !== undefined && !(Array.isArray(review.hotPaths)
        && review.hotPaths.every((path) => typeof path === 'string' && path && path.length < 300)))) {
    throw new Error('Project review settings accept crossFamily (hot-paths, always or off) and hotPaths (a list of globs).');
  }
  return { crossFamily: review.crossFamily ?? 'hot-paths', hotPaths: review.hotPaths ?? [] };
}

// Parallel workers: how many may hold reservations and worktrees at once (the PM is not counted).
function parallelPolicy(config) {
  const parallel = config?.parallel ?? {};
  if (typeof parallel !== 'object' || Array.isArray(parallel) || Object.keys(parallel).some((key) => key !== 'maxWorkers')
      || (parallel.maxWorkers !== undefined && !(Number.isInteger(parallel.maxWorkers) && parallel.maxWorkers >= 1 && parallel.maxWorkers <= 16))) {
    throw new Error('Project parallel settings accept maxWorkers (1 to 16).');
  }
  return { maxWorkers: parallel.maxWorkers ?? 2 };
}

// Claude Code limits a subagent's tools in its profile; full-shell writers keep every tool and the guard scopes their writes.
function claudeTools(role) {
  if (role.access === 'scoped-writer' && role.shell === 'full') return undefined;
  const tools = ['Read', 'Grep', 'Glob', 'Bash', ...(role.access === 'scoped-writer' ? ['Edit', 'Write'] : [])];
  for (const extra of role.readTools ?? []) tools.push(...(extra === 'browser' ? BROWSER_TOOLS : [extra]));
  return tools;
}

// Each runtime renders a role as [file name, generated body, optional file prefix before the marker].
const runtimes = {
  codex: {
    directory: ['.codex', 'agents'],
    extension: '.toml',
    modelPattern: /^(model = )"([^"\n]*)"$/m,
    render(role, tiers) {
      const fields = { name: `toolkit-${role.id}`, description: role.description };
      if (role.tier) [fields.model, fields.model_reasoning_effort] = [tiers[role.tier], role.effort];
      fields.developer_instructions = instructions(role);
      const body = Object.entries(fields).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join('');
      return [`toolkit-${role.id}.toml`, body, ''];
    },
  },
  claude: {
    directory: ['.claude', 'agents'],
    extension: '.md',
    modelPattern: /^(model: *)"?([^"\n]*?)"?$/m,
    render(role, tiers) {
      const fields = { name: `toolkit-${role.id}`, description: role.description, model: role.tier ? tiers[role.tier] : 'inherit' };
      const header = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join('')
        + (claudeTools(role) ? `tools: ${claudeTools(role).join(', ')}\n` : '');
      return [`toolkit-${role.id}.md`, `${header}---\n\n${instructions(role)}\n`, '---\n'];
    },
  },
};

async function agentFiles(runtime) {
  const { directory: parts, extension, modelPattern } = runtimes[runtime];
  const directory = join(project, ...parts);
  if (!(await exists(directory))) return [];
  const files = [];
  for (const name of (await readdir(directory)).filter((entry) => entry.endsWith(extension)).sort()) {
    const file = join(directory, name);
    const raw = await readFile(file, 'utf8');
    const text = cleanLines(raw);
    const match = text.match(modelPattern);
    files.push({ file, text, crlf: raw.includes('\r\n'), model: match?.[2], generated: text.split('\n', 2).some((line) => line.startsWith(marker)) });
  }
  return files;
}

async function codexCatalog(path) {
  const file = path ? resolve(path) : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json');
  if (!(await exists(file))) return undefined;
  const data = await readJson(file);
  const models = Array.isArray(data) ? data : data.models;
  if (!Array.isArray(models)) throw new Error(`Unreadable Codex model catalog: ${file}`);
  return {
    file,
    fetchedAt: data.fetched_at,
    listed: models.filter((model) => model.visibility === 'list').map((model) => model.slug),
    known: models.map((model) => model.slug),
  };
}

// Claude Code aliases always resolve to the newest model in their family.
const claudeAliases = ['opus', 'sonnet', 'haiku', 'inherit', 'fable'];

async function modelsCheck(config, options) {
  const tiers = modelTiers(config);
  const codex = await codexCatalog(options['--codex-catalog']);
  const available = {
    codex: (model) => (codex ? codex.known.includes(model) : null),
    claude: (model) => (claudeAliases.includes(model) ? true : null),
  };
  const report = { attention: [] };
  for (const runtime of Object.keys(runtimes)) {
    const tierModels = Object.fromEntries(Object.entries(tiers[runtime]).map(([tier, model]) => [tier, { model, available: available[runtime](model) }]));
    const profiles = (await agentFiles(runtime)).map(({ file, model, generated }) => ({
      file: relative(project, file), model: model ?? null, generated, available: model ? available[runtime](model) : null,
    }));
    for (const [tier, { model, available: ok }] of Object.entries(tierModels)) {
      if (ok === false) report.attention.push(`${runtime} tier ${tier} uses ${model}, which the ${runtime} catalog does not offer`);
    }
    for (const profile of profiles) {
      if (profile.available === false) report.attention.push(`${profile.file} uses ${profile.model}, which the ${runtime} catalog does not offer`);
    }
    report[runtime] = { tiers: tierModels, profiles };
  }
  if (codex) {
    const used = new Set([...Object.values(tiers.codex), ...report.codex.profiles.map((profile) => profile.model)]);
    report.codex.catalog = { file: codex.file, fetchedAt: codex.fetchedAt, listed: codex.listed };
    const ageDays = codex.fetchedAt ? (Date.now() - Date.parse(codex.fetchedAt)) / 86400000 : Infinity;
    if (!(ageDays <= 7)) {
      report.attention.push(`The Codex model catalog is ${Number.isFinite(ageDays) ? `${Math.floor(ageDays)} days` : 'of unknown age'} old; start Codex to refresh it before deciding`);
    }
    const baselineFile = join(projectDir, 'model-catalog.json');
    const baseline = (await exists(baselineFile)) ? (await readJson(baselineFile)).codex : undefined;
    report.codex.baseline = baseline ? relative(project, baselineFile) : null;
    report.codex.candidates = codex.listed.filter((model) => !used.has(model) && !baseline?.includes(model));
    for (const model of report.codex.candidates) {
      report.attention.push(`codex offers ${model}, ${baseline ? 'new since the last review' : 'not yet reviewed'}; evaluate it`);
    }
    if (options['--record']) {
      await writeJson(baselineFile, { recordedAt: new Date().toISOString(), codex: codex.listed }, false);
      report.codex.recorded = relative(project, baselineFile);
    }
  } else {
    report.codex.catalog = null;
    report.attention.push('No Codex model catalog found; start Codex once to refresh it, or pass --codex-catalog <file>');
  }
  report.claude.note = 'Claude aliases track the newest model in each family. Compare across families by evaluation before moving a tier.';
  return report;
}

async function modelsRetarget(runtime, from, to, options) {
  if (!runtimes[runtime] || !from || !to || from === to) throw new Error('Usage: models retarget <codex|claude> <from-model> <to-model>');
  if (runtime === 'codex') {
    const codex = await codexCatalog(options['--codex-catalog']);
    if (codex && !codex.known.includes(to)) throw new Error(`The Codex catalog does not offer ${to}.`);
  }
  const changed = [];
  for (const { file, text, crlf, model, generated } of await agentFiles(runtime)) {
    if (generated || model !== from) continue;
    const updated = text.replace(runtimes[runtime].modelPattern, (_, key) => `${key}"${to}"`);
    await writeFile(file, crlf ? updated.replaceAll('\n', '\r\n') : updated);
    changed.push(relative(project, file));
  }
  return { runtime, from, to, changed, note: 'Toolkit-generated profiles follow tiers: update project models settings, then rerun sync.' };
}

// True when the file is toolkit output nobody has edited since: its marker hash still matches its body.
function untouched(current, prefix) {
  const rest = current.startsWith(prefix) ? current.slice(prefix.length) : '';
  const delimiter = rest.indexOf('\n');
  return delimiter >= 0 && rest.slice(0, delimiter) === marker + hash(rest.slice(delimiter + 1));
}

async function syncAgents(runtime, config, { dryRun = false } = {}) {
  const { directory: parts, extension, render } = runtimes[runtime];
  const tiers = modelTiers(config)[runtime];
  const directory = join(project, ...parts);
  const roles = effectiveRoles(config).map((role) => render(role, tiers));
  const prefix = roles[0][2];
  const writes = [];
  for (const [name, body] of roles) {
    const file = join(directory, name);
    const contents = `${prefix}${marker}${hash(body)}\n${body}`;
    const present = await exists(file);
    if (present) {
      const current = cleanLines(await readFile(file, 'utf8'));
      if (current === contents) continue;
      if (!untouched(current, prefix)) throw new Error(`Custom agent file conflicts with toolkit setup: ${file}`);
    }
    writes.push({ file, contents, present });
  }
  // Unedited toolkit profiles for roles the catalog no longer has are removed; edited ones stay.
  const expected = new Set(roles.map(([name]) => name));
  const removed = [];
  for (const name of (await exists(directory)) ? await readdir(directory) : []) {
    if (!name.startsWith('toolkit-') || !name.endsWith(extension) || expected.has(name)) continue;
    if (!untouched(cleanLines(await readFile(join(directory, name), 'utf8')), prefix)) continue;
    if (!dryRun) await rm(join(directory, name));
    removed.push(name);
  }
  if (dryRun) return { stale: writes.map(({ file }) => relative(project, file)), removed };
  await mkdir(directory, { recursive: true });
  for (const { file, contents, present } of writes) {
    await writeFile(file, contents, { flag: present ? 'w' : 'wx' });
  }
  const policy = await writeRolePolicy(config);
  if (runtime === 'codex' && await exists(join(projectDir, 'role-guard.mjs'))) await installGuardCopy();
  return { revision: catalog.revision, roles: roles.length, updated: writes.length, removed, directory, policy };
}

// The guard reads one policy per clone from Git's common directory, so every linked worktree enforces the same rules.
async function writeRolePolicy(config) {
  let common;
  try {
    common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // not a Git checkout: no guard policy
  }
  const file = join(common, 'development-team-role-policy.json');
  await writeJson(file, rolePolicy(config), false);
  return file;
}

function rolePolicy(config) {
  const roles = {};
  for (const role of effectiveRoles(config)) {
    roles[`toolkit-${role.id}`] = { access: role.access, shell: role.shell, writeScope: role.writeScope ?? [], readTools: role.readTools ?? [] };
  }
  return { schemaVersion: 1, revision: catalog.revision, linkedWorktreeOnly: config?.rolePolicy?.linkedWorktreeOnly === true, roles };
}

// Checks a project's whole setup and says how to fix each problem. Read-only.
async function doctor() {
  const checks = [];
  const add = (check, ok, detail, fix) => checks.push({ check, ok, detail, ...(ok ? {} : { fix }) });
  const [major, minor] = process.versions.node.split('.').map(Number);
  add('Node.js 22.13 or later', major > 22 || (major === 22 && minor >= 13), process.version, 'Install a current Node.js LTS.');
  let common;
  try {
    common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    add('Git checkout', true, common);
  } catch {
    add('Git checkout', false, 'not a Git repository', 'Run the toolkit from the project checkout.');
  }
  let config;
  try {
    const store = await settingsStore();
    if (!(await exists(store.file))) {
      add('Project settings', false, `not initialized (${store.kind})`, 'Run the setup skill, or init <seed.json>.');
    } else {
      config = validateProject(await readJson(store.file));
      modelTiers(config); effectiveRoles(config); reviewPolicy(config); parallelPolicy(config);
      add('Project settings', true, `${store.kind}: ${relative(project, store.file)}`);
    }
  } catch (error) {
    add('Project settings', false, error.message, 'Fix the settings file, or rerun the setup skill.');
  }
  for (const runtime of ['claude', 'codex']) {
    const name = runtime === 'claude' ? 'Claude Code profiles' : 'Codex profiles';
    if (!(await exists(join(project, ...runtimes[runtime].directory)))) {
      add(name, false, 'not generated', `Run sync-${runtime}.`);
      continue;
    }
    try {
      const { stale, removed } = await syncAgents(runtime, config, { dryRun: true });
      add(name, !stale.length && !removed.length, stale.length || removed.length ? `${stale.length} missing or out of date, ${removed.length} retired` : 'in sync', `Run sync-${runtime}.`);
    } catch (error) {
      add(name, false, error.message, 'Move the edited profile aside or into project role overrides, then sync again.');
    }
  }
  if (common) {
    const file = join(common, 'development-team-role-policy.json');
    let current = null;
    try { current = await readJson(file); } catch { /* missing */ }
    let wanted = null;
    try { wanted = rolePolicy(config); } catch { /* settings already reported */ }
    add('Role policy', Boolean(current) && JSON.stringify(current) === JSON.stringify(wanted),
      current ? (JSON.stringify(current) === JSON.stringify(wanted) ? 'current' : 'out of date') : 'missing', 'Run sync-claude or sync-codex.');
  }
  add('Claude Code guard hook', true, `ships with the plugin (${catalog.revision}); active wherever the plugin is enabled`);
  const hooksFile = join(project, '.codex', 'hooks.json');
  const guardCopy = join(projectDir, 'role-guard.mjs');
  const command = `node "${guardCopy.split(sep).join('/')}"`;
  let entryIndex = -1;
  try {
    entryIndex = ((await readJson(hooksFile)).hooks?.PreToolUse ?? []).findIndex((entry) => entry?.hooks?.some((hook) => hook?.command === command));
  } catch { /* missing */ }
  add('Codex guard hook installed', entryIndex >= 0, entryIndex >= 0 ? relative(project, hooksFile) : 'not in .codex/hooks.json', 'Run install-codex-hooks.');
  if (entryIndex >= 0) {
    const same = (await exists(guardCopy)) && (await readFile(guardCopy, 'utf8')) === (await readFile(fileURLToPath(new URL('./role-guard.mjs', import.meta.url)), 'utf8'));
    add('Codex guard copy current', same, same ? relative(project, guardCopy) : 'older than this toolkit', 'Run sync-codex or install-codex-hooks.');
    const codexConfig = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
    const text = (await exists(codexConfig)) ? await readFile(codexConfig, 'utf8') : '';
    const wantedKey = `${resolve(hooksFile)}:pre_tool_use:${entryIndex}:`.toLowerCase();
    const trusted = [...text.matchAll(/^\[hooks\.state\.(?:'([^']+)'|"((?:[^"\\]|\\.)+)")\]\s*\ntrusted_hash/gm)]
      .map((match) => (match[1] ?? match[2].replace(/\\\\/g, '\\')).toLowerCase())
      .some((key) => key.startsWith(wantedKey));
    add('Codex guard hook trusted', trusted, trusted ? 'trust record found' : 'no trust record',
      'Open Codex in this project, run /hooks and trust "Checking toolkit role access". If Codex still says the hook needs review, trust it again.');
  }
  const otherStore = await exists(join(project, '.coordinator', 'state.sqlite3'));
  add('No other Coordinator store', !otherStore, otherStore ? '.coordinator/state.sqlite3 exists, so the toolkit Coordinator refuses claims' : 'none found',
    'Keep using that Coordinator, or retire its store deliberately.');
  const ok = checks.every((item) => item.ok);
  if (!ok) process.exitCode = 1;
  return { ok, checks };
}

// Codex plugins cannot ship hooks, so the project hook points at a stable copy of the guard that sync keeps current.
async function installGuardCopy() {
  await mkdir(projectDir, { recursive: true });
  const target = join(projectDir, 'role-guard.mjs');
  await copyFile(fileURLToPath(new URL('./role-guard.mjs', import.meta.url)), target);
  return target;
}

async function installCodexHooks(config) {
  const guard = await installGuardCopy();
  const policy = await writeRolePolicy(config);
  const file = join(project, '.codex', 'hooks.json');
  const current = (await exists(file)) ? await readJson(file) : { hooks: {} };
  if (!current || typeof current !== 'object' || (current.hooks !== undefined && (typeof current.hooks !== 'object' || Array.isArray(current.hooks)))) {
    throw new Error(`Unreadable Codex hooks file: ${file}`);
  }
  const command = `node "${guard.split(sep).join('/')}"`;
  const pre = ((current.hooks ??= {}).PreToolUse ??= []);
  const installed = pre.some((entry) => entry?.hooks?.some((hook) => hook?.command === command));
  if (!installed) {
    pre.push({ matcher: '.*', hooks: [{ type: 'command', command, timeout: 10, statusMessage: 'Checking toolkit role access' }] });
    await writeJson(file, current, false);
  }
  return { file, guard, policy, changed: !installed,
    next: installed ? 'Already installed.' : 'Open Codex in this project, run /hooks and trust "Checking toolkit role access". Codex skips untrusted hooks.' };
}

// Checks a handoff written from toolkit-wiki/handoff-template.md: required sections, a real base commit, owned files, checks.
async function handoffCheck(file, config) {
  const text = cleanLines(await readFile(resolve(file), 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
  const sections = {};
  for (const [, heading, body] of text.matchAll(/^## +(.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)) {
    sections[heading.trim().toLowerCase()] = body.trim();
  }
  const bullets = (body) => (body ?? '').split('\n').map((line) => line.match(/^\s*[-*] +(.*\S)/)?.[1]).filter(Boolean);
  const problems = [];
  for (const name of ['decision', 'base revision', 'owned files', 'acceptance checks', 'next owner']) {
    if (!sections[name] || (['owned files', 'acceptance checks'].includes(name) && !bullets(sections[name]).length)) {
      problems.push(`Fill the "${name}" section.`);
    }
  }
  const base = sections['base revision']?.split(/\s/, 1)[0].replaceAll('`', '');
  if (base && !/^[0-9a-f]{7,40}$/i.test(base)) problems.push(`Base revision "${base}" is not a commit hash.`);
  else if (base) {
    try {
      execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: project, stdio: 'ignore' });
    } catch {
      problems.push(`Base revision ${base} is not a commit in this repository.`);
    }
  }
  for (const path of bullets(sections['owned files']).map((item) => item.replaceAll('`', ''))) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) problems.push(`Owned file "${path}" must be a repo-relative path.`);
  }
  const warnings = [];
  const review = reviewPolicy(config);
  const owned = bullets(sections['owned files']).map((item) => item.replaceAll('`', '').replaceAll('\\', '/'));
  const hot = review.hotPaths.map(globRegex);
  const hotFiles = review.crossFamily === 'always' ? owned : review.crossFamily === 'off' ? [] : owned.filter((path) => hot.some((re) => re.test(path)));
  if (hotFiles.length) {
    const runtime = Object.fromEntries(bullets(sections.runtime).map((line) => line.split(/:\s*/, 2).map((part) => part.trim().toLowerCase())));
    const pending = /cross-family review pending/i.test(sections.runtime ?? '');
    const scope = review.crossFamily === 'always' ? 'this project' : `hot paths (${hotFiles.join(', ')})`;
    if (!RUNTIMES.includes(runtime.built)) problems.push(`Cross-family review applies to ${scope}: name the builder in the "runtime" section (built: codex or claude).`);
    else if (!RUNTIMES.includes(runtime.reviewed) || runtime.reviewed === runtime.built) {
      if (pending) warnings.push('Cross-family review is pending: settle it, or get the owner to accept the degraded review, before release.');
      else problems.push(`Cross-family review applies to ${scope}: the reviewer must use the other runtime than ${runtime.built} (reviewed: ${runtime.built === 'codex' ? 'claude' : 'codex'}), or mark "cross-family review pending" when it is unavailable.`);
    }
  }
  // Gates: hot-path work starts from Test Engineer tests; a release needs a Release Reviewer go.
  const gates = Object.fromEntries(bullets(sections.gates).map((line) => line.split(/:\s*/, 2).map((part) => part.trim())).map(([k, v]) => [k.toLowerCase(), v ?? '']));
  const hotByPath = owned.filter((path) => hot.some((re) => re.test(path)));
  const toTestEngineer = /test[- ]engineer/i.test(sections['next owner'] ?? '');
  if (hotByPath.length && !toTestEngineer && !gates['tests first']) {
    problems.push(`Hot-path work (${hotByPath.join(', ')}) starts from Test Engineer tests: add "tests first: <evidence>" under Gates.`);
  }
  if (/^yes$/i.test(gates.release ?? '') && !/^go(\s|$)/i.test(gates['release reviewer'] ?? '')) {
    problems.push('This handoff is a release: add "release reviewer: go <evidence>" under Gates from the Release Reviewer.');
  }
  if (problems.length) process.exitCode = 1;
  return { file, ok: !problems.length, problems, warnings };
}

async function main([command, ...args]) {
  if (command === 'handoff') {
    if (args[0] !== 'check' || args.length !== 2) throw new Error('Usage: handoff check <handoff.md>');
    const store = await settingsStore();
    return handoffCheck(args[1], (await exists(store.file)) ? validateProject(await readJson(store.file)) : undefined);
  }
  if (command === 'doctor' && !args.length) return doctor();
  if (command === 'update-installs') {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = { '--ref': 'ref', '--marketplace': 'marketplace', '--plugin': 'plugin' }[args[i]];
      if (!key || args[i + 1] === undefined) throw new Error('Usage: update-installs [--ref <sha>] [--marketplace <name>] [--plugin <name>]');
      options[key] = args[i + 1];
    }
    const result = (await import('./update-installs.mjs')).updateInstalls(options);
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  if (command === 'setup' && args[0] === 'scan' && args.length === 1) return (await import('./setup-scan.mjs')).setupScan(project, catalog);
  if (command === 'eval') {
    const all = [...args];
    const at = all.indexOf('--evals-dir'); // accepted before or after the action
    const evalsDirOption = at >= 0 ? all.splice(at, 2)[1] : undefined;
    if (at >= 0 && !evalsDirOption) throw new Error('--evals-dir needs a value.');
    const [action, ...rest] = all;
    const evals = await import('./evals.mjs');
    const store = await settingsStore();
    const config = (await exists(store.file)) ? validateProject(await readJson(store.file)) : undefined;
    // --evals-dir keeps tasks in another repository (for example a project wiki) while the code they replay lives here.
    const dir = evalsDirOption ? resolve(evalsDirOption) : evals.evalsDir(project, config);
    const positional = [];
    const options = {};
    const lists = { '--check': 'checks', '--keyword': 'keywords' };
    const single = { '--accepted': 'accepted', '--role': 'role', '--kind': 'kind', '--split': 'split', '--id': 'id',
      '--patch': 'patchFile', '--file': 'file', '--task': 'task', '--result': 'result', '--defects': 'defects', '--version': 'version' };
    while (rest.length) {
      const item = rest.shift();
      if (lists[item] || single[item]) {
        if (!rest.length) throw new Error(`${item} needs a value.`);
        const value = rest.shift();
        if (lists[item]) (options[lists[item]] ??= []).push(value);
        else options[single[item]] = single[item] === 'defects' ? Number(value) : value;
      } else positional.push(item);
    }
    if (action === 'harvest' && positional.length === 1) return evals.harvest(project, dir, resolve(positional[0]), options);
    if (action === 'seed' && positional.length === 1) {
      return evals.seed(project, dir, positional[0], { ...options, patchFile: options.patchFile && resolve(options.patchFile) });
    }
    if (action === 'run' && positional.length === 1) return evals.evalRun(project, dir, resolve(positional[0]), options);
    if (action === 'outcome' && positional.length === 1) return evals.outcome(project, dir, resolve(positional[0]), options);
    if (action === 'report' && !positional.length) return evals.report(dir, options);
    if (action === 'checks' && !positional.length) return evals.evalChecks(project, dir, options);
    if (action === 'check-report' && !positional.length) {
      const protectedChecks = config?.evals?.protectedChecks ?? [];
      if (!Array.isArray(protectedChecks) || protectedChecks.some((item) => typeof item !== 'string' || !item)) {
        throw new Error('evals.protectedChecks must be a list of command fragments, such as "gates.py".');
      }
      return evals.checkReport(dir, { protectedChecks });
    }
    throw new Error('Usage: eval [--evals-dir <dir>] harvest <handoff.md> --accepted <commit> --role <id> [--kind golden|regression] [--check "<cmd>"]... | '
      + 'eval seed <task-id> --patch <file> --file <path> --keyword <word>... [--role <id>] | eval run <contenders.json> [--role <id>] [--task <id>] [--split train|holdout|all] | '
      + 'eval outcome <handoff.md> --role <id> --result accepted|rework|rejected [--defects <n>] [--version <label>] | eval report [--role <id>] | '
      + 'eval checks [--role <id>] [--task <id>] | eval check-report');
  }
  if (command === 'worker') {
    const [action, name, ...rest] = args;
    const workers = await import('./workers.mjs');
    if (action === 'status' && name === undefined) return workers.workerStatus(project);
    if (action === 'finish' && name && !rest.length) return workers.workerFinish(project, name);
    if (action === 'start' && name) {
      const files = [];
      const options = { resources: [] };
      while (rest.length) {
        const item = rest.shift();
        if (item === '--resource' || item === '--base') {
          if (!rest.length) throw new Error(`${item} needs a value.`);
          if (item === '--resource') options.resources.push(rest.shift());
          else options.base = rest.shift();
        } else files.push(item);
      }
      const store = await settingsStore();
      const config = (await exists(store.file)) ? validateProject(await readJson(store.file)) : undefined;
      return workers.workerStart(project, name, files, { ...options, maxWorkers: parallelPolicy(config).maxWorkers });
    }
    throw new Error('Usage: worker start <name> <file-or-dir>... [--resource resource:<name>]... [--base <ref>] | worker status | worker finish <name>');
  }
  if (command === 'coordinate') {
    if (args[0] === 'mcp') {
      throw new Error('The Coordinator MCP server ships with the plugin in Codex and Claude Code; no setup is needed.');
    }
    const { coordinate } = await import('./coordinator.mjs');
    return coordinate(args, {
      loadPolicy: async () => {
        const [primary] = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
          cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        }).split('\0', 1);
        if (!primary.startsWith('worktree ') || await realpath(primary.slice(9)) !== await realpath(project)) {
          throw new Error('Sync Coordinator policy from the primary project root.');
        }
        const store = await settingsStore();
        if (!(await exists(store.file))) throw new Error('Initialize project settings before syncing Coordinator policy.');
        const config = validateProject(await readJson(store.file));
        if (config.coordinator !== undefined && (config.coordinator === null || typeof config.coordinator !== 'object'
          || Array.isArray(config.coordinator) || Object.keys(config.coordinator).some((key) => key !== 'fixtures'))) {
          throw new Error('Coordinator settings accept a fixtures map.');
        }
        return { fixtures: config.coordinator?.fixtures === undefined ? {} : config.coordinator.fixtures };
      },
    });
  }
  if (command === 'models') {
    const [action, ...rest] = args;
    const options = {};
    const positional = [];
    while (rest.length) {
      const item = rest.shift();
      if (item === '--record') options[item] = true;
      else if (item === '--codex-catalog') {
        if (!rest.length) throw new Error('--codex-catalog needs a file.');
        options[item] = rest.shift();
      } else positional.push(item);
    }
    const store = await settingsStore();
    const config = (await exists(store.file)) ? validateProject(await readJson(store.file)) : undefined;
    if (action === 'check' && !positional.length) return modelsCheck(config, options);
    if (action === 'retarget' && positional.length === 3) return modelsRetarget(...positional, options);
    if (action === 'eval' && positional.length === 1) return (await import('./eval.mjs')).modelsEval(project, resolve(positional[0]));
    throw new Error('Usage: models check [--record] | models retarget <codex|claude> <from-model> <to-model> [--codex-catalog <file>] | models eval <spec.json>');
  }
  const [input, wikiFlag, wikiPath, ...extra] = args;
  if (command === 'roles' && input === undefined) return catalog;
  if (!['init', 'save', 'status', 'config', 'sync-codex', 'sync-claude', 'install-codex-hooks'].includes(command)) {
    throw new Error('Usage: toolkit.mjs roles | status | config | init <seed.json> [--wiki <path>] | save <settings.json> | sync-codex | sync-claude | install-codex-hooks | doctor | setup scan | update-installs | eval <harvest|seed|run|outcome|report> | worker <start|status|finish> | models <check|retarget|eval> | handoff check <file> | coordinate <command>');
  }
  if (['init', 'save'].includes(command) ? !input : input !== undefined) throw new Error('Invalid project settings arguments.');
  if (wikiFlag !== undefined && (command !== 'init' || wikiFlag !== '--wiki' || !wikiPath || extra.length)) {
    throw new Error('Use --wiki <path> with init only.');
  }
  const store = await settingsStore(wikiPath);
  const initialized = await exists(store.file);
  if (command === 'init') {
    if (initialized) throw new Error('Project settings already exist. Use save to update them.');
    const config = validateProject(await readJson(resolve(input)));
    if (store.kind === 'wiki' && !store.pinned) {
      await writeJson(wikiLocator, { path: relative(project, store.wiki) }, true);
    }
    await writeJson(store.file, config, true);
    return { store: store.kind, file: store.file, initialized: true };
  }
  if (command === 'status') return { store: store.kind, file: store.file, initialized, roleRevision: catalog.revision };
  if (!initialized) throw new Error('Project settings are uninitialized. Run init <seed.json> first.');
  const config = validateProject(await readJson(store.file));
  if (command === 'config') return config;
  if (command === 'sync-codex') return syncAgents('codex', config);
  if (command === 'sync-claude') return syncAgents('claude', config);
  if (command === 'install-codex-hooks') return installCodexHooks(config);
  const updated = validateProject(await readJson(resolve(input)));
  if (updated.id !== config.id) throw new Error('Use the existing project id when updating project settings.');
  modelTiers(updated);
  effectiveRoles(updated);
  reviewPolicy(updated);
  parallelPolicy(updated);
  (await import('./evals.mjs')).evalsDir(project, updated);
  await writeJson(store.file, updated, false);
  return { store: store.kind, file: store.file, initialized: true };
}

try {
  const result = await main(process.argv.slice(2));
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
