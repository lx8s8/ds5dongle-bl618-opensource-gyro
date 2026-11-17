#!/usr/bin/env python3
"""Run required host checks and expose useful failure details in CI annotations."""
from pathlib import Path
import os
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
commands = [
    ['node', '--version'],
    ['make', '-C', 'tests', 'check'],
    ['make', '-C', 'tests', 'sanitize'],
    [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_pack*.py', '-v'],
    [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_manager_release_identity.py', '-v'],
]
for command in commands:
    result = subprocess.run(command, cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(result.stdout, end='', flush=True)
    if result.returncode:
        if os.environ.get('GITHUB_ACTIONS'):
            tail = '\n'.join(result.stdout.splitlines()[-60:])[-12000:]
            escaped = tail.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
            print('::error title=Host check failure details::' + escaped, flush=True)
        sys.exit(result.returncode)
