import importlib.util
import fcntl
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runtime_ops', Path(__file__).resolve().parents[1] / 'scripts/runtime-ops.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class RuntimeOperationsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.calls = []

    def run_tool(self, args, **kwargs):
        self.calls.append(args)
        command = Path(args[0]).name
        code, output = 0, ''
        if command == 'psql':
            output = '1000\n'
        elif command == 'pg_dump':
            Path(args[-1]).write_bytes(b'valid')
        elif command == 'pg_restore':
            code = 0 if Path(args[-1]).read_bytes() == b'valid' else 1
        if kwargs.get('check') and code:
            raise subprocess.CalledProcessError(code, args)
        return subprocess.CompletedProcess(args, code, output)

    def prepare_main(self, action):
        config = self.root / 'config'
        config.mkdir()
        (config / 'storage.json').write_text(json.dumps({'mount': str(self.root)}))
        operations = self.root / 'data/operations'
        operations.mkdir(parents=True)
        (self.root / 'backups').mkdir()
        arguments = ['runtime-ops.py', action, '--runtime', str(self.root), '--config', str(config)]
        return operations, arguments

    def test_backup_waits_for_busy_lock_and_reads_latest_state(self):
        operations, arguments = self.prepare_main('backup')
        state_file = operations / 'runtime-state.json'
        ops.atomic_json(state_file, {'marker': 'before-check'})
        with (operations / '.lock').open('a') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            def finish_check(_):
                ops.atomic_json(state_file, {'marker': 'after-check'})
                fcntl.flock(held, fcntl.LOCK_UN)
            with patch.object(ops.sys, 'argv', arguments), \
                 patch.object(ops.subprocess, 'run', side_effect=self.run_tool), \
                 patch.object(ops.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 50 * ops.GIB})()), \
                 patch.object(ops, 'check_runtime'), patch.object(ops.time, 'sleep', side_effect=finish_check) as waiting, \
                 patch('builtins.print'):
                self.assertEqual(ops.main(), 0)
                waiting.assert_called_once()
        state = json.loads(state_file.read_text())
        self.assertEqual(state['marker'], 'after-check')
        self.assertEqual(Path(state['backup']['file']).read_bytes(), b'valid')

    def test_capacity_check_skips_busy_lock_without_overwriting_state(self):
        operations, arguments = self.prepare_main('check')
        state_file = operations / 'runtime-state.json'
        ops.atomic_json(state_file, {'marker': 'unchanged'})
        with (operations / '.lock').open('a') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(ops.sys, 'argv', arguments), \
                 patch.object(ops.subprocess, 'run', side_effect=self.run_tool), \
                 patch.object(ops, 'check_runtime') as check, patch.object(ops.time, 'sleep') as waiting:
                self.assertEqual(ops.main(), 0)
                check.assert_not_called()
                waiting.assert_not_called()
        self.assertEqual(json.loads(state_file.read_text()), {'marker': 'unchanged'})

    def test_backup_lock_timeout_fails_without_overwriting_state(self):
        operations, arguments = self.prepare_main('backup')
        state_file = operations / 'runtime-state.json'
        ops.atomic_json(state_file, {'marker': 'unchanged'})
        with (operations / '.lock').open('a') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(ops.sys, 'argv', arguments), \
                 patch.object(ops.subprocess, 'run', side_effect=self.run_tool), \
                 patch.object(ops.time, 'monotonic', side_effect=[0, 181]), \
                 patch.object(ops, 'make_backup') as backup:
                with self.assertRaisesRegex(RuntimeError, 'backup lock'):
                    ops.main()
                backup.assert_not_called()
        self.assertEqual(json.loads(state_file.read_text()), {'marker': 'unchanged'})

    def test_alert_thresholds_and_recovery_do_not_repeat(self):
        state = {}
        findings = ops.capacity_findings(19 * ops.GIB, 6 * ops.GIB)
        with patch('builtins.print'):
            ops.update_alerts(state, findings, 100)
            ops.update_alerts(state, findings, 200)
            self.assertEqual(len(state['notices']), 2)
            ops.update_alerts(state, ops.capacity_findings(9 * ops.GIB, 11 * ops.GIB), 300)
            self.assertEqual(len(state['notices']), 4)
            ops.update_alerts(state, {}, 400)
            ops.update_alerts(state, {}, 500)
        self.assertEqual(len(state['notices']), 6)
        self.assertEqual(state['alerts'], {})

    def test_active_alert_survives_notice_expiry(self):
        state = {}
        findings = ops.capacity_findings(19 * ops.GIB, None)
        with patch('builtins.print'):
            ops.update_alerts(state, findings, 100)
            ops.update_alerts(state, findings, 100 + 40 * 86400)
        self.assertEqual(len(state['notices']), 1)

    def test_active_alert_is_not_evicted_by_other_transitions(self):
        state = {}
        findings = ops.capacity_findings(19 * ops.GIB, None)
        with patch('builtins.print'):
            ops.update_alerts(state, findings, 100)
            ident = state['alerts']['disk.free']['notice_id']
            for i in range(80):
                extra = {'backup.failed': {'level': 'critical', 'detail': 'failed'}} if i % 2 else {}
                ops.update_alerts(state, {**findings, **extra}, 200 + i)
        self.assertLessEqual(len(state['notices']), 32)
        self.assertTrue(any(n['id'] == ident for n in state['notices']))

    def test_failed_directory_scan_does_not_disable_disk_or_backup_alerts(self):
        state = {'started_at': 1}
        with patch.object(ops.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 19 * ops.GIB})()), \
             patch.object(ops.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['du'])), patch('builtins.print'):
            ops.check_runtime(self.root, self.root, self.root, state, 200000)
        self.assertEqual(set(state['alerts']), {'disk.free', 'backup.stale', 'monitor.size'})

    def test_rotation_keeps_verified_copies_and_leaves_other_files(self):
        for i in range(10):
            (self.root / f'personal_hot-20250101-0000{i:02}.dump').write_bytes(b'valid')
        corrupt = self.root / 'personal_hot-20250201-000000.dump'
        corrupt.write_bytes(b'broken')
        rollback = self.root / 'cluster-before-d.tar.gz'
        rollback.write_bytes(b'rollback')
        with patch.object(ops.subprocess, 'run', side_effect=self.run_tool):
            ops.rotate_backups(self.root, 7, 'pg_restore', {})
        self.assertEqual(len(list(self.root.glob('*.dump'))), 8)
        self.assertTrue(corrupt.exists())
        self.assertTrue(rollback.exists())
        self.assertFalse((self.root / 'personal_hot-20250101-000000.dump').exists())

    def test_backup_success_creates_daily_and_weekly_verified_files(self):
        state = {}
        with patch.object(ops.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 50 * ops.GIB})()), \
             patch.object(ops.subprocess, 'run', side_effect=self.run_tool), patch('builtins.print'):
            ops.make_backup(self.root, self.root, state, 1700000000)
        self.assertEqual(len(list((self.root / 'backups/daily').glob('*.dump'))), 1)
        self.assertEqual(len(list((self.root / 'backups/weekly').glob('*.dump'))), 1)
        self.assertEqual(state['backup']['at'], 1700000000)
        self.assertEqual(Path(state['backup']['file']).stat().st_mode & 0o777, 0o600)
        self.assertFalse(list(self.root.rglob('*.partial')))

    def test_rejected_dump_never_rotates_existing_backups(self):
        daily = self.root / 'backups/daily'
        daily.mkdir(parents=True)
        for i in range(9):
            (daily / f'personal_hot-20250101-0000{i:02}.dump').write_bytes(b'valid')
        def reject(args, **kwargs):
            if Path(args[0]).name == 'pg_restore':
                raise subprocess.CalledProcessError(1, args)
            return self.run_tool(args, **kwargs)
        with patch.object(ops.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 50 * ops.GIB})()), \
             patch.object(ops.subprocess, 'run', side_effect=reject):
            with self.assertRaises(subprocess.CalledProcessError):
                ops.make_backup(self.root, self.root, {}, 1700000000)
        self.assertEqual(len(list(daily.glob('*.dump'))), 9)
        self.assertFalse(list(daily.glob('*.partial')))

    def test_low_headroom_refuses_dump(self):
        with patch.object(ops.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 10 * ops.GIB})()), \
             patch.object(ops.subprocess, 'run', side_effect=self.run_tool):
            with self.assertRaises(RuntimeError):
                ops.make_backup(self.root, self.root, {}, 1700000000)
        self.assertFalse(any(Path(c[0]).name == 'pg_dump' for c in self.calls))

    def test_pause_and_resume_hysteresis_only_manage_own_worker(self):
        state = {}
        with patch.object(ops.subprocess, 'run', side_effect=self.run_tool):
            ops.control_worker(state, 4 * ops.GIB, self.root, 100)
            ops.control_worker(state, 8 * ops.GIB, self.root, 200)
            self.assertTrue(state['capacity_paused'])
            self.assertFalse(any('start' in c for c in self.calls))
            ops.control_worker(state, 11 * ops.GIB, self.root, 300)
        self.assertFalse(state['capacity_paused'])
        self.assertEqual(self.calls[-1][-1], 'news-worker.service')
        self.assertTrue(all(c[-1] in ['news-worker.service', 'news-runtime.target'] for c in self.calls))

    def test_manually_stopped_worker_is_not_started_on_recovery(self):
        marker = self.root / 'capacity-paused.json'
        marker.write_text(json.dumps({'at': 100, 'resume': False}))
        with patch.object(ops.subprocess, 'run', side_effect=self.run_tool):
            ops.control_worker({}, 11 * ops.GIB, self.root, 200)
        self.assertEqual(self.calls, [])
        self.assertFalse(marker.exists())

    def test_full_disk_still_stops_own_worker(self):
        with patch.object(ops, 'atomic_json', side_effect=OSError('full')), \
             patch.object(ops.subprocess, 'run', side_effect=self.run_tool):
            with self.assertRaises(OSError):
                ops.control_worker({}, 0, self.root, 100)
        self.assertEqual(self.calls[-1], ['systemctl', '--user', 'stop', '--no-block', 'news-worker.service'])


if __name__ == '__main__':
    unittest.main()
