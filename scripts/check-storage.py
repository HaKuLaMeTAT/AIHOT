"""Refuse runtime data access unless the configured D-drive metadata mount is present."""
import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path


def check_storage(config):
    mount = Path(config['mount'])
    if (mount / '.storage-id').read_text().strip() != config['volume_id']:
        raise ValueError('Data volume identity does not match')
    result = subprocess.run(
        ['findmnt', '--json', '--types', '9p', '--target', str(mount / '.storage-id'), '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS'],
        capture_output=True, text=True, check=True, timeout=5,
    )
    filesystem = json.loads(result.stdout)['filesystems'][0]
    def windows_path(value):
        return '\\'.join(part for part in value.replace('/', '\\').split('\\') if part).casefold()
    if (filesystem['target'] != str(mount)
            or windows_path(filesystem['source']) != windows_path(config['source'])
            or filesystem['fstype'] != '9p'
            or not re.search(r'(?:^|[,;])metadata(?:[,;]|$)', filesystem['options'])):
        raise ValueError('Expected D-drive metadata mount is absent')


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--config', required=True)
    args.add_argument('--wait', action='store_true')
    options = args.parse_args()
    config = json.loads(Path(options.config).read_text())
    deadline = time.monotonic() + (30 if options.wait else 0)
    while True:
        try:
            check_storage(config)
            return 0
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            if time.monotonic() >= deadline:
                print('D-drive data mount unavailable; refusing runtime data access', file=sys.stderr)
                return 1
            time.sleep(1)


if __name__ == '__main__':
    sys.exit(main())
