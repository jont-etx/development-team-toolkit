"""Optional MCP transport for the project-scoped CPD Coordinator adapter."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import types
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations


OPERATIONS = frozenset({
    'status', 'request', 'claim', 'check', 'renew', 'release', 'cancel',
    'usage', 'override', 'recover', 'outbox', 'ack', 'refresh_usage',
    'items', 'item_create', 'item_update', 'browser_profiles',
})
MAX_PACKET = 65536
CODE = re.compile(r'^[A-Z][A-Z0-9_]{0,79}$')
REPARSE_POINT = getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)


def private_path(info, *, directory=False):
    regular = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    return (regular and not getattr(info, 'st_file_attributes', 0) & REPARSE_POINT
            and (os.name == 'nt' or (info.st_uid == os.geteuid() and not info.st_mode & 0o077)))


def read_authority(path: Path, common: Path, external: Path | None = None) -> str:
    directory = common
    if external is not None:
        if (not external.is_absolute() or external.resolve(strict=True) != external
                or external.is_relative_to(common.parent)
                or not private_path(external.lstat(), directory=True)):
            raise ValueError('INVALID_AUTHORITY_DIRECTORY')
        directory = external
    if not path.is_absolute() or (path.parent if external else path.parent.resolve(strict=True)) != directory:
        raise ValueError('INVALID_AUTHORITY_FILE')
    before = path.lstat()
    if not private_path(before) or (external is not None and before.st_nlink != 1):
        raise ValueError('INVALID_AUTHORITY_FILE')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (not private_path(opened) or (external is not None and opened.st_nlink != 1)
                or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)):
            raise ValueError('INVALID_AUTHORITY_FILE')
        raw = os.read(descriptor, 129)
    finally:
        os.close(descriptor)
    if len(raw) > 128:
        raise ValueError('INVALID_AUTHORITY_FILE')
    try:
        authority = raw.decode('ascii').strip()
    except UnicodeError as error:
        raise ValueError('INVALID_AUTHORITY_FILE') from error
    if not re.fullmatch(r'[0-9a-f]{64}', authority):
        raise ValueError('INVALID_AUTHORITY_FILE')
    return authority


def load_adapter():
    path = Path(__file__).resolve().with_name('cpd-coordinator.py')
    spec = importlib.util.spec_from_file_location('toolkit_cpd_coordinator', path)
    if spec is None or spec.loader is None:
        raise RuntimeError('ADAPTER_UNAVAILABLE')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_weekly_probe(path: Path, expected_hash: str):
    if not re.fullmatch(r'[0-9a-f]{64}', expected_hash):
        raise ValueError('INVALID_USAGE_ADAPTER_PIN')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > 1048576:
        raise ValueError('INVALID_USAGE_ADAPTER')
    source = path.read_bytes()
    if hashlib.sha256(source).hexdigest() != expected_hash:
        raise ValueError('USAGE_ADAPTER_PIN_MISMATCH')
    module = types.ModuleType('toolkit_weekly_usage')
    module.__file__ = str(path)
    exec(compile(source, str(path), 'exec'), module.__dict__)
    if not callable(getattr(module, 'probe', None)):
        raise ValueError('INVALID_USAGE_ADAPTER')
    return module.probe


def create_server(project: Path, backend: Path, backend_sha256: str, authority_file: Path,
                  weekly_usage: Path = None, weekly_usage_sha256: str = None,
                  authority_directory: Path | None = None):
    if (weekly_usage is None) != (weekly_usage_sha256 is None):
        raise ValueError('USAGE_ADAPTER_PIN_REQUIRED')
    module = load_adapter()
    adapter = module.Adapter(project, backend, backend_sha256)
    common = adapter.git_common_dir
    read_authority(authority_file, common, authority_directory)
    probe = load_weekly_probe(weekly_usage, weekly_usage_sha256) if weekly_usage else None
    server = FastMCP('development-team-cpd-coordinator')

    @server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False,
                                             idempotentHint=False, openWorldHint=False))
    def coordinator_call(operation: str, payload: dict) -> dict[str, Any]:
        """Call a CPD-compatible Coordinator operation with its original payload.

        Claims, usage snapshots, work records, and acknowledgements retain the
        existing Coordinator contract. Tokens are private. Fixture cleanup,
        messaging, wiki publication, and browser identity remain project-owned.
        Weekly telemetry refresh requires a separately configured trusted adapter.
        """
        try:
            if not isinstance(operation, str) or operation not in OPERATIONS or not isinstance(payload, dict):
                raise ValueError('INVALID_OPERATION')
            if len(json.dumps(payload, allow_nan=False).encode('utf-8')) > MAX_PACKET:
                raise ValueError('INPUT_TOO_LARGE')
            authority = read_authority(authority_file, common, authority_directory)
            if operation == 'refresh_usage':
                if payload:
                    raise ValueError('INVALID_INPUT')
                if probe is None:
                    raise ValueError('TRUSTED_USAGE_ADAPTER_UNAVAILABLE')
                adapter.call(authority, 'status', {})
                result = probe()
                adapter.call(authority, 'usage', {'snapshot': result})
            else:
                result = adapter.call(authority, operation, payload)
            if len(json.dumps(result, allow_nan=False).encode('utf-8')) > MAX_PACKET:
                raise ValueError('RESPONSE_TOO_LARGE_USE_SMALLER_PAGE')
            return {'operation': operation, 'result': result}
        except Exception as error:
            code = str(error)
            if not CODE.fullmatch(code):
                code = 'COORDINATOR_UNAVAILABLE'
            raise ValueError(code) from None

    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--backend', type=Path, required=True)
    parser.add_argument('--backend-sha256', required=True)
    parser.add_argument('--authority-file', type=Path, required=True)
    parser.add_argument('--authority-directory', type=Path)
    parser.add_argument('--weekly-usage', type=Path)
    parser.add_argument('--weekly-usage-sha256')
    args = parser.parse_args()
    create_server(args.project, args.backend, args.backend_sha256, args.authority_file,
                  args.weekly_usage, args.weekly_usage_sha256,
                  authority_directory=args.authority_directory).run(transport='stdio')


if __name__ == '__main__':
    main()
