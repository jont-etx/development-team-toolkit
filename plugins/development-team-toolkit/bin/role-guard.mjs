// PreToolUse guard: each toolkit specialist may act only inside its role's access rules.
// Claude Code and Codex send the subagent's role as `agent_type`; the parent session has none and is
// never blocked. Rules come from the project's role policy, written by sync-claude / sync-codex into
// Git's common directory (development-team-role-policy.json), so every linked worktree shares them.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POLICY_FILE = 'development-team-role-policy.json';
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'webfetch', 'websearch', 'web_search', 'view_image', 'ls', 'todowrite',
  'update_plan']);
// Every role may queue for shared resources through the toolkit Coordinator.
const READ_PREFIXES = ['mcp__plugin_development-team-toolkit_coordinator__', 'mcp__coordinator__', 'coordinator_call'];
const TOOL_GROUPS = { browser: ['mcp__claude_browser__', 'mcp__claude-in-chrome__', 'browser_'] };
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch']);
const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'exec_command', 'local_shell']);
const READ_COMMANDS = new Set(['rg', 'grep', 'cat', 'head', 'tail', 'ls', 'dir', 'type', 'wc', 'echo', 'pwd', 'tree', 'diff',
  'file', 'stat', 'get-content', 'get-childitem', 'select-string', 'get-item', 'test-path', 'resolve-path', 'measure-object',
  'select-object', 'where-object', 'sort-object', 'format-table', 'format-list', 'out-string', 'convertfrom-json',
  'get-filehash', 'get-date', 'gc', 'gci', 'sls', 'cd', 'set-location']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'cat-file',
  'describe', 'shortlog', 'merge-base', 'name-rev', 'for-each-ref', 'worktree', 'branch', 'tag', 'remote']);
const GIT_SUB_WRITES = new Set(['worktree add', 'worktree remove', 'worktree prune', 'worktree move', 'branch -d', 'branch -D',
  'branch -m', 'branch -M', 'tag -d', 'remote add', 'remote remove', 'remote set-url']);
const TEST_RUNNERS = [['python', '-m', 'unittest'], ['python', '-m', 'pytest'], ['pytest'], ['node', '--test'],
  ['npm', 'test'], ['npx', 'vitest', 'run'], ['go', 'test'], ['cargo', 'test']];
const FORBIDDEN = /(>|`|\$\(|\b(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|clear-content|invoke-expression|iex|start-process|tee|tee-object)\b|\bsed\s+-i)/i;

export const norm = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function words(segment) {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, ''));
}

/** True when every segment of the command only reads (and, when allowed, runs unit tests). */
export function shellOk(command, tests = true) {
  if (Array.isArray(command)) command = command.join(' ');
  if (typeof command !== 'string' || !command.trim() || FORBIDDEN.test(command)) return false;
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    let argv = words(segment.trim());
    if (!argv.length) continue;
    let program = norm(argv[0].split(/[\\/]/).pop().replace(/\.exe$/i, ''));
    if (program === 'rtk') {
      argv = argv.slice(1);
      program = norm(argv[0]);
    }
    if (READ_COMMANDS.has(program)) {
      if (argv.some((word) => ['-delete', '-exec', '-execdir'].includes(word))) return false;
      continue;
    }
    if (program === 'git' && argv.length > 1) {
      const sub = [];
      for (let i = 1; i < argv.length; i += 1) {
        if (argv[i] === '-C') i += 1; // skip the path after -C
        else if (argv[i] !== '--no-pager' && !argv[i].startsWith('-C')) sub.push(argv[i]);
      }
      if (sub.length && GIT_READ.has(sub[0]) && !sub.slice(1).some((word) => GIT_SUB_WRITES.has(`${sub[0]} ${word}`))) continue;
      return false;
    }
    const lowered = argv.map((word) => word.replaceAll('\\', '/').toLowerCase());
    if (tests && TEST_RUNNERS.some((runner) => runner.every((part, i) => lowered[i] === part))) {
      if (lowered.includes('-c') || lowered.includes('-e')) return false;
      continue;
    }
    return false;
  }
  return true;
}

export function globRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length;) {
    if (pattern.startsWith('**/', i)) { out += '(?:.*/)?'; i += 3; }
    else if (pattern.startsWith('**', i)) { out += '.*'; i += 2; }
    else if (pattern[i] === '*') { out += '[^/]*'; i += 1; }
    else { out += pattern[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&'); i += 1; }
  }
  return new RegExp(`^${out}$`, 'i');
}

/** The Git worktree that contains a path (it may not exist yet): its root and whether it is a linked worktree. */
export function worktreeOf(path) {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const git = join(dir, '.git');
    if (existsSync(git)) return { root: dir, linked: lstatSync(git).isFile() };
    if (dirname(dir) === dir) return null;
  }
}

/** Every file a write tool would touch, absolute. */
export function targets(toolInput, cwd) {
  const found = [];
  if (toolInput && typeof toolInput === 'object') {
    for (const key of ['file_path', 'notebook_path', 'path']) if (typeof toolInput[key] === 'string') found.push(toolInput[key]);
  }
  // Codex apply_patch sends {"command": "*** Begin Patch\n*** Add File: <path>\n..."}.
  const patch = typeof toolInput === 'string' ? toolInput
    : Object.values(toolInput ?? {}).filter((value) => typeof value === 'string').join('\n');
  for (const match of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) found.push(match[1].trim());
  return found.map((file) => resolve(cwd ?? process.cwd(), file));
}

export function decide(event, policy) {
  const roles = policy?.roles ?? {};
  const rules = roles[norm(event?.agent_type)];
  if (!rules) return null;
  const role = norm(event.agent_type);
  const tool = String(event.tool_name ?? '').toLowerCase();
  const input = event.tool_input ?? {};
  const who = `${role} (${rules.access})`;
  const prefixes = [...READ_PREFIXES, ...(rules.readTools ?? []).flatMap((name) => TOOL_GROUPS[name] ?? [String(name).toLowerCase()])];
  if (READ_TOOLS.has(tool) || prefixes.some((prefix) => tool.startsWith(prefix))) return null;
  if (SHELL_TOOLS.has(tool)) {
    const command = typeof input === 'object' ? input.command : input;
    if (rules.shell === 'full' || shellOk(command, rules.shell === 'read-only+unit-tests')) return null;
    return `${who}: this shell command can change state, and this role's shell is ${rules.shell}. Use read-only commands and report or hand off the change instead.`;
  }
  if (WRITE_TOOLS.has(tool)) {
    if (rules.access !== 'scoped-writer') return `${who}: read-only role; ${tool} is not allowed. Report findings instead.`;
    const files = targets(input, event.cwd);
    if (!files.length) return `${who}: could not tell which file ${tool} would change.`;
    const scope = (rules.writeScope ?? []).map(globRegex);
    for (const file of files) {
      const tree = worktreeOf(file);
      if (!tree) return `${who}: ${file} is not inside a Git worktree.`;
      if (policy.linkedWorktreeOnly && !tree.linked) {
        return `${who}: ${file} is in the primary checkout; this project writes only in linked worktrees.`;
      }
      const path = relative(tree.root, file).split(sep).join('/');
      if (!scope.some((pattern) => pattern.test(path))) {
        return `${who}: ${path} is outside this role's write scope (${(rules.writeScope ?? []).join(', ') || 'none'}). Hand the change to its owner instead.`;
      }
    }
    return null;
  }
  if (rules.shell === 'full') return null; // full writers keep their other tools; only file writes are scoped
  return `${who}: ${tool || 'this tool'} is not allowed for this role. Report findings instead.`;
}

export function loadPolicy(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
    return JSON.parse(readFileSync(join(common, POLICY_FILE), 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let event;
  try {
    event = JSON.parse(raw || '{}');
  } catch {
    return; // not ours to judge
  }
  const cwd = event.cwd && isAbsolute(event.cwd) ? event.cwd : process.cwd();
  const reason = decide(event, loadPolicy(cwd));
  if (reason) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: reason } }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
