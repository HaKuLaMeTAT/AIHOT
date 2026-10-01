import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage_guard', Path(__file__).resolve().parents[1] / 'scripts/check-storage.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class StorageGuardTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.mount = Path(self.folder.name)
        (self.mount / '.storage-id').write_text('volume-identity')
        self.config = {'mount': str(self.mount), 'source': r'D:\personal-hot\.runtime', 'volume_id': 'volume-identity'}
        self.filesystem = {'target': str(self.mount), 'source': self.config['source'], 'fstype': '9p', 'options': 'rw,aname=drvfs;metadata;uid=1000'}

    def check(self):
        result = subprocess.CompletedProcess([], 0, json.dumps({'filesystems': [self.filesystem]}))
        with patch.object(guard.subprocess, 'run', return_value=result):
            guard.check_storage(self.config)

    def test_accepts_expected_metadata_mount(self):
        self.check()

    def test_accepts_equivalent_windows_path_separators(self):
        self.filesystem['source'] = self.config['source'].replace('\\', '\\\\').lower()
        self.check()

    def test_rejects_mount_without_metadata(self):
        self.filesystem['options'] = 'rw,aname=drvfs;uid=1000'
        with self.assertRaises(ValueError):
            self.check()

    def test_rejects_c_drive(self):
        self.filesystem['source'] = self.config['source'].replace('D:', 'C:')
        with self.assertRaises(ValueError):
            self.check()

    def test_rejects_unmounted_linux_directory(self):
        self.filesystem['fstype'] = 'ext4'
        with self.assertRaises(ValueError):
            self.check()

    def test_rejects_wrong_volume_identity(self):
        (self.mount / '.storage-id').write_text('another-volume')
        with self.assertRaises(ValueError):
            self.check()


if __name__ == '__main__':
    unittest.main()
