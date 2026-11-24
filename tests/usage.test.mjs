import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSince } from '../plugins/development-team-toolkit/bin/usage.mjs';

const cli = fileURLToPath(new URL('../plugins/development-team-toolkit/bin/toolkit.mjs', import.meta.url));
const scan = (cwd, ...args) => {
  const result = spawnSync(process.execPath, [cli, 'usage', 'scan', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const at = (seconds) => new Date(Date.UTC(2026, 10, 20, 10, 0, seconds)).toISOString();
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

test('usage scan reports waits by role and thread, timeouts, no-live-child waits, polling and test time', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'toolkit-usage-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codex = join(root, 'codex');
  const claude = join(root, 'claude');
  await mkdir(join(codex, 'sessions', '2026', '11', '20'), { recursive: true });
  await mkdir(join(claude, 'projects', 'demo-project'), { recursive: true });
  await writeFile(join(codex, 'session_index.jsonl'), jsonl([{ id: 's1', thread_name: 'Checkout hub' }]));

  const call = (seconds, id, name, args) => ({ timestamp: at(seconds), type: 'response_item', payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } });
  const out = (seconds, id, output) => ({ timestamp: at(seconds), type: 'response_item', payload: { type: 'function_call_output', call_id: id, output } });
  await writeFile(join(codex, 'sessions', '2026', '11', '20', 'rollout-2026-11-20T10-00-00-s1.jsonl'), jsonl([
    { timestamp: at(0), type: 'session_meta', payload: { id: 's1' } },
    { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started' } },
    // A wait with no child spawned this turn: pure waste.
    call(1, 'w0', 'wait_agent', { timeout_ms: 30000 }), out(31, 'w0', '{"timed_out":true}'),
    call(32, 'sp1', 'spawn_agent', { agent_type: 'qa-code', message: 'review' }), out(33, 'sp1', '{"agent_id":"a1"}'),
    call(34, 'sp2', 'spawn_agent', { agent_type: 'nonsense' }), out(35, 'sp2', 'error: unknown agent_type nonsense'),
    // Three short timeouts in a row: a polling loop.
    call(40, 'w1', 'wait_agent', {}), out(70, 'w1', '{"timed_out":true}'),
    call(71, 'w2', 'wait_agent', {}), out(101, 'w2', '{"timed_out":true}'),
    call(102, 'w3', 'wait_agent', {}), out(162, 'w3', '{"timed_out":false,"status":"completed"}'),
    // A test run backgrounded into a cell, then waited on; then the model takes 20 s to act.
    call(170, 'e1', 'exec', { cmd: 'npm test' }), out(175, 'e1', 'Script running with cell ID c7. Wall time 5 seconds'),
    call(176, 'cw', 'wait', { cell_id: 'c7' }), out(296, 'cw', 'done. Wall time 120 seconds'),
    call(316, 'e2', 'exec', { cmd: 'python wait_threads.py --poll' }), out(376, 'e2', 'Wall time 60 seconds'),
    { timestamp: at(400), type: 'event_msg', payload: { type: 'task_started' } },
  ]));
  const use = (seconds, id, name, input) => ({ timestamp: at(seconds), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  const result = (seconds, id) => ({ timestamp: at(seconds), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  await writeFile(join(claude, 'projects', 'demo-project', 'session.jsonl'), jsonl([
    use(0, 't1', 'Bash', { command: 'pytest -q' }), result(90, 't1'),
    use(100, 't2', 'Agent', { subagent_type: 'toolkit-qa-code', prompt: 'review' }), result(400, 't2'),
    use(410, 't3', 'Agent', { prompt: 'untyped helper' }), result(420, 't3'),
    use(430, 't4', 'Bash', { command: 'sleep 30' }), result(460, 't4'),
  ]));

  const report = scan(root, '--since', '2026-11-01', '--codex-home', codex, '--claude-home', claude);
  const waits = report.codex.agentWaits;
  assert.equal(waits.calls, 4);
  assert.equal(waits.timedOut, 3);
  assert.equal(waits.timeoutRate, 0.75);
  assert.deepEqual(waits.noLiveChild, { calls: 1, hours: 0.01 });
  assert.equal(waits.byThread['Checkout hub'], 0.04); // 30 + 30 + 30 + 60 seconds
  assert.ok(waits.byRole['qa-code'] > 0 && waits.byRole['(no live child)'] > 0);
  assert.deepEqual(report.codex.spawns, { byRole: { 'qa-code': 1 }, failed: { nonsense: 1 } });
  assert.equal(report.codex.pollingLoops.timeoutStreaksOf3Plus, 1);
  assert.equal(report.codex.pollingLoops.longestTimeoutStreak, 3);
  assert.deepEqual(report.codex.pollingLoops.waitThreadsHoursByThread, { 'Checkout hub': 0.02 });
  assert.deepEqual(report.codex.backgroundWaits, { calls: 1, hours: 0.03, byKind: { test: 0.03 } });
  assert.deepEqual(report.codex.tests, { calls: 1, hours: 0.03, gapAfterHours: 0 }); // 5 s command + 120 s cell wait
  assert.deepEqual(report.claude.subagents.byRole, { 'toolkit-qa-code': 0.08, '(untyped)': 0 });
  assert.equal(report.claude.subagents.untyped, 1);
  assert.deepEqual(report.claude.sleeps, { calls: 1, hours: 0.01 });
  assert.deepEqual(report.claude.tests, { calls: 1, hours: 0.03, gapAfterHours: 0 });

  // A custom test pattern, and nothing before --since.
  assert.equal(scan(root, '--since', '2026-11-01', '--tests', 'no-such-tool', '--codex-home', codex, '--claude-home', claude).claude.tests.calls, 0);
  assert.equal(scan(root, '--since', '2026-11-21', '--codex-home', codex, '--claude-home', claude).codex.sessions, 0);
});

test('since accepts days or a date', () => {
  const now = Date.UTC(2026, 10, 24);
  assert.equal(parseSince('14d', now), now - 14 * 86400000);
  assert.equal(parseSince('2026-11-01'), Date.UTC(2026, 10, 1));
  assert.throws(() => parseSince('soon'), /--since/);
});
