"""Run with a Python environment containing the MCP SDK."""

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


CLI = Path(__file__).resolve().parents[1] / 'plugins/development-team-toolkit/bin/toolkit.mjs'


async def check_wire(project, entry, run):
    params = StdioServerParameters(command=entry['command'], args=entry['args'], cwd=project)
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as session:
            await session.initialize()
            assert [tool.name for tool in (await session.list_tools()).tools] == ['coordinator_call']

            async def call(operation, payload, *, denied=False):
                reply = await session.call_tool('coordinator_call', {'operation': operation, 'payload': payload})
                assert reply.isError == denied, reply.content
                if not denied:
                    return reply.structuredContent['result']

            first = await call('request', {'owner': 'mcp', 'resources': ['resource:runner']})
            auth = {name: first[name] for name in ('id', 'capability')}
            assert (await call('claim', auth))['state'] == 'held'
            conflict = json.loads(run('coordinate', 'request', 'cli', 'resource:runner').stdout)
            status = await call('status', {})
            assert [entry['state'] for entry in status['requests']] == ['held', 'queued']
            assert first['capability'] not in json.dumps(status)
            await call('handoff', {}, denied=True)
            await call('release', auth, denied=False)
            assert (await call('claim', {key: conflict[key] for key in auth}))['state'] == 'held'


def main():
    with tempfile.TemporaryDirectory(prefix='toolkit-mcp-setup-') as directory:
        root = Path(directory)
        project, home = root / 'project with spaces', root / 'codex-home'
        home.mkdir()
        env = dict(os.environ, CODEX_HOME=str(home))
        subprocess.run(['git', 'init', '-q', str(project)], check=True)

        def run(*args):
            return subprocess.run(['node', str(CLI), *args], cwd=project, env=env,
                                  text=True, capture_output=True, check=True)

        def setup(action):
            return json.loads(run('coordinate', 'mcp', action, '--python', sys.executable).stdout)

        assert setup('status')['status'] == 'available'
        config = project / '.codex/config.toml'
        assert not config.exists()
        config.parent.mkdir()
        original = b'# preserved comment\n[mcp_servers.docs]\nurl = "https://example.invalid"\n'
        config.write_bytes(original)
        cpd = project / '.coordinator/state.sqlite3'
        cpd.parent.mkdir()
        cpd.touch()
        assert setup('install')['status'] == 'cpd-handoff-required'
        assert config.read_bytes() == original
        cpd.unlink()
        user_config = home / 'config.toml'
        user_config.write_text('[mcp_servers.existing]\ncommand = "coordinator-custom"\nenabled = false\n')
        existing = setup('install')
        assert existing['registrations'] == [{'scope': 'user', 'name': 'existing', 'enabled': False}]
        assert config.read_bytes() == original
        user_config.unlink()
        assert setup('install')['status'] == 'installed'
        installed = config.read_bytes()
        assert installed.startswith(original)
        assert setup('install')['status'] == 'existing'
        assert config.read_bytes() == installed
        assert not user_config.exists()
        server = tomllib.loads(installed.decode())['mcp_servers']['development-team-coordinator']
        if len(sys.argv) == 2:
            user_config.write_text(f'[projects.{json.dumps(str(project))}]\ntrust_level = "trusted"\n')
            result = subprocess.run([sys.argv[1], 'mcp', 'list', '--json'], cwd=project, env=env,
                                    text=True, capture_output=True, check=True, timeout=15)
            registered = json.loads(result.stdout)
            assert any(item['name'] == 'development-team-coordinator' for item in registered), registered
        config.unlink()
        assert setup('install')['status'] == 'installed'
        assert tomllib.loads(config.read_text())['mcp_servers']['development-team-coordinator'] == server
        asyncio.run(asyncio.wait_for(check_wire(project, server, run), timeout=30))
        print('PASS: project install, CPD and disabled-registration detection, no duplicate, actual MCP and CLI share one queue')


if __name__ == '__main__':
    main()
