import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const plugin = fileURLToPath(new URL('../plugins/development-team-toolkit/', import.meta.url));
const server = join(plugin, 'bin', 'coordinator-mcp.mjs');
const cli = join(plugin, 'bin', 'toolkit.mjs');

function connect(cwd, env = {}) {
  const child = spawn(process.execPath, [server], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let next = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { rpc, close: () => child.kill() };
}

test('plugin MCP server shares the CLI queue and needs no Python', async (t) => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'toolkit-mcp-')));
  t.after(() => rm(project, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', project]);
  const cliRun = (...args) => JSON.parse(spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: 'utf8' }).stdout);

  // Codex starts plugin servers in the plugin folder, so the project must come from the tool call.
  const mcp = connect(plugin);
  t.after(mcp.close);
  const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual((await mcp.rpc('tools/list', {})).result.tools.map((tool) => tool.name), ['coordinator_call']);
  assert.equal((await mcp.rpc('nope', {})).error.code, -32601);

  const call = async (operation, payload, withProject = true) => {
    const reply = await mcp.rpc('tools/call', { name: 'coordinator_call', arguments: { operation, payload, ...(withProject ? { project } : {}) } });
    return reply.result;
  };
  const missing = await call('status', {}, false);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /absolute path of the project/);

  // The credential stays in local Git state; the agent only ever sees the request ID.
  const requested = await call('request', { owner: 'mcp', resources: ['resource:runner'] });
  const first = requested.structuredContent.result;
  assert.equal(first.capability, undefined);
  assert.equal(first.credential, 'stored locally');
  const stored = join(project, '.git', 'development-team-credentials', first.id);
  const capability = (await readFile(stored, 'utf8')).trim();
  assert.match(capability, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(requested).includes(capability));
  assert.equal((await call('claim', { id: first.id })).structuredContent.result.state, 'held');
  const conflict = cliRun('coordinate', 'request', 'cli', 'resource:runner');
  const status = (await call('status', {})).structuredContent.result;
  // age_seconds can tick between the two reads, so compare everything else.
  const ageless = (snapshot) => ({ ...snapshot, requests: snapshot.requests.map(({ age_seconds: _, ...rest }) => rest) });
  assert.deepEqual(ageless(status), ageless(cliRun('coordinate', 'status')));
  assert.deepEqual(status.requests.map((entry) => entry.state), ['held', 'queued']);
  assert.ok(!JSON.stringify(status).includes(capability));
  assert.equal((await call('handoff', {})).isError, true);
  assert.equal((await call('claim', { id: first.id, capability: '0'.repeat(64) })).isError, true);
  assert.equal((await call('claim', { id: '../../x' })).isError, true);
  assert.equal((await call('release', { id: first.id })).structuredContent.result.state, 'released');
  assert.equal(existsSync(stored), false);
  assert.equal((await call('claim', { id: conflict.id, capability: conflict.capability })).structuredContent.result.state, 'held');

  // Claude Code exposes the project directory, so the project argument is optional there.
  const claude = connect(plugin, { CLAUDE_PROJECT_DIR: project });
  t.after(claude.close);
  await claude.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const reply = await claude.rpc('tools/call', { name: 'coordinator_call', arguments: { operation: 'status', payload: {} } });
  assert.equal(reply.result.structuredContent.result.requests.length, 2);
});

test('both plugin manifests ship the same Coordinator server and version', async () => {
  const codex = JSON.parse(await readFile(join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'));
  const claude = JSON.parse(await readFile(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(codex.version, claude.version);
  assert.equal(codex.name, claude.name);
  const codexServer = JSON.parse(await readFile(join(plugin, codex.mcpServers), 'utf8')).mcpServers.coordinator;
  assert.deepEqual(codexServer.args, ['./bin/coordinator-mcp.mjs']);
  assert.equal(codexServer.default_tools_approval_mode, 'approve');
  assert.deepEqual(claude.mcpServers.coordinator.args, ['${CLAUDE_PLUGIN_ROOT}/bin/coordinator-mcp.mjs']);
});

test('MCP checks held grants and accepts checkpoint evidence from the requested checkout only', async (t) => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'toolkit-mcp-hotfix-')));
  t.after(() => rm(project, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', project]);
  const mcp = connect(plugin, { CLAUDE_PROJECT_DIR: project });
  t.after(mcp.close);
  const call = async (operation, payload, directory = project) => (await mcp.rpc('tools/call', {
    name: 'coordinator_call', arguments: { operation, payload, project: directory },
  })).result;
  const stage = 'resource:staging';
  const { id } = (await call('request', { owner: 'holder', resources: [stage] })).structuredContent.result;
  assert.equal((await call('check-held', { id, resource: stage })).isError, true);
  const grant = (await call('claim', { id })).structuredContent.result;
  const checked = (await call('check-held', { id, resource: stage })).structuredContent.result;
  assert.equal(checked.id, id);
  assert.equal(checked.generation, grant.generation);
  assert.equal(checked.project, await realpath(join(project, '.git')));
  assert.equal(checked.capability, undefined);
  const capability = (await readFile(join(project, '.git', 'development-team-credentials', id), 'utf8')).trim();
  assert.ok(!JSON.stringify(checked).includes(capability));
  assert.equal((await call('check-held', { id, resource: stage }, join(project, 'missing'))).isError, true);
  const urgent = (await call('request', { owner: 'urgent', resources: [stage] })).structuredContent.result;
  const supervisor = 'a'.repeat(64);
  const cliRun = (...args) => spawnSync(process.execPath, [cli, 'coordinate', ...args], {
    cwd: project, input: `${supervisor}\n`, encoding: 'utf8',
  });
  assert.equal(cliRun('authority-init').status, 0);
  const record = { version: 1, generation: grant.generation, old: 'a'.repeat(40), build: '42411483',
    new: 'b'.repeat(40), tree: 'c'.repeat(40), local_ref: 'refs/heads/cpd-scoped/fixture',
    remote: 'origin', url: 'https://example.invalid/repo', ref: 'refs/heads/Development',
    selected: ['d'.repeat(40)], approvals: ['owner-ref'], excluded: [], source_ref: 'refs/heads/Development', mode: 'scoped' };
  assert.equal(cliRun('authorize-release', id, JSON.stringify(record)).status, 0);
  const scoped = await call('release-check', { id, generation: grant.generation, candidate: record.new, mode: 'scoped' });
  assert.equal(scoped.structuredContent.result.mode, 'scoped');
  assert.ok(!JSON.stringify(scoped).includes(capability));
  assert.equal((await call('release-check', { id, generation: grant.generation, candidate: record.new, mode: 'hotfix' })).isError, true);
  const candidate = 'c'.repeat(40);
  assert.equal(cliRun('authorize-hotfix', urgent.id, candidate, 'owner', 'approval-1').status, 0);
  await writeFile(join(project, 'checkpoint.json'), JSON.stringify({ [stage]: 'staging-idle' }));
  const checkpoint = { id, generation: grant.generation, checkpoint_evidence: 'checkpoint.json' };
  assert.equal((await call('checkpoint-hotfix', { ...checkpoint, checkpoint_evidence: '../checkpoint.json' })).isError, true);
  assert.equal((await call('checkpoint-hotfix', checkpoint)).isError, true);
  assert.equal((await call('checkpoint-hotfix', { ...checkpoint, capability })).isError, true);
  const safeCheckpoint = spawnSync(process.execPath, [cli, 'coordinate', 'checkpoint-hotfix', id,
    String(grant.generation), 'checkpoint.json'], { cwd: project, input: `${capability}\n`, encoding: 'utf8' });
  assert.equal(safeCheckpoint.status, 0, safeCheckpoint.stderr);
  const pending = (await call('claim', { id: urgent.id })).structuredContent.result;
  assert.equal((await call('check-held', { id: urgent.id, resource: stage, candidate })).structuredContent.result.generation, pending.generation);
  assert.equal((await call('release', { id: urgent.id, generation: pending.generation })).structuredContent.result.state, 'released');
});
