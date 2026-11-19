"""Expose routine standalone Coordinator operations over MCP stdio."""

import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

from mcp.server.fastmcp import FastMCP


def create_server(project, node):
    cli = Path(__file__).resolve().with_name('toolkit.mjs')
    server = FastMCP('development-team-coordinator')

    @server.tool()
    def coordinator_call(operation: str, payload: dict) -> dict[str, Any]:
        """Use the project queue. Status takes {}. Request takes owner and resources (strings).

        Claim, release and cancel take id and the private capability returned by request.
        Release can also take cleanup_evidence, a project-relative evidence file.
        Supervisor operations use the local toolkit CLI.
        """
        fields = {
            'status': set(), 'request': {'owner', 'resources'},
            'claim': {'id', 'capability'}, 'cancel': {'id', 'capability'},
            'release': {'id', 'capability'},
        }
        if operation not in fields or not isinstance(payload, dict):
            raise ValueError('Unsupported Coordinator operation.')
        required = fields[operation]
        allowed = required | ({'cleanup_evidence'} if operation == 'release' else set())
        if not required <= payload.keys() <= allowed:
            raise ValueError('Invalid Coordinator payload fields.')
        if len(json.dumps(payload, allow_nan=False).encode('utf-8')) > 65536:
            raise ValueError('Coordinator payload is too large.')

        args = [node, '--disable-warning=ExperimentalWarning', str(cli), 'coordinate', operation]
        credential = ''
        if operation == 'request':
            owner, resources = payload['owner'], payload['resources']
            if (not isinstance(owner, str) or not isinstance(resources, list)
                    or not 1 <= len(resources) <= 64
                    or any(not isinstance(resource, str) for resource in resources)):
                raise ValueError('Request needs an owner and a list of resource strings.')
            args += [owner, *resources]
        elif operation != 'status':
            credential = payload['capability']
            identifier = payload['id']
            evidence = payload.get('cleanup_evidence', '')
            if (not isinstance(credential, str) or not re.fullmatch(r'[0-9a-f]{64}', credential)
                    or not isinstance(identifier, str) or not isinstance(evidence, str)):
                raise ValueError('Invalid request credentials or cleanup evidence.')
            args.append(identifier)
            if 'cleanup_evidence' in payload:
                args.append(evidence)
        try:
            result = subprocess.run(args, cwd=project, input=credential, capture_output=True,
                                    text=True, encoding='utf-8', timeout=15)
        except (OSError, subprocess.SubprocessError) as error:
            raise ValueError('Coordinator command unavailable.') from error
        if result.returncode:
            raise ValueError(result.stderr.strip() or 'Coordinator refused the operation.')
        return {'operation': operation, 'result': json.loads(result.stdout)}

    return server


if __name__ == '__main__':
    create_server(Path(sys.argv[1]), sys.argv[2]).run(transport='stdio')
