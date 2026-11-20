import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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

// Each runtime renders a role as [file name, generated body, optional file prefix before the marker].
const runtimes = {
  codex: {
    directory: ['.codex', 'agents'],
    render(role) {
      const fields = { name: `toolkit-${role.id}`, description: role.description };
      const mapping = catalog.codexModels[role.id];
      if (mapping) [fields.model, fields.model_reasoning_effort] = mapping;
      fields.developer_instructions = instructions(role);
      const body = Object.entries(fields).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join('');
      return [`toolkit-${role.id}.toml`, body, ''];
    },
  },
  claude: {
    directory: ['.claude', 'agents'],
    render(role) {
      const fields = { name: `toolkit-${role.id}`, description: role.description, model: catalog.claudeModels?.[role.id] ?? 'inherit' };
      const header = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join('');
      return [`toolkit-${role.id}.md`, `${header}---\n\n${instructions(role)}\n`, '---\n'];
    },
  },
};

async function syncAgents(runtime) {
  const { directory: parts, render } = runtimes[runtime];
  const directory = join(project, ...parts);
  const writes = [];
  for (const role of catalog.roles) {
    if (role.id === 'pm') continue;
    const [name, body, prefix] = render(role);
    const file = join(directory, name);
    const marker = '# Development Team Toolkit generated content SHA256 ';
    const contents = `${prefix}${marker}${hash(body)}\n${body}`;
    const present = await exists(file);
    if (present) {
      const current = cleanLines(await readFile(file, 'utf8'));
      if (current === contents) continue;
      const rest = current.startsWith(prefix) ? current.slice(prefix.length) : '';
      const delimiter = rest.indexOf('\n');
      if (delimiter < 0 || rest.slice(0, delimiter) !== marker + hash(rest.slice(delimiter + 1))) {
        throw new Error(`Custom agent file conflicts with toolkit setup: ${file}`);
      }
    }
    writes.push({ file, contents, present });
  }
  await mkdir(directory, { recursive: true });
  for (const { file, contents, present } of writes) {
    await writeFile(file, contents, { flag: present ? 'w' : 'wx' });
  }
  return { revision: catalog.revision, roles: catalog.roles.length - 1, updated: writes.length, directory };
}

async function main([command, ...args]) {
  if (command === 'coordinate') {
    if (args[0] === 'mcp') {
      const [action, ...flags] = args.slice(1);
      const options = {};
      while (flags.length) {
        const [flag, value] = flags.splice(0, 2);
        if (!['--python', '--runtime'].includes(flag) || !value || options[flag] !== undefined
            || (flag === '--runtime' && !['codex', 'claude'].includes(value))) {
          throw new Error('Usage: coordinate mcp <status|install> [--python <executable>] [--runtime codex|claude]');
        }
        options[flag] = value;
      }
      const script = fileURLToPath(new URL('./coordinator-mcp-setup.py', import.meta.url));
      const runtime = options['--runtime'] ? ['--runtime', options['--runtime']] : [];
      process.exitCode = await new Promise((resolveExit, reject) => {
        const child = spawn(options['--python'] ?? 'python', ['-I', '-B', script, action ?? 'status', '--node', process.execPath, ...runtime], { stdio: 'inherit' });
        child.once('error', () => reject(new Error('Python is required for this optional Coordinator command.')));
        child.once('exit', (code) => resolveExit(code ?? 1));
      });
      return;
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
  const [input, wikiFlag, wikiPath, ...extra] = args;
  if (command === 'roles' && input === undefined) return catalog;
  if (!['init', 'save', 'status', 'config', 'sync-codex', 'sync-claude'].includes(command)) {
    throw new Error('Usage: toolkit.mjs roles | status | config | init <seed.json> [--wiki <path>] | save <settings.json> | sync-codex | sync-claude | coordinate <command>');
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
  if (command === 'sync-codex') return syncAgents('codex');
  if (command === 'sync-claude') return syncAgents('claude');
  const updated = validateProject(await readJson(resolve(input)));
  if (updated.id !== config.id) throw new Error('Use the existing project id when updating project settings.');
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
