// Usage scan: where agent time goes, read-only from local Codex and Claude Code transcripts. It separates identified
// test and gate runs from agent waits, cross-chat waits and unclassified background commands. Wait time includes the
// time the awaited agents were working, so a long wait is not by itself idle time.
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

// One compact record per thread. Forked children start with a copy of their parent's history, so the first session_meta
// names the thread, and calls and turns already seen in an earlier file (the parent's) are skipped.
function readCodexThreads(root) {
  const threads = new Map();
  const seen = new Set();
  const once = (key) => (seen.has(key) ? false : Boolean(seen.add(key)));
  for (const file of walk(join(root, 'sessions'), (name) => /^rollout-.*\.jsonl$/.test(name)).sort((a, b) => basename(a).localeCompare(basename(b)))) {
    const rows = lines(file);
    const meta = rows.find((row) => row.type === 'session_meta')?.payload ?? {};
    const id = meta.id ?? file;
    const origin = meta.source?.subagent?.thread_spawn ?? {};
    const thread = threads.get(id) ?? threads.set(id, { id, parent: meta.parent_thread_id ?? origin.parent_thread_id ?? null,
      path: meta.agent_path ?? origin.agent_path ?? '/root', calls: [], finals: [], turns: new Map(), lastAt: 0 }).get(id);
    const pending = new Map();
    for (const row of rows) {
      const payload = row.payload ?? {};
      const now = time(row.timestamp);
      if (Number.isNaN(now)) continue;
      thread.lastAt = Math.max(thread.lastAt, now);
      if (payload.type === 'task_started') {
        const turn = payload.turn_id ?? `${id}:${now}`;
        if (once(`start:${turn}`)) thread.turns.set(turn, { from: now, to: null });
      } else if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
        const turn = thread.turns.get(payload.turn_id) ?? (payload.turn_id ? null : [...thread.turns.values()].at(-1));
        if (turn && turn.to === null) turn.to = now;
      } else if (payload.type === 'agent_message') {
        const head = (Array.isArray(payload.content) ? payload.content : []).map((part) => part?.text ?? '').join('').slice(0, 400);
        if (/Message Type:\s*FINAL_ANSWER/.test(head) && payload.author && once(`final:${payload.id ?? `${id}:${payload.author}:${now}`}`)) {
          thread.finals.push({ at: now, author: payload.author });
        }
      } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        if (once(`call:${payload.call_id}`)) pending.set(payload.call_id, { at: now, name: payload.name, input: payload.arguments ?? payload.input });
      } else if ((payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') && pending.has(payload.call_id)) {
        const call = pending.get(payload.call_id);
        pending.delete(payload.call_id);
        thread.calls.push({ ...call, end: now, output: text(payload.output).slice(0, 4000) });
      }
    }
  }
  for (const thread of threads.values()) thread.calls.sort((a, b) => a.at - b.at);
  return threads;
}

function parsed(output) {
  try { return JSON.parse(output); } catch { return null; }
}

/**
 * When each agent this thread spawned was running, across all its turns. The child's own rollout is the evidence (its
 * turns start and complete there). Without it, the parent's records are used: spawn or follow-up starts a run, and a
 * FINAL_ANSWER, a completed list_agents status or an interrupt ends it. A run whose end was never recorded becomes
 * unknown, neither running nor finished.
 */
function agentTimelines(thread, threads) {
  const agents = new Map();
  let untracked = null; // a spawn issued from inside a script has no readable result
  const full = (name) => (String(name).startsWith('/') ? String(name) : `${thread.path}/${name}`);
  const starts = (path, at) => agents.get(path)?.events.push({ at, start: true });
  const ends = (path, at) => agents.get(path)?.events.push({ at, start: false });
  for (const call of thread.calls) {
    const args = argsOf(call.input);
    const result = parsed(call.output);
    const spawned = call.name === 'spawn_agent' && (result?.task_name ? full(result.task_name) : result?.agent_id); // older runtimes return an id
    if (spawned) {
      const path = spawned;
      const agent = agents.get(path) ?? agents.set(path, { path, role: args.agent_type ?? '(untyped)', events: [], spawned: call.end }).get(path);
      agent.events.push({ at: call.end, start: true });
    } else if (call.name === 'followup_task' && !call.output.trim()) starts(full(args.target), call.end);
    else if (call.name === 'interrupt_agent' && result?.previous_status) ends(full(args.target), call.end);
    else if (call.name === 'list_agents') {
      for (const item of result?.agents ?? []) if (item.agent_status && typeof item.agent_status === 'object') ends(full(item.agent_name), call.end);
    } else if (SHELL_TOOLS.has(call.name) && /\bspawn_agent\s*\(/.test(text(call.input))) untracked ??= call.end;
  }
  for (const final of thread.finals) ends(full(final.author), final.at);
  for (const agent of agents.values()) {
    const child = [...threads.values()].filter((item) => item.parent === thread.id && (item.path === agent.path || item.id === agent.path));
    const turns = child.flatMap((item) => [...item.turns.values()].map((turn) => ({ ...turn, lastAt: item.lastAt }))).sort((a, b) => a.from - b.from);
    agent.running = [];
    agent.unknown = [];
    if (turns.length) {
      if (turns[0].from > agent.spawned) agent.running.push([agent.spawned, turns[0].from]);
      for (const turn of turns) {
        agent.running.push([turn.from, turn.to ?? turn.lastAt]);
        if (turn.to === null) agent.unknown.push([turn.lastAt, turns.find((next) => next.from > turn.from)?.from ?? Infinity]);
      }
      continue;
    }
    let from = null;
    for (const event of agent.events.sort((a, b) => a.at - b.at)) {
      if (event.start) from ??= event.at;
      else if (from !== null) { agent.running.push([from, event.at]); from = null; }
    }
    if (from !== null) agent.unknown.push([from, Infinity]);
  }
  return { agents: [...agents.values()], untracked };
}

const overlap = (ranges, from, to) => ranges.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a);
function covered(ranges) {
  let total = 0;
  let reach = -Infinity;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (b > reach) { total += b - Math.max(a, reach); reach = b; }
  }
  return total / 1000;
}

/** Codex rollouts. Calls pair with outputs by call_id; a wait is split by what its thread's agents were doing then. */
function scanCodex(root, since, tests) {
  const names = codexThreadNames(root);
  const threads = readCodexThreads(root);
  const result = { sessions: 0, waits: { calls: 0, seconds: 0, timedOut: 0, notRun: 0, running: 0, unknown: 0, noKnownChild: 0, byRole: {}, byThread: {} },
    spawns: { byRole: {}, failed: {} }, pollingLoops: { waitThreadsByThread: {}, timeoutStreaks: 0, longestTimeoutStreak: 0 },
    crossChat: { seconds: 0 }, background: { calls: 0, seconds: 0 }, tests: { calls: 0, seconds: 0, backgroundSeconds: 0, gapAfterSeconds: 0 } };
  for (const thread of threads.values()) {
    if (thread.lastAt < since) continue;
    result.sessions += 1;
    const name = names[thread.id] ?? '(unnamed)';
    const timeline = agentTimelines(thread, threads);
    const cells = new Map();
    const marks = [];
    let streak = 0;
    for (const call of thread.calls) {
      const { output } = call;
      const args = argsOf(call.input);
      const command = text(args.cmd ?? args.command ?? args.raw ?? call.input);
      const shell = SHELL_TOOLS.has(call.name);
      const kind = !shell ? null : /wait_threads/.test(command) ? 'cross-chat' : tests.test(command) ? 'test' : 'unclassified';
      const cell = shell && output.slice(0, 400).match(/cell ID (\S+)/);
      if (cell) cells.set(cell[1].replace(/[.,;]$/, ''), kind); // kept from before --since so later waits are classified
      if (call.at < since) continue;
      const wall = output.slice(0, 600).match(/Wall time ([\d.]+) seconds/);
      const seconds = wall ? Number(wall[1]) : Math.max(0, (call.end - call.at) / 1000);
      const mark = { start: call.at, end: call.end, test: false };
      marks.push(mark);
      if (call.name === 'spawn_agent') {
        const role = args.agent_type ?? '(untyped)';
        const spawned = parsed(output);
        add(spawned?.task_name || spawned?.agent_id ? result.spawns.byRole : result.spawns.failed, role, 1);
      } else if (call.name === 'wait_agent') {
        const answer = parsed(output);
        if (typeof answer?.timed_out !== 'boolean') { result.waits.notRun += 1; continue; } // refused or aborted before it ran
        result.waits.calls += 1;
        result.waits.seconds += seconds;
        add(result.waits.byThread, name, seconds);
        if (answer.timed_out) {
          result.waits.timedOut += 1;
          streak += 1;
          result.pollingLoops.longestTimeoutStreak = Math.max(result.pollingLoops.longestTimeoutStreak, streak);
          if (streak === 3) result.pollingLoops.timeoutStreaks += 1;
        } else streak = 0;
        const busy = timeline.agents.map((agent) => ({ role: agent.role, ranges: overlap(agent.running, call.at, call.end) }));
        const doubt = timeline.agents.flatMap((agent) => overlap(agent.unknown, call.at, call.end));
        if (timeline.untracked !== null) doubt.push(...overlap([[timeline.untracked, Infinity]], call.at, call.end));
        const runningRanges = busy.flatMap((item) => item.ranges);
        const running = Math.min(seconds, covered(runningRanges));
        const unknown = Math.min(seconds - running, covered([...runningRanges, ...doubt]) - covered(runningRanges));
        const rest = Math.max(0, seconds - running - unknown);
        result.waits.running += running;
        result.waits.unknown += unknown;
        result.waits.noKnownChild += rest;
        const shares = busy.map((item) => [item.role, covered(item.ranges)]).filter(([, share]) => share > 0);
        const all = shares.reduce((sum, [, share]) => sum + share, 0);
        for (const [role, share] of shares) add(result.waits.byRole, role, (running * share) / all);
        if (unknown > 0) add(result.waits.byRole, '(unknown)', unknown);
        if (rest > 0) add(result.waits.byRole, '(no known running child)', rest);
      } else if (call.name === 'wait') {
        const waited = cells.get(args.cell_id) ?? 'unclassified';
        if (waited === 'test') { result.tests.seconds += seconds; result.tests.backgroundSeconds += seconds; mark.test = true; }
        else if (waited === 'cross-chat') { result.crossChat.seconds += seconds; add(result.pollingLoops.waitThreadsByThread, name, seconds); }
        else { result.background.calls += 1; result.background.seconds += seconds; }
      } else if (kind === 'cross-chat') {
        result.crossChat.seconds += seconds;
        add(result.pollingLoops.waitThreadsByThread, name, seconds);
      } else if (kind === 'test') { result.tests.calls += 1; result.tests.seconds += seconds; mark.test = true; }
    }
    result.tests.gapAfterSeconds += gapAfterTests(marks);
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
  return {
    since: new Date(start).toISOString().slice(0, 10),
    headline: {
      agentWaitHours: hours(codex.waits.seconds), crossChatWaitHours: hours(codex.crossChat.seconds), claudeSubagentHours: hours(claude.agents.seconds),
      sleepHours: hours(claude.sleeps.seconds), identifiedTestHours: hours(codex.tests.seconds + claude.tests.seconds),
      unclassifiedBackgroundHours: hours(codex.background.seconds),
      note: 'Separate buckets; do not add them to call the sum idle. Wait time includes time the awaited agents were working.',
    },
    codex: {
      sessions: codex.sessions,
      agentWaits: { calls: codex.waits.calls, hours: hours(codex.waits.seconds), timedOut: codex.waits.timedOut, timeoutRate: rate(codex.waits.timedOut, codex.waits.calls), notRun: codex.waits.notRun,
        split: { childRunningHours: hours(codex.waits.running), noKnownRunningChildHours: hours(codex.waits.noKnownChild), unknownHours: hours(codex.waits.unknown) },
        byRole: tidy(codex.waits.byRole), byThread: tidy(codex.waits.byThread) },
      spawns: { byRole: codex.spawns.byRole, failed: codex.spawns.failed },
      pollingLoops: { waitThreadsHoursByThread: tidy(codex.pollingLoops.waitThreadsByThread), timeoutStreaksOf3Plus: codex.pollingLoops.timeoutStreaks,
        longestTimeoutStreak: codex.pollingLoops.longestTimeoutStreak },
      unclassifiedBackgroundWaits: { calls: codex.background.calls, hours: hours(codex.background.seconds) },
      tests: { calls: codex.tests.calls, hours: hours(codex.tests.seconds), ofWhichBackgroundHours: hours(codex.tests.backgroundSeconds), gapAfterHours: hours(codex.tests.gapAfterSeconds) },
    },
    claude: {
      sessions: claude.sessions,
      subagents: { calls: claude.agents.calls, hours: hours(claude.agents.seconds), untyped: claude.agents.untyped, byRole: tidy(claude.agents.byRole), byProject: tidy(claude.agents.byProject) },
      sleeps: { calls: claude.sleeps.calls, hours: hours(claude.sleeps.seconds) },
      tests: { calls: claude.tests.calls, hours: hours(claude.tests.seconds), gapAfterHours: hours(claude.tests.gapAfterSeconds) },
    },
    limits: [
      'No known running child means no agent spawned by that thread was recorded as running. The wait may still have been for a message from a parent, sibling or nested agent, so it is not proof of empty waiting.',
      'Unknown covers agents with no recorded end and spawns issued from inside a script.',
      'Waits, spawns and tests issued from inside another script are seen only through that script call. Test time is only what the pattern matches.',
    ],
  };
}
