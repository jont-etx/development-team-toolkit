// Usage scan: where agent time goes, read-only from local Codex and Claude Code transcripts. It answers whether the
// hub spends its time on real work (tests, gates) or on waiting: agent waits by spawned role and by thread, waits that
// timed out, waits with no live child, polling loops, background-cell waits, and the model's gap after test calls.
// Nothing is written and nothing leaves the machine; only totals are reported.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const DEFAULT_TESTS = String.raw`\b(pytest|unittest|jest|vitest|mocha|playwright|cypress|go test|cargo test|dotnet test|mvn (test|verify)|gradle(w)? (test|check)|rspec|phpunit|tox|nox)\b|\b(npm|pnpm|yarn|bun)( run)? test\b|node --test|\b(make|just) (test|check)\b|\bgates?\b`;
const SHELL_TOOLS = new Set(['exec', 'exec_command', 'shell', 'local_shell', 'bash', 'Bash', 'PowerShell', 'run_terminal_cmd']);
const GAP_LIMIT_S = 1800; // a longer gap is the user away, not the model thinking

const time = (value) => Date.parse(value);
const hours = (seconds) => Math.round((seconds / 3600) * 100) / 100;
const rate = (part, whole) => (whole ? Math.round((part / whole) * 100) / 100 : null);
const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? ''));
const add = (map, key, seconds) => { map[key] = (map[key] ?? 0) + seconds; };
const tidy = (map) => Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]).map(([key, seconds]) => [key, hours(seconds)]));

function lines(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a partial last line while a session is still writing */ }
  }
  return out;
}

function walk(dir, match, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, match, out);
    else if (match(entry.name)) out.push(path);
  }
  return out;
}

function argsOf(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw ?? '{}'); } catch { return { raw: String(raw ?? '') }; }
}

function codexThreadNames(root) {
  const names = {};
  const file = join(root, 'session_index.jsonl');
  if (existsSync(file)) for (const row of lines(file)) if (row.id) names[row.id] = row.thread_name ?? row.name ?? null;
  return names;
}

/** Codex rollouts: calls pair with outputs by call_id; children spawned in a turn are live until the turn ends. */
function scanCodex(root, since, tests) {
  const names = codexThreadNames(root);
  const result = { sessions: 0, waits: { calls: 0, seconds: 0, timedOut: 0, noLiveChildCalls: 0, noLiveChildSeconds: 0, byRole: {}, byThread: {} },
    spawns: { byRole: {}, failed: {} }, pollingLoops: { waitThreadsByThread: {}, timeoutStreaks: 0, longestTimeoutStreak: 0 },
    backgroundWaits: { calls: 0, seconds: 0, byKind: {} }, tests: { calls: 0, seconds: 0, gapAfterSeconds: 0 } };
  for (const file of walk(join(root, 'sessions'), (name) => /^rollout-.*\.jsonl$/.test(name))) {
    const rows = lines(file);
    if (!rows.some((row) => time(row.timestamp) >= since)) continue;
    result.sessions += 1;
    let id = null;
    let live = [];
    let streak = 0;
    const pending = new Map();
    const cells = new Map();
    const calls = [];
    for (const row of rows) {
      const payload = row.payload ?? {};
      if (row.type === 'session_meta') id = payload.id ?? id;
      if (payload.type === 'task_started') live = [];
      if (time(row.timestamp) < since) continue;
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        pending.set(payload.call_id, { at: time(row.timestamp), name: payload.name, input: payload.arguments ?? payload.input });
        continue;
      }
      if ((payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output') || !pending.has(payload.call_id)) continue;
      const call = pending.get(payload.call_id);
      pending.delete(payload.call_id);
      const output = text(payload.output);
      const wall = output.slice(0, 600).match(/Wall time ([\d.]+) seconds/);
      const seconds = wall ? Number(wall[1]) : Math.max(0, (time(row.timestamp) - call.at) / 1000);
      const thread = names[id] ?? '(unnamed)';
      const args = argsOf(call.input);
      const command = text(args.cmd ?? args.command ?? args.raw ?? call.input);
      calls.push({ start: call.at, end: time(row.timestamp), test: false });
      if (call.name === 'spawn_agent') {
        const role = args.agent_type ?? '(untyped)';
        if (/unknown agent_type|error/i.test(output.slice(0, 120))) add(result.spawns.failed, role, 1);
        else { add(result.spawns.byRole, role, 1); live.push(role); }
      } else if (call.name === 'wait_agent') {
        const timedOut = /"timed_out"\s*:\s*true/.test(output);
        result.waits.calls += 1;
        result.waits.seconds += seconds;
        add(result.waits.byThread, thread, seconds);
        if (timedOut) {
          result.waits.timedOut += 1;
          streak += 1;
          result.pollingLoops.longestTimeoutStreak = Math.max(result.pollingLoops.longestTimeoutStreak, streak);
          if (streak === 3) result.pollingLoops.timeoutStreaks += 1;
        } else streak = 0;
        if (!live.length) { result.waits.noLiveChildCalls += 1; result.waits.noLiveChildSeconds += seconds; }
        for (const role of live.length ? live : ['(no live child)']) add(result.waits.byRole, role, seconds / Math.max(1, live.length));
      } else if (call.name === 'wait') {
        const kind = cells.get(args.cell_id) ?? 'other';
        result.backgroundWaits.calls += 1;
        result.backgroundWaits.seconds += seconds;
        add(result.backgroundWaits.byKind, kind, seconds);
        if (kind === 'test') result.tests.seconds += seconds;
      } else if (SHELL_TOOLS.has(call.name)) {
        if (/wait_threads/.test(command)) add(result.pollingLoops.waitThreadsByThread, thread, seconds);
        const isTest = tests.test(command);
        const cell = output.slice(0, 400).match(/cell ID (\S+)/);
        if (cell) cells.set(cell[1].replace(/[.,;]$/, ''), isTest ? 'test' : 'other');
        if (isTest) { result.tests.calls += 1; result.tests.seconds += seconds; calls[calls.length - 1].test = true; }
      }
    }
    result.tests.gapAfterSeconds += gapAfterTests(calls);
  }
  return result;
}

/** Claude Code transcripts: tool_use pairs with tool_result by id; Agent/Task calls are subagent runs. */
function scanClaude(root, since, tests) {
  const result = { sessions: 0, agents: { calls: 0, seconds: 0, byRole: {}, byProject: {}, untyped: 0 }, sleeps: { calls: 0, seconds: 0 },
    tests: { calls: 0, seconds: 0, gapAfterSeconds: 0 } };
  for (const file of walk(join(root, 'projects'), (name) => name.endsWith('.jsonl'))) {
    if (statSync(file).mtimeMs < since) continue;
    const project = basename(join(file, '..'));
    const pending = new Map();
    const calls = [];
    let counted = false;
    for (const row of lines(file)) {
      if (!row.timestamp || time(row.timestamp) < since) continue;
      if (!counted) { result.sessions += 1; counted = true; }
      for (const part of Array.isArray(row.message?.content) ? row.message.content : []) {
        if (part?.type === 'tool_use') pending.set(part.id, { at: time(row.timestamp), name: part.name, input: part.input ?? {} });
        if (part?.type !== 'tool_result' || !pending.has(part.tool_use_id)) continue;
        const call = pending.get(part.tool_use_id);
        pending.delete(part.tool_use_id);
        const seconds = Math.max(0, (time(row.timestamp) - call.at) / 1000);
        const entry = { start: call.at, end: time(row.timestamp), test: false };
        calls.push(entry);
        if (call.name === 'Agent' || call.name === 'Task') {
          const role = call.input.subagent_type ?? '(untyped)';
          if (!call.input.subagent_type) result.agents.untyped += 1;
          result.agents.calls += 1;
          result.agents.seconds += seconds;
          add(result.agents.byRole, role, seconds);
          add(result.agents.byProject, project, seconds);
        } else if (SHELL_TOOLS.has(call.name)) {
          const command = text(call.input.command);
          if (/^\s*(sleep|Start-Sleep)\b/.test(command)) { result.sleeps.calls += 1; result.sleeps.seconds += seconds; }
          if (tests.test(command)) { result.tests.calls += 1; result.tests.seconds += seconds; entry.test = true; }
        }
      }
    }
    result.tests.gapAfterSeconds += gapAfterTests(calls);
  }
  return result;
}

// Time from the end of each test call to the next call in the same session: how long the model takes to act on results.
function gapAfterTests(calls) {
  calls.sort((a, b) => a.start - b.start);
  let total = 0;
  for (let i = 0; i < calls.length - 1; i += 1) {
    if (!calls[i].test) continue;
    const gap = (calls[i + 1].start - calls[i].end) / 1000;
    if (gap >= 0 && gap < GAP_LIMIT_S) total += gap;
  }
  return total;
}

export function parseSince(value, now = Date.now()) {
  const days = String(value ?? '').match(/^(\d{1,3})d$/);
  if (days) return now - Number(days[1]) * 86400000;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (Number.isNaN(date)) throw new Error('--since takes a number of days such as 14d, or a date such as 2026-11-01.');
  return date;
}

export function usageScan({ since = '14d', codexHome = join(homedir(), '.codex'), claudeHome = join(homedir(), '.claude'), testPattern, now } = {}) {
  const start = parseSince(since, now);
  let tests;
  try { tests = new RegExp(testPattern ?? DEFAULT_TESTS, 'i'); } catch { throw new Error('--tests must be a valid regular expression.'); }
  const codex = scanCodex(codexHome, start, tests);
  const claude = scanClaude(claudeHome, start, tests);
  const waitHours = hours(codex.waits.seconds + claude.agents.seconds + claude.sleeps.seconds + codex.backgroundWaits.seconds);
  const testHours = hours(codex.tests.seconds + claude.tests.seconds);
  return {
    since: new Date(start).toISOString().slice(0, 10),
    headline: { waitingHours: waitHours, testHours, note: 'Waiting counts agent waits, subagent runs, sleeps and background-cell waits; tests count matched commands.' },
    codex: {
      sessions: codex.sessions,
      agentWaits: { calls: codex.waits.calls, hours: hours(codex.waits.seconds), timedOut: codex.waits.timedOut, timeoutRate: rate(codex.waits.timedOut, codex.waits.calls),
        noLiveChild: { calls: codex.waits.noLiveChildCalls, hours: hours(codex.waits.noLiveChildSeconds) }, byRole: tidy(codex.waits.byRole), byThread: tidy(codex.waits.byThread) },
      spawns: { byRole: codex.spawns.byRole, failed: codex.spawns.failed },
      pollingLoops: { waitThreadsHoursByThread: tidy(codex.pollingLoops.waitThreadsByThread), timeoutStreaksOf3Plus: codex.pollingLoops.timeoutStreaks,
        longestTimeoutStreak: codex.pollingLoops.longestTimeoutStreak },
      backgroundWaits: { calls: codex.backgroundWaits.calls, hours: hours(codex.backgroundWaits.seconds), byKind: tidy(codex.backgroundWaits.byKind) },
      tests: { calls: codex.tests.calls, hours: hours(codex.tests.seconds), gapAfterHours: hours(codex.tests.gapAfterSeconds) },
    },
    claude: {
      sessions: claude.sessions,
      subagents: { calls: claude.agents.calls, hours: hours(claude.agents.seconds), untyped: claude.agents.untyped, byRole: tidy(claude.agents.byRole), byProject: tidy(claude.agents.byProject) },
      sleeps: { calls: claude.sleeps.calls, hours: hours(claude.sleeps.seconds) },
      tests: { calls: claude.tests.calls, hours: hours(claude.tests.seconds), gapAfterHours: hours(claude.tests.gapAfterSeconds) },
    },
    next: 'Waiting far above test time means the hub polls instead of ending its turn; see the workflow Waiting rule.',
  };
}
