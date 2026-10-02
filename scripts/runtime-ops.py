"""Bounded local backups and D-drive monitoring; never manage another project's services."""
import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

GIB = 1024 ** 3
ZONE = timezone(timedelta(hours=8))
DUMP_NAME = re.compile(r'^personal_hot-\d{8}-\d{6}\.dump$')


def atomic_json(file, value):
    temporary = file.with_name(file.name + '.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o600)
    temporary.replace(file)


def capacity_findings(free, used):
    findings = {}
    if free < 20 * GIB:
        findings['disk.free'] = {'level': 'critical' if free < 10 * GIB else 'warning',
                                 'detail': f'D 盘剩余 {free / GIB:.1f} GiB'}
    if used is not None and used > 5 * GIB:
        findings['disk.runtime'] = {'level': 'critical' if used > 10 * GIB else 'warning',
                                    'detail': f'个人热点数据占用 {used / GIB:.1f} GiB（含数据库、备份和日志）'}
    return findings


def update_alerts(state, findings, now):
    previous = state.get('alerts', {})
    current = {}
    # A bounded history supports notifications after a disabled transport is enabled.
    notices = [n for n in state.get('notices', []) if now - n['at'] < 30 * 86400
               or previous.get(n['key'], {}).get('since') == n['at']]
    for key in sorted(set(previous) | set(findings)):
        old, item = previous.get(key), findings.get(key)
        changed = bool(old) != bool(item) or (old and item and old['level'] != item['level'])
        if item:
            current[key] = {**item, 'since': now if changed else old['since'], 'notice_id': None if changed else old.get('notice_id')}
        if changed:
            level = item['level'] if item else 'recovered'
            detail = item['detail'] if item else f'{key} 已恢复'
            ident = hashlib.sha256(f'{key}:{level}:{now}'.encode()).hexdigest()[:24]
            notices.append({'id': ident, 'key': key, 'level': level, 'detail': detail, 'at': now,
                            'previous_id': old.get('notice_id') if old else None})
            if item:
                current[key]['notice_id'] = ident
            print(json.dumps({'event': 'runtime.alert', 'key': key, 'level': level, 'detail': detail}, ensure_ascii=False), flush=True)
    active = [n for n in notices if current.get(n['key'], {}).get('notice_id') == n['id']]
    history = [n for n in notices if n not in active]
    state['alerts'], state['notices'] = current, history[-(32 - len(active)):] + active


def verified_backups(folder, pg_restore, env):
    files = sorted((p for p in folder.iterdir() if DUMP_NAME.fullmatch(p.name) and p.is_file() and not p.is_symlink()), reverse=True)
    good = []
    for file in files:
        result = subprocess.run([str(pg_restore), '--list', str(file)], env=env, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=60)
        if result.returncode == 0:
            good.append(file)
    return good


def rotate_backups(folder, keep, pg_restore, env):
    # Only verified dumps with our precise name are eligible; rollback archives remain untouched.
    good = verified_backups(folder, pg_restore, env)
    for file in good[keep:]:
        file.unlink()


def make_backup(runtime, mount, state, now):
    free = shutil.disk_usage(mount).free
    root = runtime / 'backups'
    daily, weekly = root / 'daily', root / 'weekly'
    for folder in (daily, weekly):
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.fromtimestamp(now, ZONE).strftime('%Y%m%d-%H%M%S')
    final = daily / f'personal_hot-{stamp}.dump'
    partial = final.with_suffix('.dump.partial')
    pg = runtime / 'pgsql/usr/lib/postgresql/16/bin'
    env = {**os.environ, 'LD_LIBRARY_PATH': str(runtime / 'pgsql/usr/lib/x86_64-linux-gnu')}
    socket = os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}') + '/news-pg'
    size = subprocess.run([str(pg / 'psql'), '-h', socket, '-p', '55432', '-d', 'personal_hot', '-XAt', '-c',
                           'SELECT pg_database_size(current_database())'], env=env, capture_output=True, text=True,
                          check=True, timeout=30)
    if free < 10 * GIB + max(512 * 1024 ** 2, int(size.stdout.strip()) * 2):
        raise RuntimeError('Insufficient D-drive headroom; existing backups preserved')
    try:
        subprocess.run([str(pg / 'pg_dump'), '-h', socket, '-p', '55432', '-Fc', 'personal_hot', '-f', str(partial)],
                       env=env, check=True, timeout=1200, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run([str(pg / 'pg_restore'), '--list', str(partial)], env=env, check=True,
                       timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        partial.chmod(0o600)
        with partial.open('rb') as stream:
            os.fsync(stream.fileno())
        partial.replace(final)
        week = datetime.fromtimestamp(now, ZONE).strftime('%G-%V')
        if state.get('backup', {}).get('week') != week:
            week_file = weekly / final.name
            week_partial = week_file.with_suffix('.dump.partial')
            try:
                shutil.copyfile(final, week_partial)
                week_partial.chmod(0o600)
                with week_partial.open('rb') as stream:
                    os.fsync(stream.fileno())
                week_partial.replace(week_file)
            finally:
                week_partial.unlink(missing_ok=True)
        rotate_backups(daily, 7, pg / 'pg_restore', env)
        rotate_backups(weekly, 4, pg / 'pg_restore', env)
        # Only our interrupted partial dumps, and only after a new verified copy exists.
        for folder in (daily, weekly):
            for file in folder.glob('*.dump.partial'):
                if (DUMP_NAME.fullmatch(file.name.removesuffix('.partial')) and not file.is_symlink()
                        and now - file.stat().st_mtime > 2 * 86400):
                    file.unlink()
        state['backup'] = {'at': now, 'file': str(final), 'bytes': final.stat().st_size, 'week': week}
        state.pop('backup_error', None)
        print(json.dumps({'event': 'runtime.backup', **state['backup']}, ensure_ascii=False), flush=True)
    finally:
        partial.unlink(missing_ok=True)


def control_worker(state, free, operations, now):
    marker = operations / 'capacity-paused.json'
    if free < 5 * GIB:
        try:
            if not marker.exists():
                active = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'news-worker.service'], timeout=10).returncode == 0
                atomic_json(marker, {'at': now, 'resume': active})
        finally:
            # Even if a full disk prevents writing the marker, stop only our own worker.
            subprocess.run(['systemctl', '--user', 'stop', '--no-block', 'news-worker.service'], check=True, timeout=10)
        state['capacity_paused'] = True
    elif marker.exists() and free >= 10 * GIB:
        resume = json.loads(marker.read_text()).get('resume', False)
        # Keep the pause marker until space recovers above the hysteresis threshold.
        marker.unlink()
        if resume:
            result = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'news-runtime.target'], timeout=10)
            if result.returncode == 0:
                subprocess.run(['systemctl', '--user', 'start', '--no-block', 'news-worker.service'], check=True, timeout=10)
        state['capacity_paused'] = False


def check_runtime(runtime, mount, operations, state, now):
    free = shutil.disk_usage(mount).free
    state['disk_free_bytes'], state['checked_at'] = free, now
    control_worker(state, free, operations, now)
    # Walking the directory tree happens daily, while the hourly check uses filesystem counters.
    if now - state.get('size_checked_at', 0) >= 86400:
        state['size_checked_at'] = now
        try:
            result = subprocess.run(['du', '-sk', str(mount)], capture_output=True, text=True, check=True, timeout=120)
            state['runtime_bytes'] = int(result.stdout.split()[0]) * 1024
            state.pop('size_error', None)
        except (OSError, ValueError, IndexError, subprocess.SubprocessError):
            state['size_error'] = '目录容量统计失败；D 盘剩余空间检查仍有效，请检查 news-capacity.service'
    findings = capacity_findings(free, state.get('runtime_bytes'))
    if state.get('size_error'):
        findings['monitor.size'] = {'level': 'warning', 'detail': state['size_error']}
    backup = state.get('backup', {})
    if state.get('backup_error'):
        findings['backup.failed'] = {'level': 'critical', 'detail': state['backup_error']}
    if backup.get('file') and not Path(backup['file']).is_file():
        findings['backup.missing'] = {'level': 'critical', 'detail': '最近成功备份文件已丢失，请检查本地备份目录'}
    if now - backup.get('at', state.setdefault('started_at', now)) > 36 * 3600:
        findings['backup.stale'] = {'level': 'warning', 'detail': '超过 36 小时没有成功的本地备份'}
    if state.get('capacity_paused'):
        findings['worker.paused'] = {'level': 'critical', 'detail': 'D 盘空间低于 5 GiB，已暂停个人热点采集和分析；回升至 10 GiB 后恢复'}
    update_alerts(state, findings, now)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['check', 'backup', 'status'])
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    config = Path(args.config)
    # Refuse every read/write if the expected D-drive mount is absent.
    subprocess.run([sys.executable, str(config / 'storage-guard.py'), '--config', str(config / 'storage.json')], check=True, timeout=10)
    mount = Path(json.loads((config / 'storage.json').read_text())['mount'])
    runtime = Path(args.runtime)
    operations = runtime / 'data/operations'
    for folder in (runtime / 'data', runtime / 'backups'):
        if not folder.resolve().is_relative_to(mount.resolve()):
            raise RuntimeError('Runtime data and backups must resolve to the configured D-drive mount')
    operations.mkdir(mode=0o700, parents=True, exist_ok=True)
    state_file = operations / 'runtime-state.json'
    with (operations / '.lock').open('a') as lock:
        deadline = time.monotonic() + 180
        waiting = False
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if args.action != 'backup':
                    return 0
                if time.monotonic() >= deadline:
                    raise RuntimeError('Timed out waiting for the local backup lock')
                if not waiting:
                    print(json.dumps({'event': 'runtime.backup.waiting', 'detail': 'Waiting for the running capacity check'}), flush=True)
                    waiting = True
                time.sleep(0.25)
        # Both timers can fire at 03:00. A scheduled backup must not be silently skipped.
        state = json.loads(state_file.read_text()) if state_file.exists() else {}
        if args.action == 'status':
            print(json.dumps(state, ensure_ascii=False, indent=2))
            return 0
        now, failed = time.time(), False
        if args.action == 'backup':
            try:
                make_backup(runtime, mount, state, now)
            except (OSError, RuntimeError, subprocess.SubprocessError):
                state['backup_error'] = '本地备份失败或容量不足；最近已验证备份保留，请检查 news-backup.service'
                failed = True
        try:
            check_runtime(runtime, mount, operations, state, now)
        finally:
            atomic_json(state_file, state)
        return 1 if failed else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError):
        print('Personal news operations failed; check the data mount and service status', file=sys.stderr)
        sys.exit(1)
