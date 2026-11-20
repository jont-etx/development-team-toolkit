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


def claude_json(source):
    value = json.loads(source.decode('utf-8')) if source.strip() else {}
    if not isinstance(value, dict):
        raise ValueError('Invalid Claude Code MCP configuration.')
    return value


def claude_servers(value):
    entries = value.get('mcpServers', {})
    if not isinstance(entries, dict) or any(not isinstance(entry, dict) for entry in entries.values()):
        raise ValueError('Invalid Claude Code MCP configuration.')
    return entries


def claude_user_servers(source, project):
    """User and local-scope servers from ~/.claude.json; local scope is keyed by project path."""
    value = claude_json(source)
    found = [('user', name, entry) for name, entry in claude_servers(value).items()]
    projects = value.get('projects', {})
    if isinstance(projects, dict):
        for key, data in projects.items():
            if isinstance(data, dict) and os.path.normcase(Path(key).resolve()) == os.path.normcase(project):
                found += [('local', name, entry) for name, entry in claude_servers(data).items()]
    return found


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


def launch(project, node):
    script = Path(__file__).resolve().with_name('coordinator-mcp.py')
    return [str(part) for part in ('-I', '-B', script, project, node)]


def claude_block(source, project, node):
    value = claude_json(source)
    entries = dict(claude_servers(value))
    entries[NAME] = {'type': 'stdio', 'command': sys.executable, 'args': launch(project, node)}
    return (json.dumps(dict(value, mcpServers=entries), indent=2, ensure_ascii=False) + '\n').encode('utf-8')


def block(project, node):
    quoted = lambda value: json.dumps(str(value), ensure_ascii=False)
    args = ', '.join(quoted(part) for part in launch(project, node))
    return (f'\n\n[mcp_servers.{NAME}]\ncommand = {quoted(sys.executable)}\n'
            f'args = [{args}]\n').encode('utf-8')


def install(path, source, content, validate=servers, label='Codex'):
    info = details(path.parent)
    if info and (not stat.S_ISDIR(info.st_mode) or getattr(info, 'st_file_attributes', 0) & REPARSE_POINT):
        raise ValueError(f'Project {path.parent.name} must be a regular directory.')
    info = details(path)
    if info and (not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & REPARSE_POINT):
        raise ValueError(f'Project {label} config must be a regular file.')
    validate(content)
    path.parent.mkdir(exist_ok=True)
    lock = path.with_name('.toolkit-coordinator-setup.lock')
    with lock.open('xb'):
        pass
    temporary = None
    try:
        if read_config(path) != source:
            raise ValueError(f'{label} config changed during setup. Retry detection.')
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(content)
        if info:
            temporary.chmod(stat.S_IMODE(info.st_mode))
            if read_config(path) != source:
                raise ValueError(f'{label} config changed during setup. Retry detection.')
            os.replace(temporary, path)
        else:
            # Exclusive publication also protects a config created by another process.
            os.link(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        lock.unlink()


def claude_user_config():
    home = os.environ.get('CLAUDE_CONFIG_DIR')
    return Path(home) / '.claude.json' if home else Path.home() / '.claude.json'


def setup(action, node, runtime='codex'):
    project = git_path('--show-toplevel')
    common = git_path('--git-common-dir')
    if Path.cwd().resolve() != project or common != project / '.git':
        raise ValueError('Run Coordinator setup from the primary Git checkout root.')
    if runtime == 'claude':
        config = project / '.mcp.json'
        source = read_config(config)
        found = claude_user_servers(read_config(claude_user_config()), project)
        found += [('project', name, entry) for name, entry in claude_servers(claude_json(source)).items()]
        configured = [{'scope': scope, 'name': name, 'enabled': entry.get('enabled', True)}
                      for scope, name, entry in found if matches(name, entry)]
    else:
        config = project / '.codex' / 'config.toml'
        source = read_config(config)
        user = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex') / 'config.toml'
        configured = [{'scope': scope, 'name': name, 'enabled': entry.get('enabled', True)}
                      for scope, data in (('user', read_config(user)), ('project', source))
                      for name, entry in servers(data).items() if matches(name, entry)]
    legacy_store = details(project / '.coordinator' / 'state.sqlite3') is not None
    result = {'backend': 'legacy' if legacy_store else 'standalone', 'registrations': configured}
    if runtime == 'claude':
        result['runtime'] = 'claude'
    if legacy_store or configured:
        return dict(result, status='existing' if configured else 'legacy-handoff-required')
    if action == 'status':
        return dict(result, status='available')
    if importlib.util.find_spec('mcp') is None:
        raise ValueError('Install the MCP SDK in the selected Python environment, then retry with --python.')
    if runtime == 'claude':
        install(config, source, claude_block(source, project, node),
                lambda content: claude_servers(claude_json(content)), 'Claude Code MCP')
    else:
        install(config, source, source + block(project, node))
    return dict(result, status='installed', config=str(config), server=NAME)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('status', 'install'))
    parser.add_argument('--node', required=True)
    parser.add_argument('--runtime', choices=('codex', 'claude'), default='codex')
    arguments = parser.parse_args()
    try:
        print(json.dumps(setup(arguments.action, arguments.node, arguments.runtime)))
    except tomllib.TOMLDecodeError:
        sys.exit('Cannot safely read or extend the Codex MCP configuration.')
    except json.JSONDecodeError:
        sys.exit('Cannot safely read or extend the Claude Code MCP configuration.')
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
