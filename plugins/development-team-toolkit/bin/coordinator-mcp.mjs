// Coordinator MCP server over stdio (newline-delimited JSON-RPC). No dependencies beyond Node.js.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./toolkit.mjs', import.meta.url));
const pluginRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const protocolVersions = ['2025-06-18', '2025-03-26', '2024-11-05'];
const capabilityPattern = /^[0-9a-f]{64}$/;
const fields = {
  status: [[], []],
  request: [['owner', 'resources'], []],
  claim: [['id', 'capability'], []],
  cancel: [['id', 'capability'], []],
  release: [['id', 'capability'], ['cleanup_evidence']],
};

const tool = {
  name: 'coordinator_call',
  description: [
    'Use the Development Team Toolkit queue for the project Git checkout.',
    'Pass project as the absolute path of the checkout you are working in.',
    'status takes {}. request takes owner and resources (strings such as file:src/app or resource:browser-qa) and returns an id and a private capability.',
    'claim, release and cancel take id and that capability. release can also take cleanup_evidence, a project-relative evidence file.',
    'Supervisor operations use the local toolkit CLI.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: Object.keys(fields) },
      payload: { type: 'object' },
      project: { type: 'string', description: 'Absolute path of the project Git checkout.' },
    },
    required: ['operation', 'payload'],
  },
};

function projectDirectory(requested) {
  const candidates = [requested, process.env.CLAUDE_PROJECT_DIR, process.cwd()];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate || !isAbsolute(candidate)) continue;
    let resolved;
    try {
      resolved = realpathSync(candidate);
    } catch {
      continue;
    }
    if (resolved === pluginRoot || resolved.startsWith(`${pluginRoot}\\`) || resolved.startsWith(`${pluginRoot}/`)) continue;
    return resolved;
  }
  throw new Error('Pass project as the absolute path of the project Git checkout.');
}

function commandFor(operation, payload) {
  if (!Object.hasOwn(fields, operation) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Unsupported Coordinator operation.');
  }
  const [required, optional] = fields[operation];
  const keys = Object.keys(payload);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error('Invalid Coordinator payload fields.');
  }
  if (JSON.stringify(payload).length > 65536) throw new Error('Coordinator payload is too large.');
  const args = ['coordinate', operation];
  if (operation === 'request') {
    const { owner, resources } = payload;
    if (typeof owner !== 'string' || !Array.isArray(resources) || resources.length < 1 || resources.length > 64
        || resources.some((resource) => typeof resource !== 'string')) {
      throw new Error('Request needs an owner and a list of resource strings.');
    }
    return { args: [...args, owner, ...resources], input: '' };
  }
  if (operation === 'status') return { args, input: '' };
  const { id, capability, cleanup_evidence: evidence } = payload;
  if (typeof id !== 'string' || typeof capability !== 'string' || !capabilityPattern.test(capability)
      || (evidence !== undefined && typeof evidence !== 'string')) {
    throw new Error('Invalid request credentials or cleanup evidence.');
  }
  return { args: [...args, id, ...(evidence === undefined ? [] : [evidence])], input: capability };
}

function runCli(project, { args, input }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], {
      cwd: project, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Coordinator command unavailable.')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || 'Coordinator refused the operation.'));
      try {
        resolveRun(JSON.parse(stdout));
      } catch {
        reject(new Error('Coordinator returned an unreadable result.'));
      }
    });
    child.stdin.end(input);
  });
}

async function callTool(params) {
  if (params?.name !== tool.name) throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: -32602 });
  const { operation, payload, project } = params.arguments ?? {};
  try {
    const result = await runCli(projectDirectory(project), commandFor(operation, payload));
    const structuredContent = { operation, result };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
  } catch (error) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
}

async function handle(message) {
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      return {
        protocolVersion: protocolVersions.includes(requested) ? requested : protocolVersions[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'development-team-coordinator', version: '1' },
      };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: [tool] };
    case 'tools/call': return callTool(message.params);
    default: throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
  }
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (message.id === undefined || message.id === null) return; // notifications need no reply
  try {
    send({ jsonrpc: '2.0', id: message.id, result: await handle(message) });
  } catch (error) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});
