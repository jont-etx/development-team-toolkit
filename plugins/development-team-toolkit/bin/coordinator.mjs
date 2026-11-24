import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const hash = (value) => createHash('sha256').update(value).digest();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const capabilityPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const staging = 'resource:staging';
const isolatedOdoo = 'resource:local-odoo-isolated';
const criticalOdoo = 'resource:local-odoo-critical';
const odooMaintenance = new Set(['resource:local-odoo', 'resource:test-runner']);
const odooPools = new Map([[isolatedOdoo, 2], [criticalOdoo, 1]]);

function gitPath(option) {
  try {
    const git = process.env.CPD_COORDINATOR_GIT || 'git';
    if (process.env.CPD_COORDINATOR_GIT && !isAbsolute(git)) throw new Error('Git pin must be absolute.');
    return realpathSync(execFileSync(git, ['rev-parse', '--path-format=absolute', option], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());
  } catch {
    throw new Error('Coordinator requires a Git working tree.');
  }
}

function normalizeResource(value, root) {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid resource.');
  if (value.startsWith('resource:')) {
    const name = value.slice(9);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) throw new Error('Invalid named resource.');
    return `resource:${name.toLowerCase()}`;
  }
  if (!value.startsWith('file:')) throw new Error('Resources must start with file: or resource:.');
  const parts = value.slice(5).split('/');
  if (!parts.length || parts.some((part) => !/^[a-zA-Z0-9._-]+$/.test(part)
      || part.endsWith('.') || part.toLowerCase() === '.git'
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('File resources require a portable Git-root-relative path.');
  }
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('File resources cannot traverse symbolic links.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return `file:${parts.join('/').toLowerCase()}`;
}

function overlaps(left, right) {
  if (odooPools.has(left) && odooMaintenance.has(right)
      || odooPools.has(right) && odooMaintenance.has(left)) return true;
  if (odooPools.has(left) && left === right) return false;
  if (left === right) return true;
  if (!left.startsWith('file:') || !right.startsWith('file:')) return false;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function conflicts(left, right) {
  return left.some((resource) => right.some((other) => overlaps(resource, other)));
}

function openStore(commonDir) {
  const path = join(commonDir, 'development-team-coordinator.sqlite');
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!lstatSync(path).isFile()) throw new Error('Coordinator state must be a regular file.');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 10000;');
  if (db.prepare('PRAGMA user_version').get().user_version >= storeVersion) return db;
  transaction(db, () => {
    if (db.prepare('PRAGMA user_version').get().user_version >= storeVersion) return;
    migrate(db);
  });
  return db;
}

// Runs once per store version; every Coordinator command used to repeat it.
const storeVersion = 5;

function migrate(db) {
  // Older scheduler binaries must not mutate grants without generation fencing.
  const priorTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('coordinator_requests', 'requests') ORDER BY name LIMIT 1").get();
  if (priorTable) db.exec(`ALTER TABLE ${priorTable.name} RENAME TO coordinator_grants`);
  db.exec(`CREATE TABLE IF NOT EXISTS coordinator_grants (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      capability_hash BLOB NOT NULL,
      owner TEXT NOT NULL,
      resources TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'held', 'released', 'cancelled'))
    );
    CREATE VIEW IF NOT EXISTS requests AS SELECT * FROM coordinator_grants;
    CREATE VIEW IF NOT EXISTS coordinator_requests AS SELECT * FROM coordinator_grants;`);
  db.exec(`CREATE TABLE IF NOT EXISTS coordinator_authority (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), epoch INTEGER NOT NULL, capability_hash BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coordinator_quarantine (
      request_id TEXT PRIMARY KEY, previous_hash BLOB NOT NULL, reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coordinator_policy (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), fixtures TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coordinator_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, request_id TEXT, detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS coordinator_used_capabilities (capability_hash BLOB PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS coordinator_hotfix (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      hotfix_id TEXT NOT NULL, candidate TEXT NOT NULL, holder_id TEXT
    );
    CREATE TABLE IF NOT EXISTS coordinator_release_authorizations (
      request_id TEXT NOT NULL, generation INTEGER NOT NULL, record TEXT NOT NULL,
      PRIMARY KEY (request_id, generation)
    );
    INSERT OR IGNORE INTO coordinator_used_capabilities SELECT capability_hash FROM coordinator_grants;
    INSERT OR IGNORE INTO coordinator_used_capabilities SELECT capability_hash FROM coordinator_authority;
    INSERT OR IGNORE INTO coordinator_used_capabilities SELECT previous_hash FROM coordinator_quarantine;`);
  const columns = new Set(db.prepare('PRAGMA table_info(coordinator_grants)').all().map((column) => column.name));
  const hotfixColumns = new Set(db.prepare('PRAGMA table_info(coordinator_hotfix)').all().map((column) => column.name));
  for (const column of ['signer', 'approval_ref']) {
    if (!hotfixColumns.has(column)) db.exec(`ALTER TABLE coordinator_hotfix ADD COLUMN ${column} TEXT`);
  }
  for (const column of ['requested_at', 'claimed_at']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE coordinator_grants ADD COLUMN ${column} TEXT`);
  }
  if (!columns.has('generation')) {
    db.exec('ALTER TABLE coordinator_grants ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE coordinator_grants ADD COLUMN grant_fenced INTEGER NOT NULL DEFAULT 0');
    for (const row of db.prepare("SELECT id FROM coordinator_grants WHERE state = 'held' ORDER BY sequence").all()) {
      const generation = audit(db, 'grant-migrated', row.id, {});
      db.prepare('UPDATE coordinator_grants SET generation = ? WHERE id = ?').run(generation, row.id);
    }
  }
  // Existing clients read the compatibility view, but only capacity-aware clients can write.
  db.exec(`ALTER TABLE coordinator_grants RENAME TO coordinator_grants_v5;
    CREATE VIEW coordinator_grants AS SELECT * FROM coordinator_grants_v5;
    CREATE TABLE coordinator_critical_tests (
      test_id TEXT PRIMARY KEY, candidate TEXT NOT NULL, approval_ref TEXT NOT NULL,
      staging_id TEXT UNIQUE, generation INTEGER, receipt_sha256 TEXT
    );`);
  db.exec(`PRAGMA user_version = ${storeVersion}`);
}

function authenticate(db, id, capability) {
  if (!uuid.test(id ?? '') || !capabilityPattern.test(capability ?? '')) throw new Error('Invalid request credentials.');
  const row = db.prepare('SELECT * FROM coordinator_grants_v5 WHERE id = ?').get(id);
  if (!row || !timingSafeEqual(Buffer.from(row.capability_hash), hash(capability))) {
    throw new Error('Invalid request credentials.');
  }
  return row;
}

function transaction(db, work, mode = 'IMMEDIATE') {
  db.exec(`BEGIN ${mode}`);
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function requireAuthority(db, capability) {
  const row = db.prepare('SELECT epoch, capability_hash FROM coordinator_authority WHERE singleton = 1').get();
  if (!row || !timingSafeEqual(Buffer.from(row.capability_hash), hash(capability))) throw new Error('Invalid supervisor credentials.');
  return row;
}

const now = () => new Date().toISOString();
const pruneAfterMs = 7 * 86400000;

// Seconds in the current state, so a stalled holder or abandoned queued request stands out.
function age(row) {
  const since = row.state === 'held' ? row.claimed_at : row.state === 'queued' ? row.requested_at : null;
  return since ? Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000)) : null;
}

function audit(db, event, requestId, detail) {
  return db.prepare('INSERT INTO coordinator_audit (event, request_id, detail) VALUES (?, ?, ?)')
    .run(event, requestId, JSON.stringify(detail)).lastInsertRowid;
}

function hotfixHandoff(db) {
  return db.prepare(`SELECT h.*, r.state AS hotfix_state FROM coordinator_hotfix h
    JOIN coordinator_grants_v5 r ON r.id = h.hotfix_id WHERE h.singleton = 1`).get();
}

function handoffInProgress(handoff) {
  return handoff?.holder_id && ['queued', 'held'].includes(handoff.hotfix_state);
}

function requireMatchingReleasePriority(handoff, id, record) {
  if (handoff?.hotfix_id === id) {
    if (record.mode !== 'hotfix' || record.new !== handoff.candidate
        || !['owner', 'mark'].includes(handoff.signer) || !handoff.approval_ref
        || record.hotfix_signer !== (handoff.signer === 'mark' ? 'Mark Berg' : 'owner')
        || record.hotfix_approval_ref !== handoff.approval_ref) {
      throw new Error('Release authorization does not match priority hotfix.');
    }
  } else if (record.mode === 'hotfix') {
    throw new Error('Priority hotfix authorization required.');
  }
}

function finishRequest(db, id) {
  db.prepare('DELETE FROM coordinator_hotfix WHERE holder_id = ? OR (hotfix_id = ? AND holder_id IS NULL)').run(id, id);
}

function requireGeneration(row, value) {
  if (!/^[1-9][0-9]*$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) !== row.generation) {
    throw new Error('Stale or missing grant generation.');
  }
}

function queueRank(id, handoff) {
  if (id === handoff?.hotfix_id && handoff.hotfix_state === 'queued') return 0;
  if (id === handoff?.holder_id) return 1;
  return 2;
}

function policyRevision(db) {
  return db.prepare("SELECT COALESCE(MAX(sequence), 0) AS revision FROM coordinator_audit WHERE event = 'policy-sync'").get().revision;
}

function reserveCapability(db, capability) {
  const digest = hash(capability);
  if (db.prepare('SELECT 1 FROM coordinator_used_capabilities WHERE capability_hash = ?').get(digest)) {
    throw new Error('Capability was previously used.');
  }
  db.prepare('INSERT INTO coordinator_used_capabilities VALUES (?)').run(digest);
}

function safeRef(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value.trim();
}

function releaseRecord(value) {
  let record;
  try { record = JSON.parse(value); } catch { throw new Error('Invalid release authorization.'); }
  const required = ['version', 'generation', 'old', 'build', 'new', 'tree', 'local_ref', 'remote', 'url', 'ref',
    'selected', 'approvals', 'excluded', 'source_ref', 'mode'];
  const optional = ['hotfix_signer', 'hotfix_approval_ref'];
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || required.some((key) => !Object.hasOwn(record, key))
      || Object.keys(record).some((key) => ![...required, ...optional].includes(key))
      || record.version !== 1 || !Number.isSafeInteger(record.generation) || record.generation < 1
      || ![record.old, record.new, record.tree].every((value) => typeof value === 'string' && commitPattern.test(value))
      || !Array.isArray(record.selected) || !record.selected.length || record.selected.length > 64
      || record.selected.some((value) => typeof value !== 'string' || !commitPattern.test(value))
      || new Set(record.selected).size !== record.selected.length
      || !Array.isArray(record.approvals) || record.approvals.length !== record.selected.length
      || !Array.isArray(record.excluded) || record.excluded.length > 256
      || record.excluded.some((value) => typeof value !== 'string' || !commitPattern.test(value))
      || new Set(record.excluded).size !== record.excluded.length
      || record.excluded.some((value) => record.selected.includes(value))) throw new Error('Invalid release authorization.');
  for (const approval of record.approvals) safeRef(approval, 'changeset approval');
  safeRef(record.build, 'deployed build');
  let safeUrl = false;
  try {
    const url = new URL(record.url);
    safeUrl = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    safeUrl = typeof record.url === 'string' && /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(record.url);
  }
  if (record.remote !== 'origin' || record.ref !== 'refs/heads/Development'
      || typeof record.local_ref !== 'string' || !/^refs\/heads\/cpd-scoped\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(record.local_ref)
      || typeof record.url !== 'string' || record.url.length > 512 || /[\x00-\x20\x7f]/.test(record.url)
      || !safeUrl) throw new Error('Invalid release destination.');
  if (record.mode === 'scoped') {
    if (record.source_ref !== 'refs/heads/Development' || optional.some((key) => Object.hasOwn(record, key))) throw new Error('Invalid scoped authorization.');
  } else if (record.mode === 'hotfix') {
    if (typeof record.source_ref !== 'string' || !record.source_ref.startsWith('refs/heads/cpd-hotfix/')
        || !['owner', 'Mark Berg'].includes(record.hotfix_signer)) throw new Error('Invalid hotfix authorization.');
    safeRef(record.hotfix_approval_ref, 'hotfix approval');
  } else throw new Error('Invalid release mode.');
  return record;
}

function refuseCredentialInAudit(db, value) {
  const used = db.prepare('SELECT 1 FROM coordinator_used_capabilities WHERE capability_hash = ?');
  for (const match of value.matchAll(/(?=([a-f0-9]{64}))/g)) {
    if (used.get(hash(match[1]))) throw new Error('Approval or checkpoint evidence must not contain credentials.');
  }
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || !policy.fixtures || typeof policy.fixtures !== 'object' || Array.isArray(policy.fixtures)) {
    throw new Error('Invalid fixture policy.');
  }
  const fixtures = Object.create(null);
  for (const [resource, method] of Object.entries(policy.fixtures)) {
    if (!/^resource:[a-z0-9][a-z0-9._-]{0,127}$/.test(resource)) throw new Error('Invalid fixture resource.');
    fixtures[resource] = safeRef(method, 'fixture cleanup method');
  }
  return Object.fromEntries(Object.entries(fixtures).sort(([a], [b]) => a.localeCompare(b)));
}

function fixturePolicy(db) {
  const policy = db.prepare('SELECT fixtures FROM coordinator_policy WHERE singleton = 1').get();
  return policy ? JSON.parse(policy.fixtures) : {};
}

function readEvidence(path, required, label) {
  if (!path) throw new Error(`${label} evidence is required.`);
  let evidence;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 65536) throw new Error('invalid');
    evidence = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Invalid ${label.toLowerCase()} evidence file.`);
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || Object.keys(evidence).length !== required.length || required.some((name) => !Object.hasOwn(evidence, name))) {
    throw new Error(`${label} evidence must match all required resources.`);
  }
  return evidence;
}

function cleanupRecord(item, method) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || item.method !== method) {
    throw new Error('Fixture cleanup method does not match policy.');
  }
  return { method: item.method, ref: safeRef(item.ref, 'cleanup evidence reference') };
}

function cleanupEvidence(db, row, path) {
  const fixtures = fixturePolicy(db);
  const required = JSON.parse(row.resources).filter((resource) => Object.hasOwn(fixtures, resource));
  if (!required.length && !path) return {};
  const evidence = readEvidence(path, required, 'Fixture cleanup');
  const clean = Object.create(null);
  for (const name of required) {
    clean[name] = cleanupRecord(evidence[name], fixtures[name]);
  }
  return clean;
}

function checkpointEvidence(db, resources, path) {
  const fixtures = fixturePolicy(db);
  const evidence = readEvidence(path, resources, 'Checkpoint');
  return Object.fromEntries(resources.map((name) => [name, Object.hasOwn(fixtures, name)
    ? cleanupRecord(evidence[name], fixtures[name])
    : safeRef(evidence[name], 'checkpoint reference')]));
}

function criticalReceipt(path, candidate) {
  const file = lstatSync(path);
  if (!file.isFile() || file.size > 65536) throw new Error('Invalid Critical test receipt file.');
  const raw = readFileSync(path);
  const run = JSON.parse(raw);
  if (run?.outcome !== 'green' || run.source_revision !== candidate || run.source_dirty !== false
      || run.child_exit !== 0 || run.skips !== 0 || !Number.isSafeInteger(run.expected_tests)
      || run.expected_tests < 1 || run.actual_tests !== run.expected_tests
      || !Number.isSafeInteger(run.database_oid) || run.database_oid < 1) {
    throw new Error('Critical priority requires a passing exact-candidate test receipt.');
  }
  return hash(raw).toString('hex');
}

async function readCapabilities(count) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (input.length > 256) throw new Error('Invalid request credentials.');
  }
  const capabilities = input.trim().split(/\r?\n/);
  if (capabilities.length !== count || capabilities.some((value) => !capabilityPattern.test(value))) throw new Error('Invalid request credentials.');
  return capabilities;
}

export async function coordinate(args, { loadPolicy } = {}) {
  const [command, ...values] = args;
  const root = gitPath('--show-toplevel');
  const commonDir = gitPath('--git-common-dir');
  try {
    lstatSync(join(dirname(commonDir), '.coordinator', 'state.sqlite3'));
    throw new Error('This project has an existing Coordinator store. Use its designated authority.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const counts = { status: [0], audit: [0], 'authority-init': [0], 'policy-sync': [0],
    handoff: [1], quarantine: [2], recover: [2, 3], withdraw: [2], claim: [1], release: [1, 2, 3],
    cancel: [1], 'check-held': [2, 3], 'authorize-hotfix': [4], 'checkpoint-hotfix': [3],
    'authorize-release': [2], 'release-check': [4], 'authorize-critical-test': [3],
    'request-hotfix-priority': [4] };
  if (command !== 'request' && !Object.hasOwn(counts, command)) {
    throw new Error(`Usage: coordinator request|${Object.keys(counts).join('|')}`);
  }
  if (counts[command] && !counts[command].includes(values.length)) throw new Error('Invalid Coordinator arguments.');
  const secretCount = ['handoff', 'recover', 'request-hotfix-priority'].includes(command) ? 2
    : ['authority-init', 'policy-sync', 'quarantine', 'withdraw', 'claim', 'release', 'cancel',
      'check-held', 'authorize-hotfix', 'checkpoint-hotfix', 'authorize-release', 'release-check',
      'authorize-critical-test'].includes(command) ? 1 : 0;
  const secrets = secretCount ? await readCapabilities(secretCount) : [];
  const [capability, nextCapability] = secrets;
  let owner;
  let newResources;
  if (command === 'request') {
    [owner] = values;
    if (!owner || owner.length > 120 || !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/.test(owner) || values.length < 2 || values.length > 65) {
      throw new Error('Request requires an owner and 1 to 64 resources.');
    }
    newResources = [...new Set(values.slice(1).map((value) => normalizeResource(value, root)))].sort();
    const pools = newResources.filter((resource) => odooPools.has(resource));
    if (pools.length && (pools.length > 1 || newResources.some((resource) => odooMaintenance.has(resource) || resource === staging))) {
      throw new Error('Use one isolated Odoo slot without maintenance or staging resources.');
    }
  }
  const db = openStore(commonDir);
  try {
    let proposedPolicy;
    let expectedPolicyRevision;
    if (command === 'policy-sync') {
      requireAuthority(db, capability);
      expectedPolicyRevision = policyRevision(db);
      proposedPolicy = validatePolicy(await loadPolicy?.());
    }
    if (command === 'status') {
      return transaction(db, () => {
        const rows = db.prepare('SELECT id, owner, resources, state, requested_at, claimed_at, generation FROM coordinator_grants_v5 ORDER BY sequence').all();
        const quarantined = new Set(db.prepare('SELECT request_id FROM coordinator_quarantine').all().map((row) => row.request_id));
        const authority = db.prepare('SELECT epoch FROM coordinator_authority WHERE singleton = 1').get();
        const policy = db.prepare('SELECT fixtures FROM coordinator_policy WHERE singleton = 1').get();
        const handoff = hotfixHandoff(db);
        const suspended = handoffInProgress(handoff) ? handoff.holder_id : null;
        const priority = new Map(db.prepare('SELECT staging_id, candidate FROM coordinator_critical_tests WHERE staging_id IS NOT NULL')
          .all().map((entry) => [entry.staging_id, entry.candidate]));
        return { epoch: authority?.epoch ?? null, fixtures: policy ? JSON.parse(policy.fixtures) : {},
          requests: rows.map((row) => ({ ...row, state: quarantined.has(row.id) ? 'quarantined' : row.id === suspended ? 'suspended' : row.state,
            resources: JSON.parse(row.resources), age_seconds: age(row),
            ...(priority.has(row.id) ? { critical_candidate: priority.get(row.id),
              priority: row.id === handoff?.hotfix_id ? 'authorized' : 'requested' } : {}) })) };
      }, 'DEFERRED');
    }
    if (command === 'audit') {
      return transaction(db, () => ({ events: db.prepare('SELECT sequence, event, request_id, detail, created_at FROM coordinator_audit ORDER BY sequence').all()
        .map((row) => ({ ...row, detail: JSON.parse(row.detail) })) }), 'DEFERRED');
    }
    return transaction(db, () => {
      if (command === 'authority-init') {
        if (db.prepare('SELECT 1 FROM coordinator_authority WHERE singleton = 1').get()) throw new Error('Supervisor authority is already initialized.');
        reserveCapability(db, capability);
        db.prepare('INSERT INTO coordinator_authority VALUES (1, 1, ?)').run(hash(capability));
        audit(db, 'authority-init', null, { epoch: 1 });
        return { epoch: 1 };
      }
      if (command === 'handoff') {
        const authority = requireAuthority(db, capability);
        if (!/^[1-9][0-9]*$/.test(values[0]) || Number(values[0]) !== authority.epoch || capability === nextCapability) {
          throw new Error('Authority epoch or new capability is invalid.');
        }
        reserveCapability(db, nextCapability);
        const epoch = authority.epoch + 1;
        db.prepare('UPDATE coordinator_authority SET epoch = ?, capability_hash = ? WHERE singleton = 1').run(epoch, hash(nextCapability));
        audit(db, 'handoff', null, { from: authority.epoch, to: epoch });
        return { epoch };
      }
      if (command === 'policy-sync') {
        requireAuthority(db, capability);
        if (policyRevision(db) !== expectedPolicyRevision) throw new Error('Coordinator policy changed during sync. Retry from the project root.');
        const current = db.prepare('SELECT fixtures FROM coordinator_policy WHERE singleton = 1').get();
        const next = JSON.stringify(proposedPolicy);
        if ((!current || current.fixtures !== next)
            && db.prepare("SELECT 1 FROM coordinator_grants_v5 WHERE state IN ('queued', 'held') LIMIT 1").get()) {
          throw new Error('Cannot change fixture policy while requests are active.');
        }
        db.prepare('INSERT INTO coordinator_policy VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET fixtures = excluded.fixtures').run(next);
        audit(db, 'policy-sync', null, { fixtures: proposedPolicy });
        return { fixtures: proposedPolicy };
      }
      if (command === 'request') {
        const id = randomUUID();
        const capability = randomBytes(32).toString('hex');
        reserveCapability(db, capability);
        // Finished requests leave the queue after a week; the audit log keeps their history.
        db.prepare(`DELETE FROM coordinator_grants_v5 WHERE state IN ('released', 'cancelled')
          AND (requested_at IS NULL OR requested_at < ?)
          AND id NOT IN (SELECT hotfix_id FROM coordinator_hotfix)`)
          .run(new Date(Date.now() - pruneAfterMs).toISOString());
        db.prepare('INSERT INTO coordinator_grants_v5 (id, capability_hash, owner, resources, state, requested_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, hash(capability), owner, JSON.stringify(newResources), 'queued', now());
        return { id, capability, state: 'queued' };
      }
      const handoff = hotfixHandoff(db);
      if (command === 'authorize-critical-test') {
        requireAuthority(db, capability);
        const [id, candidate, reference] = values;
        if (!uuid.test(id) || !commitPattern.test(candidate)) throw new Error('Critical approval needs an exact candidate.');
        const test = db.prepare('SELECT resources, state FROM coordinator_grants_v5 WHERE id = ?').get(id);
        if (test?.state !== 'queued' || !JSON.parse(test.resources).includes(criticalOdoo)) {
          throw new Error('Critical approval needs a queued Critical test request.');
        }
        const approvalRef = safeRef(reference, 'Critical approval reference');
        refuseCredentialInAudit(db, approvalRef);
        db.prepare('INSERT INTO coordinator_critical_tests (test_id, candidate, approval_ref) VALUES (?, ?, ?)')
          .run(id, candidate, approvalRef);
        db.prepare('UPDATE coordinator_grants_v5 SET grant_fenced = 1 WHERE id = ?').run(id);
        audit(db, 'authorize-critical-test', id, { candidate, approvalRef });
        return { id, candidate, state: 'authorized' };
      }
      if (command === 'authorize-release') {
        requireAuthority(db, capability);
        const [id, input] = values;
        if (!uuid.test(id) || input.length > 65536) throw new Error('Invalid release authorization.');
        const record = releaseRecord(input);
        const serialized = JSON.stringify(record);
        refuseCredentialInAudit(db, serialized);
        const row = db.prepare('SELECT * FROM coordinator_grants_v5 WHERE id = ?').get(id);
        if (!row || row.state !== 'held' || !JSON.parse(row.resources).includes(staging)
            || row.generation !== record.generation
            || db.prepare('SELECT 1 FROM coordinator_quarantine WHERE request_id = ?').get(id)) {
          throw new Error('A current held staging grant is required.');
        }
        requireMatchingReleasePriority(handoff, id, record);
        db.prepare('INSERT INTO coordinator_release_authorizations (request_id, generation, record) VALUES (?, ?, ?)')
          .run(id, record.generation, serialized);
        audit(db, 'authorize-release', id, { generation: record.generation, mode: record.mode, candidate: record.new });
        return { id, generation: record.generation, mode: record.mode };
      }
      if (command === 'authorize-hotfix') {
        requireAuthority(db, capability);
        const [id, candidate, signer, reference] = values;
        if (!uuid.test(id) || !commitPattern.test(candidate) || !['owner', 'mark'].includes(signer)) {
          throw new Error('Hotfix approval requires an exact candidate and an owner or Mark sign-off.');
        }
        if (handoff) throw new Error('A staging hotfix is already authorized or awaiting holder resumption.');
        const hotfix = db.prepare('SELECT resources, state FROM coordinator_grants_v5 WHERE id = ?').get(id);
        if (hotfix?.state !== 'queued' || !JSON.parse(hotfix.resources).includes(staging)) {
          throw new Error('Only a queued staging request can be authorized as a hotfix.');
        }
        const tested = db.prepare('SELECT candidate FROM coordinator_critical_tests WHERE staging_id = ?').get(id);
        if (tested && tested.candidate !== candidate) throw new Error('Priority request has a different tested candidate.');
        const approvalRef = safeRef(reference, 'hotfix approval reference');
        refuseCredentialInAudit(db, approvalRef);
        refuseCredentialInAudit(db, candidate);
        db.prepare('INSERT INTO coordinator_hotfix (singleton, hotfix_id, candidate, signer, approval_ref) VALUES (1, ?, ?, ?, ?)').run(id, candidate, signer, approvalRef);
        audit(db, 'authorize-hotfix', id, { candidate, signer, approvalRef });
        return { id, candidate, state: 'authorized' };
      }
      if (command === 'withdraw') {
        requireAuthority(db, capability);
        if (!uuid.test(values[0] ?? '')) throw new Error('Invalid request ID.');
        const row = db.prepare('SELECT state FROM coordinator_grants_v5 WHERE id = ?').get(values[0]);
        if (!row) throw new Error('Unknown request.');
        if (row.state !== 'queued') throw new Error('Only queued requests can be withdrawn. Quarantine held requests instead.');
        if (handoffInProgress(handoff) && values[0] === handoff.holder_id) throw new Error('Cannot withdraw a suspended holder.');
        const stopRef = safeRef(values[1], 'withdrawal reference');
        db.prepare("UPDATE coordinator_grants_v5 SET state = 'cancelled' WHERE id = ?").run(values[0]);
        finishRequest(db, values[0]);
        audit(db, 'withdraw', values[0], { stopRef });
        return { state: 'cancelled' };
      }
      if (command === 'quarantine' || command === 'recover') {
        requireAuthority(db, capability);
        if (!uuid.test(values[0] ?? '')) throw new Error('Invalid request ID.');
        const row = db.prepare('SELECT * FROM coordinator_grants_v5 WHERE id = ?').get(values[0]);
        if (!row) throw new Error('Unknown request.');
        const quarantine = db.prepare('SELECT previous_hash FROM coordinator_quarantine WHERE request_id = ?').get(row.id);
        if (command === 'quarantine') {
          if (row.state !== 'held' || quarantine) throw new Error('Only held requests can be quarantined.');
          const reason = safeRef(values[1], 'quarantine reason');
          db.prepare('INSERT INTO coordinator_quarantine VALUES (?, ?, ?)').run(row.id, row.capability_hash, reason);
          db.prepare('UPDATE coordinator_grants_v5 SET capability_hash = ? WHERE id = ?').run(hash(randomBytes(32)), row.id);
          audit(db, 'quarantine', row.id, { reason });
          return { state: 'quarantined' };
        }
        const stopRef = safeRef(values[1], 'stop reference');
        if (row.state !== 'queued' && !(row.state === 'held' && quarantine)) throw new Error('Held requests must be quarantined before recovery.');
        const oldHash = quarantine ? quarantine.previous_hash : row.capability_hash;
        if (timingSafeEqual(Buffer.from(oldHash), hash(nextCapability))) throw new Error('Recovery requires a new request capability.');
        const cleanup = quarantine ? cleanupEvidence(db, row, values[2]) : {};
        if (!quarantine && values[2]) throw new Error('Queued recovery does not accept cleanup evidence.');
        reserveCapability(db, nextCapability);
        db.prepare("UPDATE coordinator_grants_v5 SET capability_hash = ?, state = 'queued', claimed_at = NULL WHERE id = ?").run(hash(nextCapability), row.id);
        db.prepare('DELETE FROM coordinator_quarantine WHERE request_id = ?').run(row.id);
        audit(db, 'recover', row.id, { stopRef, cleanup });
        return { state: 'queued' };
      }
      const row = authenticate(db, values[0], capability);
      const resources = JSON.parse(row.resources);
      const critical = resources.includes(criticalOdoo)
        ? db.prepare('SELECT * FROM coordinator_critical_tests WHERE test_id = ?').get(row.id)
        : null;
      if (command === 'request-hotfix-priority') {
        const [, generation, stagingId, evidence] = values;
        if (!critical || !uuid.test(stagingId)) throw new Error('An authorized Critical test and a staging request are required.');
        const staged = authenticate(db, stagingId, nextCapability);
        requireGeneration(row, generation);
        if (critical.staging_id === stagingId && critical.generation === row.generation) {
          return { id: stagingId, candidate: critical.candidate, state: 'requested' };
        }
        if (row.state !== 'held' || critical.staging_id || staged?.state !== 'queued'
            || staged.owner !== row.owner || !JSON.parse(staged.resources).includes(staging)
            || stagingId === handoff?.hotfix_id) {
          throw new Error('Priority needs a current Critical grant and its own queued staging request.');
        }
        const verified = criticalReceipt(evidence, critical.candidate);
        db.prepare('UPDATE coordinator_critical_tests SET staging_id = ?, generation = ?, receipt_sha256 = ? WHERE test_id = ?')
          .run(stagingId, row.generation, verified, row.id);
        audit(db, 'request-hotfix-priority', stagingId, { testId: row.id, candidate: critical.candidate, receipt: verified });
        return { id: stagingId, candidate: critical.candidate, state: 'requested' };
      }
      if (command === 'release-check') {
        const [, generation, candidate, mode] = values;
        if (row.state !== 'held' || !resources.includes(staging)
            || db.prepare('SELECT 1 FROM coordinator_quarantine WHERE request_id = ?').get(row.id)) {
          throw new Error('Current held staging grant required.');
        }
        requireGeneration(row, generation);
        const saved = db.prepare('SELECT record FROM coordinator_release_authorizations WHERE request_id = ? AND generation = ?')
          .get(row.id, row.generation);
        if (!saved) throw new Error('Release authorization missing.');
        const record = releaseRecord(saved.record);
        refuseCredentialInAudit(db, JSON.stringify(record));
        requireMatchingReleasePriority(handoff, row.id, record);
        if (record.new !== candidate || record.mode !== mode) throw new Error('Release candidate or mode mismatch.');
        return { ...record, project: commonDir, resource: staging, request: row.id };
      }
      if (command === 'check-held') {
        const resource = normalizeResource(values[1], root);
        if (row.state !== 'held' || !resources.includes(resource) || !row.generation
            || db.prepare('SELECT 1 FROM coordinator_quarantine WHERE request_id = ?').get(row.id)) {
          throw new Error('Request does not hold the specified resource.');
        }
        const candidate = values[2];
        if ((candidate !== undefined && !commitPattern.test(candidate))
            || (handoff?.hotfix_id === row.id && candidate !== handoff.candidate)
            || (critical && candidate !== critical.candidate)) {
          throw new Error('Hotfix grant does not match the exact authorized candidate.');
        }
        return { project: commonDir, id: row.id, generation: row.generation };
      }
      if (command === 'checkpoint-hotfix') {
        if (row.state !== 'held' || !resources.includes(staging)
            || !handoff || handoff.holder_id || handoff.hotfix_state !== 'queued') {
          throw new Error('A held staging grant and a queued authorized hotfix are required.');
        }
        requireGeneration(row, values[1]);
        const evidence = checkpointEvidence(db, resources, values[2]);
        refuseCredentialInAudit(db, JSON.stringify(evidence));
        db.prepare('UPDATE coordinator_hotfix SET holder_id = ? WHERE singleton = 1').run(row.id);
        db.prepare("UPDATE coordinator_grants_v5 SET state = 'queued', claimed_at = NULL WHERE id = ?").run(row.id);
        db.prepare('UPDATE coordinator_grants_v5 SET grant_fenced = 1 WHERE id IN (?, ?)').run(row.id, handoff.hotfix_id);
        audit(db, 'checkpoint-hotfix', row.id, { generation: row.generation, hotfix: handoff.hotfix_id, evidence });
        return { state: 'suspended' };
      }
      if (command === 'claim') {
        if (row.state === 'held') return { state: 'held', generation: row.generation };
        if (row.state !== 'queued') throw new Error('Only queued requests can be claimed.');
        if (handoffInProgress(handoff) && row.id === handoff.holder_id) return { state: 'queued' };
        const pool = resources.find((resource) => odooPools.has(resource));
        if (pool === criticalOdoo && !critical) return { state: 'queued' };
        const priorityRequested = db.prepare('SELECT 1 FROM coordinator_critical_tests WHERE staging_id = ?');
        if (row.id !== handoff?.hotfix_id && priorityRequested.get(row.id)) return { state: 'queued' };
        const rank = queueRank(row.id, handoff);
        const others = db.prepare(`SELECT g.id, g.sequence, g.state, g.resources, c.test_id AS critical_approved
          FROM coordinator_grants_v5 g LEFT JOIN coordinator_critical_tests c ON c.test_id = g.id
          WHERE g.id != ? AND g.state IN ('held', 'queued')`).all(row.id);
        let enqueuedInPool = 0;
        const blocked = others.some((other) => {
          const competing = JSON.parse(other.resources);
          if (other.state === 'queued' && ((competing.includes(criticalOdoo) && !other.critical_approved)
              || (other.id !== handoff?.hotfix_id && priorityRequested.get(other.id)))) return false;
          const otherRank = queueRank(other.id, handoff);
          if (other.state !== 'held' && !(otherRank < rank || (otherRank === rank && other.sequence < row.sequence))) return false;
          if (pool && competing.includes(pool)) enqueuedInPool += 1;
          return conflicts(resources, competing);
        });
        if (blocked || (pool && enqueuedInPool >= odooPools.get(pool))) return { state: 'queued' };
        const generation = audit(db, 'claim', row.id, {});
        db.prepare("UPDATE coordinator_grants_v5 SET state = 'held', claimed_at = ?, generation = ? WHERE id = ?")
          .run(now(), generation, row.id);
        if (row.id === handoff?.holder_id) finishRequest(db, row.id);
        return { state: 'held', generation };
      }
      if (command === 'release') {
        if (row.state !== 'held') throw new Error('Only held requests can be released.');
        const options = values.slice(1);
        const generation = options.at(-1)?.startsWith('--generation=') ? options.pop().slice('--generation='.length) : undefined;
        if (options.length > 1) throw new Error('Invalid release arguments.');
        if (row.grant_fenced || generation !== undefined) requireGeneration(row, generation);
        const cleanup = cleanupEvidence(db, row, options[0]);
        db.prepare("UPDATE coordinator_grants_v5 SET state = 'released' WHERE id = ?").run(row.id);
        finishRequest(db, row.id);
        audit(db, 'release', row.id, { cleanup });
        return { state: 'released' };
      }
      if (row.state !== 'queued') throw new Error('Only queued requests can be cancelled.');
      if (handoffInProgress(handoff) && row.id === handoff.holder_id) throw new Error('Cannot cancel a suspended holder.');
      db.prepare("UPDATE coordinator_grants_v5 SET state = 'cancelled' WHERE id = ?").run(row.id);
      finishRequest(db, row.id);
      audit(db, 'cancel', row.id, {});
      return { state: 'cancelled' };
    });
  } finally {
    db.close();
  }
}
