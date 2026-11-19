"""Opt-in CPD v1 adapter for a single project-local Coordinator store.

The caller supplies a trusted backend file and its SHA-256. The adapter retains
CPD records in place and fences older cooperative SQLite clients at handoff.
"""

import argparse
from contextlib import contextmanager
import hashlib
import hmac
import json
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import time
import types


class Refused(ValueError):
    """A stable refusal without secret material."""


OPERATIONS = frozenset({
    'status', 'request', 'claim', 'check', 'renew', 'release', 'cancel',
    'usage', 'override', 'recover', 'outbox', 'ack', 'items', 'item_create',
    'item_update', 'browser_profiles', 'enroll_browser_profiles',
})
TABLE_COLUMNS = {
    'metadata': {'key', 'value'},
    'requests': {'seq', 'id', 'owner', 'client', 'payload', 'hash', 'state',
                 'generation', 'expires', 'available', 'cycle',
                 'profile_admission_version', 'profile_grant_generation'},
    'overrides': {'request_id', 'provenance', 'expires', 'remaining'},
    'usage': {'id', 'snapshot'},
    'approvals': {'provenance', 'request_id', 'kind', 'detail'},
    'items': {'seq', 'id', 'owner', 'client', 'kind', 'state', 'revision',
              'hash', 'original', 'body'},
    'events': {'seq', 'id', 'kind', 'request_id', 'target', 'cycle', 'acknowledged'},
}
AUTHORITY_TABLE = 'toolkit_cpd_authority'
HEX = re.compile(r'^[0-9a-f]{64}$')


def credential_hash(authority):
    if not isinstance(authority, str) or not HEX.fullmatch(authority):
        raise Refused('INVALID_AUTHORITY')
    return hashlib.sha256(authority.encode('ascii')).hexdigest()


def open_existing(path):
    if not safe_location(path.parent, directory=True) or not safe_location(path):
        raise Refused('STORE_UNAVAILABLE')
    connection = sqlite3.connect(f'{path.as_uri()}?mode=rw', uri=True, timeout=5, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA busy_timeout=5000')
    connection.execute('PRAGMA synchronous=FULL')
    return connection


def safe_location(path, *, directory=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    return expected(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400


def validate_schema(connection):
    rows = connection.execute("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
    tables = {row['name'] for row in rows if row['type'] == 'table'}
    if tables != set(TABLE_COLUMNS):
        raise Refused('UNSUPPORTED_SCHEMA')
    for name, columns in TABLE_COLUMNS.items():
        found = {row['name'] for row in connection.execute(f'PRAGMA table_info("{name}")')}
        if found != columns:
            raise Refused('UNSUPPORTED_SCHEMA')
    row = connection.execute("SELECT value FROM metadata WHERE key='schema'").fetchone()
    if not row or row['value'] != '1' or connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise Refused('UNSUPPORTED_SCHEMA')
    triggers = {row['name'] for row in rows if row['type'] == 'trigger'}
    if not {'bridge_profile_request_v1', 'bridge_profile_grant_v1'}.issubset(triggers):
        raise Refused('UNSUPPORTED_SCHEMA')


def validate_backend(module):
    store = getattr(module, 'Store', None)
    error = getattr(module, 'Refused', None)
    if (not isinstance(store, type) or not isinstance(error, type) or not issubclass(error, ValueError)
            or not all(callable(getattr(store, method, None)) for method in {*OPERATIONS, '_connection'})):
        raise Refused('INCOMPATIBLE_BACKEND')


class Adapter:
    def __init__(self, project, backend_path, backend_sha256, *, clock=time.time):
        if not isinstance(backend_sha256, str) or not HEX.fullmatch(backend_sha256):
            raise Refused('INVALID_BACKEND_PIN')
        try:
            project = Path(project).resolve(strict=True)
            backend = Path(backend_path)
            if backend.is_symlink() or not backend.is_file():
                raise Refused('BACKEND_UNAVAILABLE')
            source = backend.read_bytes()
            if not hmac.compare_digest(hashlib.sha256(source).hexdigest(), backend_sha256):
                raise Refused('BACKEND_PIN_MISMATCH')
            common = subprocess.run(
                ['git', '-C', str(project), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5, check=True,
            ).stdout.strip()
            git_dir = Path(common).resolve(strict=True)
            if git_dir.name != '.git' or not git_dir.is_dir():
                raise Refused('PRIMARY_CHECKOUT_REQUIRED')
            if (git_dir / 'development-team-coordinator.sqlite').exists():
                raise Refused('STANDALONE_STORE_PRESENT')
            self.git_common_dir = git_dir
            self.database = git_dir.parent / '.coordinator' / 'state.sqlite3'
            if not safe_location(self.database.parent, directory=True) or not safe_location(self.database):
                raise Refused('STORE_UNAVAILABLE')
            module = types.ModuleType('_toolkit_cpd_backend')
            module.__file__ = str(backend.resolve())
            exec(compile(source, module.__file__, 'exec'), module.__dict__)
            validate_backend(module)
        except Refused:
            raise
        except (OSError, subprocess.SubprocessError, ValueError, SyntaxError) as error:
            raise Refused('ADAPTER_UNAVAILABLE') from error
        self.backend = module
        self.backend_sha256 = backend_sha256
        self.clock = clock

    def handoff(self, authority):
        digest = credential_hash(authority)
        try:
            connection = open_existing(self.database)
            try:
                connection.execute('BEGIN IMMEDIATE')
                exists = connection.execute("SELECT 1 FROM sqlite_master WHERE name=?", (AUTHORITY_TABLE,)).fetchone()
                if exists:
                    raise Refused('HANDOFF_ALREADY_COMPLETED')
                validate_schema(connection)
                connection.execute(
                    'CREATE TABLE toolkit_cpd_authority (singleton INTEGER PRIMARY KEY CHECK(singleton=1), '
                    'authority_hash TEXT NOT NULL, backend_sha256 TEXT NOT NULL)'
                )
                connection.execute('INSERT INTO toolkit_cpd_authority VALUES (1, ?, ?)',
                                   (digest, self.backend_sha256))
                for table in TABLE_COLUMNS:
                    for action in ('INSERT', 'UPDATE', 'DELETE'):
                        connection.execute(
                            f'CREATE TRIGGER toolkit_fence_{table}_{action.lower()} BEFORE {action} ON "{table}" '
                            'WHEN toolkit_cpd_authorized('
                            '(SELECT authority_hash FROM toolkit_cpd_authority WHERE singleton=1), '
                            '(SELECT backend_sha256 FROM toolkit_cpd_authority WHERE singleton=1)) <> 1 '
                            "BEGIN SELECT RAISE(ABORT, 'TOOLKIT_AUTHORITY_REQUIRED'); END"
                        )
                for action in ('INSERT', 'UPDATE', 'DELETE'):
                    connection.execute(
                        f'CREATE TRIGGER toolkit_fence_authority_{action.lower()} BEFORE {action} ON toolkit_cpd_authority '
                        "BEGIN SELECT RAISE(ABORT, 'TOOLKIT_AUTHORITY_IMMUTABLE'); END"
                    )
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
            finally:
                connection.close()
        except sqlite3.Error as error:
            raise Refused('STORE_UNAVAILABLE') from error
        return {'handoff': 'complete'}

    def call(self, authority, operation, payload):
        digest = credential_hash(authority)
        if operation not in OPERATIONS or not isinstance(payload, dict):
            raise Refused('INVALID_OPERATION')
        try:
            encoded = json.dumps(payload, allow_nan=False).encode('utf-8')
            if len(encoded) > 65536:
                raise Refused('INPUT_TOO_LARGE')
        except (TypeError, ValueError) as error:
            raise Refused('INVALID_INPUT') from error

        adapter = self

        class FencedStore(self.backend.Store):
            @contextmanager
            def _connection(self):
                connection = open_existing(adapter.database)
                try:
                    if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                                              (AUTHORITY_TABLE,)).fetchone():
                        raise Refused('HANDOFF_REQUIRED')
                    row = connection.execute(
                        'SELECT authority_hash, backend_sha256 FROM toolkit_cpd_authority WHERE singleton=1'
                    ).fetchone()
                    if (not row or not hmac.compare_digest(row['authority_hash'], digest)
                            or not hmac.compare_digest(row['backend_sha256'], adapter.backend_sha256)):
                        raise Refused('INVALID_AUTHORITY')
                    connection.create_function(
                        'toolkit_cpd_authorized', 2,
                        lambda stored, pin: int(isinstance(stored, str) and isinstance(pin, str)
                                                and hmac.compare_digest(stored, digest)
                                                and hmac.compare_digest(pin, adapter.backend_sha256)),
                    )
                    yield connection
                finally:
                    connection.close()

        try:
            store = FencedStore(self.database, clock=self.clock)
            result = getattr(store, operation)(**payload)
            if len(json.dumps(result, allow_nan=False).encode('utf-8')) > 65536:
                raise Refused('RESPONSE_TOO_LARGE')
            return result
        except Refused:
            raise
        except self.backend.Refused as error:
            raise Refused(str(error)) from error
        except (sqlite3.Error, TypeError, KeyError, ValueError, OSError) as error:
            raise Refused('INVALID_INPUT_OR_UNAVAILABLE') from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True)
    parser.add_argument('--backend', required=True)
    parser.add_argument('--backend-sha256', required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.read(65537)
        if len(raw.encode('utf-8')) > 65536:
            raise Refused('INPUT_TOO_LARGE')
        packet = json.loads(raw)
        if not isinstance(packet, dict):
            raise Refused('INVALID_INPUT')
        authority = packet.pop('authority', None)
        operation = packet.pop('op', None)
        adapter = Adapter(args.project, args.backend, args.backend_sha256)
        if operation == 'handoff':
            if packet:
                raise Refused('INVALID_INPUT')
            result = adapter.handoff(authority)
        else:
            result = adapter.call(authority, operation, packet)
        print(json.dumps({'ok': True, 'result': result}, allow_nan=False))
        return 0
    except Refused as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
    except (TypeError, ValueError, OSError):
        print(json.dumps({'ok': False, 'error': 'INVALID_INPUT_OR_UNAVAILABLE'}))
    return 2


if __name__ == '__main__':
    sys.exit(main())
