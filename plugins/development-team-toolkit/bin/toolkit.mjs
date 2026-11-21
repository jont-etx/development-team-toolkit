import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      const header = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join('');
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

async function syncAgents(runtime, config) {
  const { directory: parts, extension, render } = runtimes[runtime];
  const tiers = modelTiers(config)[runtime];
  const directory = join(project, ...parts);
  const roles = catalog.roles.filter((role) => role.id !== 'pm').map((role) => render(role, tiers));
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
    await rm(join(directory, name));
    removed.push(name);
  }
  await mkdir(directory, { recursive: true });
  for (const { file, contents, present } of writes) {
    await writeFile(file, contents, { flag: present ? 'w' : 'wx' });
  }
  return { revision: catalog.revision, roles: roles.length, updated: writes.length, removed, directory };
}

// Checks a handoff written from toolkit-wiki/handoff-template.md: required sections, a real base commit, owned files, checks.
async function handoffCheck(file) {
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
  if (problems.length) process.exitCode = 1;
  return { file, ok: !problems.length, problems };
}

async function main([command, ...args]) {
  if (command === 'handoff') {
    if (args[0] !== 'check' || args.length !== 2) throw new Error('Usage: handoff check <handoff.md>');
    return handoffCheck(args[1]);
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
  if (!['init', 'save', 'status', 'config', 'sync-codex', 'sync-claude'].includes(command)) {
    throw new Error('Usage: toolkit.mjs roles | status | config | init <seed.json> [--wiki <path>] | save <settings.json> | sync-codex | sync-claude | models <check|retarget|eval> | handoff check <file> | coordinate <command>');
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
  const updated = validateProject(await readJson(resolve(input)));
  if (updated.id !== config.id) throw new Error('Use the existing project id when updating project settings.');
  modelTiers(updated);
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
