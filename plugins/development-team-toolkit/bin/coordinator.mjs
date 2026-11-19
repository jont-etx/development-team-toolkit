import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
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
  db.exec(`PRAGMA busy_timeout = 10000;
    CREATE TABLE IF NOT EXISTS requests (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      capability_hash BLOB NOT NULL,
      owner TEXT NOT NULL,
      resources TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'held', 'released', 'cancelled'))
    );`);
  return db;
}

function authenticate(db, id, capability) {
  if (!uuid.test(id ?? '') || !capabilityPattern.test(capability ?? '')) throw new Error('Invalid request credentials.');
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!row || !timingSafeEqual(Buffer.from(row.capability_hash), hash(capability))) {
    throw new Error('Invalid request credentials.');
  }
  return row;
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function readCapability() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (input.length > 128) throw new Error('Invalid request credentials.');
  }
  const capability = input.trim();
  if (!capabilityPattern.test(capability)) throw new Error('Invalid request credentials.');
  return capability;
}

export async function coordinate(args) {
  const [command, ...values] = args;
  const root = gitPath('--show-toplevel');
  const commonDir = gitPath('--git-common-dir');
  if (!['request', 'claim', 'release', 'cancel', 'status'].includes(command)) {
    throw new Error('Usage: coordinator request <owner> <resource>... | claim|release|cancel <id> | status');
  }
  if (command === 'status' && values.length !== 0) throw new Error('Status takes no arguments.');
  if (['claim', 'release', 'cancel'].includes(command) && values.length !== 1) throw new Error('Request ID and capability on standard input are required.');
  const capability = ['claim', 'release', 'cancel'].includes(command) ? await readCapability() : undefined;
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
    if (command === 'status') {
      const rows = db.prepare('SELECT id, owner, resources, state FROM requests ORDER BY sequence').all();
      return { requests: rows.map((row) => ({ ...row, resources: JSON.parse(row.resources) })) };
    }
    return transaction(db, () => {
      if (command === 'request') {
        const id = randomUUID();
        const capability = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO requests (id, capability_hash, owner, resources, state) VALUES (?, ?, ?, ?, ?)')
          .run(id, hash(capability), owner, JSON.stringify(resources), 'queued');
        return { id, capability, state: 'queued' };
      }
      const row = authenticate(db, values[0], capability);
      if (command === 'claim') {
        if (row.state === 'held') return { state: 'held' };
        if (row.state !== 'queued') throw new Error('Only queued requests can be claimed.');
        const other = db.prepare("SELECT resources FROM requests WHERE state = 'held' OR (state = 'queued' AND sequence < ?)").all(row.sequence);
        if (other.some((request) => conflicts(JSON.parse(row.resources), JSON.parse(request.resources)))) return { state: 'queued' };
        db.prepare("UPDATE requests SET state = 'held' WHERE id = ?").run(row.id);
        return { state: 'held' };
      }
      if (command === 'release') {
        if (row.state !== 'held') throw new Error('Only held requests can be released.');
        db.prepare("UPDATE requests SET state = 'released' WHERE id = ?").run(row.id);
        return { state: 'released' };
      }
      if (row.state !== 'queued') throw new Error('Only queued requests can be cancelled.');
      db.prepare("UPDATE requests SET state = 'cancelled' WHERE id = ?").run(row.id);
      return { state: 'cancelled' };
    });
  } finally {
    db.close();
  }
}
