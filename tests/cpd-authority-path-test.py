"""Check external authority path handling in an environment with the MCP SDK."""

import os
from pathlib import Path
import runpy
from tempfile import TemporaryDirectory
import unittest


SERVER = Path(__file__).resolve().parents[1] / 'plugins/development-team-toolkit/bin/cpd-coordinator-mcp.py'
READ = runpy.run_path(str(SERVER))['read_authority']


class AuthorityPathTest(unittest.TestCase):
    def test_external_directory_is_explicit_and_file_is_direct_and_unlinked(self):
        with TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            common = base / 'project' / '.git'
            common.mkdir(parents=True)
            vault = base / 'private'
            vault.mkdir(mode=0o700)
            key = vault / 'authority.key'
            key.touch(mode=0o600)
            dummy = 'a' * 64
            key.write_text(dummy, encoding='ascii')
            self.assertEqual(READ(key, common, vault), dummy)
            with self.assertRaisesRegex(ValueError, 'INVALID_AUTHORITY_FILE'):
                READ(key, common)
            with self.assertRaisesRegex(ValueError, 'INVALID_AUTHORITY_DIRECTORY'):
                READ(key, common, common)
            nested = vault / 'nested'
            nested.mkdir(mode=0o700)
            with self.assertRaisesRegex(ValueError, 'INVALID_AUTHORITY_FILE'):
                READ(nested / 'authority.key', common, vault)
            os.link(key, vault / 'second-name.key')
            with self.assertRaisesRegex(ValueError, 'INVALID_AUTHORITY_FILE'):
                READ(key, common, vault)
            (vault / 'second-name.key').unlink()
            if os.name != 'nt':
                key.chmod(0o644)
                with self.assertRaisesRegex(ValueError, 'INVALID_AUTHORITY_FILE'):
                    READ(key, common, vault)
                key.chmod(0o600)
                vault.chmod(0o755)
                with self.assertRaisesRegex(ValueError, 'INVALID_AUTHORITY_DIRECTORY'):
                    READ(key, common, vault)


if __name__ == '__main__':
    unittest.main()
