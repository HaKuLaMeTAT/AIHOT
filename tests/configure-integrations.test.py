import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('configure', Path(__file__).resolve().parents[1] / 'scripts/configure-integrations.py')
configure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configure)


class ConfigureTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.file = Path(self.folder.name) / 'env'

    def test_atomic_secret_update_preserves_provider_and_other_settings(self):
        self.file.write_text('# keep comment\nLLM_PROVIDER=codex\nLLM_API_KEY=\nDATABASE_URL=private-existing-value\n')
        configure.update_env(self.file, {'LLM_API_KEY': 'test-not-a-real-key', 'LLM_MODEL': 'deepseek-flash'})
        text = self.file.read_text()
        self.assertIn('LLM_PROVIDER=codex', text)
        self.assertIn('DATABASE_URL=private-existing-value', text)
        self.assertIn('# keep comment', text)
        self.assertEqual(text.count('LLM_API_KEY='), 1)
        self.assertEqual(os.stat(self.file).st_mode & 0o777, 0o600)
        self.assertFalse(list(self.file.parent.glob('.configure-*')))

    def test_duplicate_settings_are_replaced_once(self):
        self.file.write_text('LLM_PROVIDER=codex\nexport LLM_PROVIDER=codex\n')
        configure.update_env(self.file, {'LLM_PROVIDER': 'api'})
        self.assertEqual(self.file.read_text(), 'LLM_PROVIDER=api\n')

    def test_invalid_input_is_never_in_the_error(self):
        private = 'secret\nINJECTED=true'
        with patch.object(configure.getpass, 'getpass', return_value=private):
            with self.assertRaises(ValueError) as error:
                configure.secret('API Key')
        self.assertNotIn(private, str(error.exception))

    def test_failed_rename_preserves_existing_config(self):
        self.file.write_text('LLM_PROVIDER=codex\n')
        with patch.object(configure.os, 'replace', side_effect=OSError('read only')):
            with self.assertRaises(OSError):
                configure.update_env(self.file, {'LLM_PROVIDER': 'api'})
        self.assertEqual(self.file.read_text(), 'LLM_PROVIDER=codex\n')
        self.assertFalse(list(self.file.parent.glob('.configure-*')))


if __name__ == '__main__':
    unittest.main()
