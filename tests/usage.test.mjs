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

test('usage scan reports waits by role and thread, timeouts, polling, and test time apart from unclassified background time', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'toolkit-usage-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codex = join(root, 'codex');
  const claude = join(root, 'claude');
  await mkdir(join(codex, 'sessions', '2026', '11', '20'), { recursive: true });
  await mkdir(join(claude, 'projects', 'demo-project'), { recursive: true });
  await writeFile(join(codex, 'session_index.jsonl'), jsonl([{ id: 's1', thread_name: 'Checkout hub' }]));

  const call = (seconds, id, name, args) => ({ timestamp: at(seconds), type: 'response_item', payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } });
  const out = (seconds, id, output) => ({ timestamp: at(seconds), type: 'response_item', payload: { type: 'function_call_output', call_id: id, output } });
  const final = (seconds, author) => ({ timestamp: at(seconds), type: 'response_item', payload: { type: 'agent_message', id: `f${seconds}`, author, recipient: '/root',
    content: [{ type: 'text', text: 'Message Type: FINAL_ANSWER' }] } });
  await writeFile(join(codex, 'sessions', '2026', '11', '20', 'rollout-2026-11-20T10-00-00-s1.jsonl'), jsonl([
    { timestamp: at(0), type: 'session_meta', payload: { id: 's1' } },
    { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started' } },
    // A wait before anything was spawned.
    call(1, 'w0', 'wait_agent', { timeout_ms: 30000 }), out(31, 'w0', '{"timed_out":true}'),
    call(32, 'sp1', 'spawn_agent', { agent_type: 'qa-code', message: 'review' }), out(33, 'sp1', '{"task_name":"/root/review"}'),
    call(34, 'sp2', 'spawn_agent', { agent_type: 'nonsense' }), out(35, 'sp2', 'error: unknown agent_type nonsense'),
    // Three short timeouts in a row: a polling loop.
    call(40, 'w1', 'wait_agent', {}), out(70, 'w1', '{"timed_out":true}'),
    call(71, 'w2', 'wait_agent', {}), out(101, 'w2', '{"timed_out":true}'),
    call(102, 'w3', 'wait_agent', {}), out(162, 'w3', '{"timed_out":false,"message":"Wait completed."}'),
    final(162, '/root/review'),
    call(163, 'w4', 'wait_agent', {}), out(163, 'w4', 'aborted before dispatch'), // never ran: not a wait
    // A test run backgrounded into a cell, then waited on; then the model takes 20 s to act.
    call(170, 'e1', 'exec', { cmd: 'npm test' }), out(175, 'e1', 'Script running with cell ID c7. Wall time 5 seconds'),
    call(176, 'cw', 'wait', { cell_id: 'c7' }), out(296, 'cw', 'done. Wall time 120 seconds'),
    call(316, 'e2', 'exec', { cmd: 'python wait_threads.py --poll' }), out(376, 'e2', 'Wall time 60 seconds'),
    // A background command that is not a test stays out of test time.
    call(380, 'e3', 'exec', { cmd: 'python build_report.py' }), out(381, 'e3', 'Script running with cell ID c8. Wall time 1 seconds'),
    call(382, 'cw2', 'wait', { cell_id: 'c8' }), out(562, 'cw2', 'done. Wall time 180 seconds'),
    { timestamp: at(600), type: 'event_msg', payload: { type: 'task_started' } },
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
  assert.equal(waits.notRun, 1);
  assert.deepEqual(waits.split, { childRunningHours: 0.03, noKnownRunningChildHours: 0.01, unknownHours: 0 });
  assert.equal(waits.byThread['Checkout hub'], 0.04); // 30 + 30 + 30 + 60 seconds
  assert.ok(waits.byRole['qa-code'] > 0 && waits.byRole['(no known running child)'] > 0);
  assert.deepEqual(report.codex.spawns, { byRole: { 'qa-code': 1 }, failed: { nonsense: 1 } });
  assert.equal(report.codex.pollingLoops.timeoutStreaksOf3Plus, 1);
  assert.equal(report.codex.pollingLoops.longestTimeoutStreak, 3);
  assert.deepEqual(report.codex.pollingLoops.waitThreadsHoursByThread, { 'Checkout hub': 0.02 });
  assert.deepEqual(report.codex.unclassifiedBackgroundWaits, { calls: 1, hours: 0.05 });
  assert.deepEqual(report.codex.tests, { calls: 1, hours: 0.03, ofWhichBackgroundHours: 0.03, gapAfterHours: 0.01 }); // 5 s command + 120 s cell wait
  assert.deepEqual([report.headline.identifiedTestHours, report.headline.unclassifiedBackgroundHours, report.headline.crossChatWaitHours], [0.06, 0.05, 0.02]);
  assert.match(report.headline.note, /includes time the awaited agents were working/);
  assert.deepEqual(report.claude.subagents.byRole, { 'toolkit-qa-code': 0.08, '(untyped)': 0 });
  assert.equal(report.claude.subagents.untyped, 1);
  assert.deepEqual(report.claude.sleeps, { calls: 1, hours: 0.01 });
  assert.deepEqual(report.claude.tests, { calls: 1, hours: 0.03, gapAfterHours: 0 });

  // A custom test pattern, and nothing before --since.
  assert.equal(scan(root, '--since', '2026-11-01', '--tests', 'no-such-tool', '--codex-home', codex, '--claude-home', claude).claude.tests.calls, 0);
  assert.equal(scan(root, '--since', '2026-11-21', '--codex-home', codex, '--claude-home', claude).codex.sessions, 0);
});

test('agents are tracked across turns and dropped on completion evidence; without it the time is unknown', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'toolkit-usage-live-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const row = (seconds, payload, type = 'response_item') => ({ timestamp: at(seconds), type, payload });
  const call = (seconds, id, name, args = {}) => row(seconds, { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
  const out = (seconds, id, output) => row(seconds, { type: 'function_call_output', call_id: id, output });
  const wait = (from, to, id, timedOut = false) => [call(from, id, 'wait_agent', { timeout_ms: 900000 }), out(to, id, JSON.stringify({ message: 'x', timed_out: timedOut }))];
  const turn = (type, seconds, id) => row(seconds, { type, turn_id: id }, 'event_msg');
  const meta = (id, extra = {}) => row(0, { id, ...extra }, 'session_meta');
  const spawn = (seconds, id, role, name) => [call(seconds, id, 'spawn_agent', { agent_type: role, task_name: name }), out(seconds + 1, id, JSON.stringify({ task_name: `/root/${name}` }))];
  const split = async (name, files) => {
    const home = join(root, name);
    await mkdir(join(home, 'sessions'), { recursive: true });
    for (const [index, rows] of files.entries()) await writeFile(join(home, 'sessions', `rollout-2026-11-20T10-00-0${index}-x.jsonl`), jsonl(rows.flat()));
    return scan(root, '--since', '2026-11-01', '--codex-home', home, '--claude-home', join(root, 'none')).codex.agentWaits;
  };
  const child = (from, to) => [meta('kid', { parent_thread_id: 'hub', agent_path: '/root/review' }), turn('task_started', from, 'k1'), ...(to ? [turn('task_complete', to, 'k1')] : [])];
  const hub = [meta('hub'), turn('task_started', 0, 'h1'), spawn(1, 's1', 'qa-code', 'review'), turn('task_complete', 10, 'h1'), turn('task_started', 20, 'h2')];

  // Spawn in turn 1, wait in turn 2 while the child still runs.
  const running = await split('turns', [[...hub, wait(30, 3630, 'w1')], child(2, 3630)]);
  assert.deepEqual(running.split, { childRunningHours: 1, noKnownRunningChildHours: 0, unknownHours: 0 });
  assert.deepEqual(running.byRole, { 'qa-code': 1 });

  // A child that finished before the wait is not live, and one that finishes halfway is live only until then.
  assert.deepEqual((await split('finished', [[...hub, wait(100, 3700, 'w1', true)], child(2, 50)])).split, { childRunningHours: 0, noKnownRunningChildHours: 1, unknownHours: 0 });
  assert.deepEqual((await split('halfway', [[...hub, wait(100, 3700, 'w1')], child(2, 1900)])).split, { childRunningHours: 0.5, noKnownRunningChildHours: 0.5, unknownHours: 0 });

  // No rollout for the child: the parent's FINAL_ANSWER ends the run, and a follow-up starts it again.
  const final = (seconds) => row(seconds, { type: 'agent_message', id: `f${seconds}`, author: '/root/review', recipient: '/root', content: [{ type: 'text', text: 'Message Type: FINAL_ANSWER' }] });
  const again = [call(3800, 'fu', 'followup_task', { target: 'review', message: 'fix' }), out(3801, 'fu', '')];
  assert.deepEqual((await split('final', [[...hub, final(90), wait(100, 3700, 'w1'), again, wait(3801, 7401, 'w2'), final(7401)]])).split,
    { childRunningHours: 1, noKnownRunningChildHours: 1, unknownHours: 0 });

  // Completion never recorded, or a spawn hidden inside a script: unknown, neither running nor empty.
  assert.deepEqual((await split('lost', [[...hub, wait(100, 3700, 'w1')]])).split, { childRunningHours: 0, noKnownRunningChildHours: 0, unknownHours: 1 });
  const hidden = [call(1, 'x', 'exec', { cmd: 'await tools.spawn_agent({})' }), out(2, 'x', 'ok')];
  assert.deepEqual((await split('script', [[meta('hub'), hidden, wait(100, 3700, 'w1')]])).split, { childRunningHours: 0, noKnownRunningChildHours: 0, unknownHours: 1 });

  // A forked child's rollout repeats its parent's history; nothing is counted twice or moved to the child.
  const parent = [...hub, wait(30, 3630, 'w1')];
  const forked = await split('forked', [parent, [child(2, 3630)[0], ...parent, ...child(2, 3630).slice(1)]]);
  assert.deepEqual([forked.calls, forked.split.childRunningHours], [1, 1]);
});

test('since accepts days or a date', () => {
  const now = Date.UTC(2026, 10, 24);
  assert.equal(parseSince('14d', now), now - 14 * 86400000);
  assert.equal(parseSince('2026-11-01'), Date.UTC(2026, 10, 1));
  assert.throws(() => parseSince('soon'), /--since/);
});
