"""Discover Coordinator registrations and install the optional project bridge."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import tomllib


NAME = 'development-team-coordinator'
REPARSE_POINT = getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)


def git_path(option):
    result = subprocess.run(['git', 'rev-parse', '--path-format=absolute', option],
                            stdin=subprocess.DEVNULL, capture_output=True, text=True,
                            check=True, timeout=5)
    return Path(result.stdout.strip()).resolve(strict=True)


def details(path):
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


def servers(source):
    value = tomllib.loads(source.decode('utf-8')).get('mcp_servers', {})
    if not isinstance(value, dict) or any(not isinstance(entry, dict) for entry in value.values()):
        raise ValueError('Invalid Codex MCP configuration.')
    return value


def read_config(path):
    return path.read_bytes() if details(path) else b''


def matches(name, entry):
    args = entry.get('args', [])
    if not isinstance(args, list):
        raise ValueError('Invalid Codex MCP launch arguments.')
    launch = [entry.get('command'), entry.get('url'), *args]
    return ('coordinator' in name.lower()
            or any(isinstance(part, str) and re.search(r'coordinator|wiki[-_]mcp', part, re.I)
                   for part in launch))


def block(project, node):
    quoted = lambda value: json.dumps(str(value), ensure_ascii=False)
    script = Path(__file__).resolve().with_name('coordinator-mcp.py')
    args = ', '.join(quoted(part) for part in ('-I', '-B', script, project, node))
    return (f'\n\n[mcp_servers.{NAME}]\ncommand = {quoted(sys.executable)}\n'
            f'args = [{args}]\n').encode('utf-8')


def install(path, source, content):
    info = details(path.parent)
    if info and (not stat.S_ISDIR(info.st_mode) or getattr(info, 'st_file_attributes', 0) & REPARSE_POINT):
        raise ValueError('Project .codex must be a regular directory.')
    info = details(path)
    if info and (not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & REPARSE_POINT):
        raise ValueError('Project Codex config must be a regular file.')
    servers(content)
    path.parent.mkdir(exist_ok=True)
    lock = path.with_name('.toolkit-coordinator-setup.lock')
    with lock.open('xb'):
        pass
    temporary = None
    try:
        if read_config(path) != source:
            raise ValueError('Codex config changed during setup. Retry detection.')
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(content)
        if info:
            temporary.chmod(stat.S_IMODE(info.st_mode))
            if read_config(path) != source:
                raise ValueError('Codex config changed during setup. Retry detection.')
            os.replace(temporary, path)
        else:
            # Exclusive publication also protects a config created by another process.
            os.link(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        lock.unlink()


def setup(action, node):
    project = git_path('--show-toplevel')
    common = git_path('--git-common-dir')
    if Path.cwd().resolve() != project or common != project / '.git':
        raise ValueError('Run Coordinator setup from the primary Git checkout root.')
    config = project / '.codex' / 'config.toml'
    source = read_config(config)
    user = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex') / 'config.toml'
    configured = [{'scope': scope, 'name': name, 'enabled': entry.get('enabled', True)}
                  for scope, data in (('user', read_config(user)), ('project', source))
                  for name, entry in servers(data).items() if matches(name, entry)]
    cpd = details(project / '.coordinator' / 'state.sqlite3') is not None
    result = {'backend': 'cpd' if cpd else 'standalone', 'registrations': configured}
    if cpd or configured:
        return dict(result, status='existing' if configured else 'cpd-handoff-required')
    if action == 'status':
        return dict(result, status='available')
    if importlib.util.find_spec('mcp') is None:
        raise ValueError('Install the MCP SDK in the selected Python environment, then retry with --python.')
    install(config, source, source + block(project, node))
    return dict(result, status='installed', config=str(config), server=NAME)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('status', 'install'))
    parser.add_argument('--node', required=True)
    arguments = parser.parse_args()
    try:
        print(json.dumps(setup(arguments.action, arguments.node)))
    except tomllib.TOMLDecodeError:
        sys.exit('Cannot safely read or extend the Codex MCP configuration.')
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
