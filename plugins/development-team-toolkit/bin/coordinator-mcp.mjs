// Coordinator MCP server over stdio (newline-delimited JSON-RPC). No dependencies beyond Node.js.
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./toolkit.mjs', import.meta.url));
const pluginRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const protocolVersions = ['2025-06-18', '2025-03-26', '2024-11-05'];
const capabilityPattern = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fields = {
  status: [[], []],
  request: [['owner', 'resources'], []],
  claim: [['id'], ['capability']],
  cancel: [['id'], ['capability']],
  release: [['id'], ['capability', 'cleanup_evidence', 'generation']],
  'check-held': [['id', 'resource'], ['capability', 'candidate']],
  'release-check': [['id', 'generation', 'candidate', 'mode'], ['capability']],
  'request-hotfix-priority': [['id', 'generation', 'staging_id', 'receipt_sha256'], ['capability', 'staging_capability']],
};

const tool = {
  name: 'coordinator_call',
  description: [
    'Use the Development Team Toolkit queue for the project Git checkout.',
    'Pass project as the absolute path of the checkout you are working in.',
    'status takes {}. request takes owner and resources (strings such as file:src/app or resource:browser-qa) and returns an id; its private credential stays in local Git state, never in this result.',
    'claim, release and cancel take that id. release can also take cleanup_evidence, a project-relative evidence file.',
    'check-held takes id and resource, with candidate required for an authorized hotfix.',
    'release-check returns the supervisor-authorized release record for the current held generation.',
    'Hotfix holders checkpoint through the local CLI with their capability on stdin.',
    'After an authorized Critical local test passes, request-hotfix-priority takes its id, generation, staging_id, and receipt_sha256 for supervisor verification.',
    'Release a priority hotfix or resumed holder by supplying the current generation.',
    'Pass capability only for a credential a supervisor issued during recovery.',
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
  const candidates = requested === undefined ? [process.env.CLAUDE_PROJECT_DIR, process.cwd()] : [requested];
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

// Request credentials live beside the Coordinator store, one file per request ID, so agents only handle IDs.
function credentialFile(project, id) {
  const git = process.env.CPD_COORDINATOR_GIT || 'git';
  if (process.env.CPD_COORDINATOR_GIT && !isAbsolute(git)) throw new Error('Git pin must be absolute.');
  const common = execFileSync(git, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  }).trim();
  return join(common, 'development-team-credentials', id);
}

async function withStoredCredential(project, operation, payload) {
  if (!['claim', 'cancel', 'release', 'check-held', 'release-check', 'request-hotfix-priority'].includes(operation)
      || !payload || typeof payload !== 'object' || payload.capability !== undefined) return payload;
  if (!uuid.test(payload.id ?? '')) throw new Error('Invalid request ID.');
  try {
    return { ...payload, capability: (await readFile(credentialFile(project, payload.id), 'utf8')).trim() };
  } catch {
    throw new Error('No stored credential for this request. Pass the capability a supervisor issued.');
  }
}

function commandFor(project, operation, payload) {
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
  const { id, capability, cleanup_evidence: evidence, generation, resource, candidate, mode } = payload;
  if (typeof id !== 'string' || !uuid.test(id) || typeof capability !== 'string' || !capabilityPattern.test(capability)
      || (evidence !== undefined && typeof evidence !== 'string')) {
    throw new Error('Invalid request credentials or cleanup evidence.');
  }
  if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 1)) throw new Error('Invalid grant generation.');
  args.push(id);
  if (operation === 'release-check') {
    if (!Number.isSafeInteger(generation) || generation < 1 || typeof candidate !== 'string'
        || !['scoped', 'hotfix'].includes(mode)) throw new Error('Invalid release check.');
    args.push(String(generation), candidate, mode);
  }
  if (operation === 'check-held') {
    if (typeof resource !== 'string' || (candidate !== undefined && typeof candidate !== 'string')) {
      throw new Error('Invalid resource or candidate.');
    }
    args.push(resource);
    if (candidate !== undefined) args.push(candidate);
  }
  if (operation === 'request-hotfix-priority') {
    const { staging_id: stagingId, staging_capability: stagingCapability, receipt_sha256: receiptDigest } = payload;
    if (!Number.isSafeInteger(generation) || !uuid.test(stagingId ?? '')
        || typeof stagingCapability !== 'string' || !capabilityPattern.test(stagingCapability)
        || typeof receiptDigest !== 'string' || !/^[0-9a-f]{64}$/.test(receiptDigest)) {
      throw new Error('Priority needs a grant generation, staging request, and Critical test receipt.');
    }
    return { args: [...args, String(generation), stagingId, receiptDigest], input: `${capability}\n${stagingCapability}` };
  }
  if (operation === 'release') {
    if (evidence !== undefined) args.push(evidence);
    if (generation !== undefined) args.push(`--generation=${generation}`);
  }
  return { args, input: capability };
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
    const directory = projectDirectory(project);
    const input = await withStoredCredential(directory, operation, payload);
    if (operation === 'request-hotfix-priority' && input?.staging_capability === undefined) {
      if (!uuid.test(input?.staging_id ?? '')) throw new Error('Invalid staging request ID.');
      input.staging_capability = (await readFile(credentialFile(directory, input.staging_id), 'utf8')).trim();
    }
    let result = await runCli(directory, commandFor(directory, operation, input));
    if (operation === 'request') {
      const file = credentialFile(directory, result.id);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, `${result.capability}\n`, { flag: 'wx', mode: 0o600 });
      const { capability, ...visible } = result;
      result = { ...visible, credential: 'stored locally' };
    }
    if (['release', 'cancel'].includes(operation)) await rm(credentialFile(directory, payload.id), { force: true });
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
