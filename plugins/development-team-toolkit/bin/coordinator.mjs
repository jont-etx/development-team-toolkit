import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const hash = (value) => createHash('sha256').update(value).digest();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const capabilityPattern = /^[0-9a-f]{64}$/;

function gitPath(option) {
  try {
    return realpathSync(execFileSync('git', ['rev-parse', '--path-format=absolute', option], {
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
const storeVersion = 2;

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS requests (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      capability_hash BLOB NOT NULL,
      owner TEXT NOT NULL,
      resources TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'held', 'released', 'cancelled'))
    );`);
  {
    const existing = db.prepare("SELECT type FROM sqlite_master WHERE name = 'requests'").get();
    if (existing?.type === 'table') {
      db.exec('ALTER TABLE requests RENAME TO coordinator_requests');
      db.exec('CREATE VIEW requests AS SELECT * FROM coordinator_requests');
    }
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
    INSERT OR IGNORE INTO coordinator_used_capabilities SELECT capability_hash FROM coordinator_requests;
    INSERT OR IGNORE INTO coordinator_used_capabilities SELECT capability_hash FROM coordinator_authority;
    INSERT OR IGNORE INTO coordinator_used_capabilities SELECT previous_hash FROM coordinator_quarantine;`);
  }
  const columns = new Set(db.prepare('PRAGMA table_info(coordinator_requests)').all().map((column) => column.name));
  for (const column of ['requested_at', 'claimed_at']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE coordinator_requests ADD COLUMN ${column} TEXT`);
  }
  db.exec(`PRAGMA user_version = ${storeVersion}`);
}

function authenticate(db, id, capability) {
  if (!uuid.test(id ?? '') || !capabilityPattern.test(capability ?? '')) throw new Error('Invalid request credentials.');
  const row = db.prepare('SELECT * FROM coordinator_requests WHERE id = ?').get(id);
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
  db.prepare('INSERT INTO coordinator_audit (event, request_id, detail) VALUES (?, ?, ?)')
    .run(event, requestId, JSON.stringify(detail));
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

function cleanupEvidence(db, row, path) {
  const policy = db.prepare('SELECT fixtures FROM coordinator_policy WHERE singleton = 1').get();
  const fixtures = policy ? JSON.parse(policy.fixtures) : {};
  const required = JSON.parse(row.resources).filter((resource) => Object.hasOwn(fixtures, resource));
  if (!required.length && !path) return {};
  if (!path) throw new Error('Fixture cleanup evidence is required.');
  let evidence;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 65536) throw new Error('invalid');
    evidence = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Invalid fixture cleanup evidence file.');
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || Object.keys(evidence).length !== required.length || required.some((name) => !Object.hasOwn(evidence, name))) {
    throw new Error('Fixture cleanup evidence must match the claimed fixtures.');
  }
  const clean = Object.create(null);
  for (const name of required) {
    const item = evidence[name];
    if (!item || typeof item !== 'object' || Array.isArray(item) || item.method !== fixtures[name]) {
      throw new Error('Fixture cleanup method does not match policy.');
    }
    clean[name] = { method: item.method, ref: safeRef(item.ref, 'cleanup evidence reference') };
  }
  return clean;
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
  if (!['request', 'claim', 'release', 'cancel', 'status', 'audit', 'authority-init', 'handoff', 'quarantine', 'recover', 'withdraw', 'policy-sync'].includes(command)) {
    throw new Error('Usage: coordinator request|claim|release|cancel|status|audit|authority-init|handoff|quarantine|recover|withdraw|policy-sync');
  }
  const counts = { status: [0], audit: [0], 'authority-init': [0], 'policy-sync': [0], handoff: [1], quarantine: [2], recover: [2, 3], withdraw: [2], claim: [1], release: [1, 2], cancel: [1] };
  if (counts[command] && !counts[command].includes(values.length)) throw new Error('Invalid Coordinator arguments.');
  const secretCount = ['handoff', 'recover'].includes(command) ? 2
    : ['authority-init', 'policy-sync', 'quarantine', 'withdraw', 'claim', 'release', 'cancel'].includes(command) ? 1 : 0;
  const secrets = secretCount ? await readCapabilities(secretCount) : [];
  const [capability, nextCapability] = secrets;
  let owner;
  let resources;
  if (command === 'request') {
    [owner] = values;
    if (!owner || owner.length > 120 || !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/.test(owner) || values.length < 2 || values.length > 65) {
      throw new Error('Request requires an owner and 1 to 64 resources.');
    }
    resources = [...new Set(values.slice(1).map((value) => normalizeResource(value, root)))].sort();
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
        const rows = db.prepare('SELECT id, owner, resources, state, requested_at, claimed_at FROM coordinator_requests ORDER BY sequence').all();
        const quarantined = new Set(db.prepare('SELECT request_id FROM coordinator_quarantine').all().map((row) => row.request_id));
        const authority = db.prepare('SELECT epoch FROM coordinator_authority WHERE singleton = 1').get();
        const policy = db.prepare('SELECT fixtures FROM coordinator_policy WHERE singleton = 1').get();
        return { epoch: authority?.epoch ?? null, fixtures: policy ? JSON.parse(policy.fixtures) : {},
          requests: rows.map((row) => ({ ...row, state: quarantined.has(row.id) ? 'quarantined' : row.state,
            resources: JSON.parse(row.resources), age_seconds: age(row) })) };
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
            && db.prepare("SELECT 1 FROM coordinator_requests WHERE state IN ('queued', 'held') LIMIT 1").get()) {
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
        db.prepare("DELETE FROM coordinator_requests WHERE state IN ('released', 'cancelled') AND (requested_at IS NULL OR requested_at < ?)")
          .run(new Date(Date.now() - pruneAfterMs).toISOString());
        db.prepare('INSERT INTO coordinator_requests (id, capability_hash, owner, resources, state, requested_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, hash(capability), owner, JSON.stringify(resources), 'queued', now());
        return { id, capability, state: 'queued' };
      }
      if (command === 'withdraw') {
        requireAuthority(db, capability);
        if (!uuid.test(values[0] ?? '')) throw new Error('Invalid request ID.');
        const row = db.prepare('SELECT state FROM coordinator_requests WHERE id = ?').get(values[0]);
        if (!row) throw new Error('Unknown request.');
        if (row.state !== 'queued') throw new Error('Only queued requests can be withdrawn. Quarantine held requests instead.');
        const stopRef = safeRef(values[1], 'withdrawal reference');
        db.prepare("UPDATE coordinator_requests SET state = 'cancelled' WHERE id = ?").run(values[0]);
        audit(db, 'withdraw', values[0], { stopRef });
        return { state: 'cancelled' };
      }
      if (command === 'quarantine' || command === 'recover') {
        requireAuthority(db, capability);
        if (!uuid.test(values[0] ?? '')) throw new Error('Invalid request ID.');
        const row = db.prepare('SELECT * FROM coordinator_requests WHERE id = ?').get(values[0]);
        if (!row) throw new Error('Unknown request.');
        const quarantine = db.prepare('SELECT previous_hash FROM coordinator_quarantine WHERE request_id = ?').get(row.id);
        if (command === 'quarantine') {
          if (row.state !== 'held' || quarantine) throw new Error('Only held requests can be quarantined.');
          const reason = safeRef(values[1], 'quarantine reason');
          db.prepare('INSERT INTO coordinator_quarantine VALUES (?, ?, ?)').run(row.id, row.capability_hash, reason);
          db.prepare('UPDATE coordinator_requests SET capability_hash = ? WHERE id = ?').run(hash(randomBytes(32)), row.id);
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
        db.prepare("UPDATE coordinator_requests SET capability_hash = ?, state = 'queued', claimed_at = NULL WHERE id = ?").run(hash(nextCapability), row.id);
        db.prepare('DELETE FROM coordinator_quarantine WHERE request_id = ?').run(row.id);
        audit(db, 'recover', row.id, { stopRef, cleanup });
        return { state: 'queued' };
      }
      const row = authenticate(db, values[0], capability);
      if (command === 'claim') {
        if (row.state === 'held') return { state: 'held' };
        if (row.state !== 'queued') throw new Error('Only queued requests can be claimed.');
        const other = db.prepare("SELECT resources FROM coordinator_requests WHERE state = 'held' OR (state = 'queued' AND sequence < ?)").all(row.sequence);
        if (other.some((request) => conflicts(JSON.parse(row.resources), JSON.parse(request.resources)))) return { state: 'queued' };
        db.prepare("UPDATE coordinator_requests SET state = 'held', claimed_at = ? WHERE id = ?").run(now(), row.id);
        return { state: 'held' };
      }
      if (command === 'release') {
        if (row.state !== 'held') throw new Error('Only held requests can be released.');
        const cleanup = cleanupEvidence(db, row, values[1]);
        db.prepare("UPDATE coordinator_requests SET state = 'released' WHERE id = ?").run(row.id);
        audit(db, 'release', row.id, { cleanup });
        return { state: 'released' };
      }
      if (row.state !== 'queued') throw new Error('Only queued requests can be cancelled.');
      db.prepare("UPDATE coordinator_requests SET state = 'cancelled' WHERE id = ?").run(row.id);
      audit(db, 'cancel', row.id, {});
      return { state: 'cancelled' };
    });
  } finally {
    db.close();
  }
}
