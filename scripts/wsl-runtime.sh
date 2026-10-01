#!/usr/bin/env bash
# Manage the private, headless WSL deployment. Never source or print the secret dotenv file.
set -euo pipefail
NEWS_REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
NEWS_RUNTIME=${NEWS_RUNTIME:-"$HOME/.local/share/news-runtime"}
NEWS_CONFIG=${NEWS_CONFIG:-"$HOME/.config/news-runtime"}
NEWS_NODEDIR=${NEWS_NODEDIR:-"$HOME/.nvm/versions/node/v24.21.0/bin"}
NEWS_PG_SOCKET="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/news-pg"
export PATH="$NEWS_NODEDIR:$HOME/.local/bin:$PATH"
export LD_LIBRARY_PATH="$NEWS_RUNTIME/pgsql/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
NEWS_PG="$NEWS_RUNTIME/pgsql/usr/lib/postgresql/16/bin"
check_storage() {
  if [[ -f "$NEWS_CONFIG/storage.json" ]]; then
    python3 "$NEWS_CONFIG/storage-guard.py" --config "$NEWS_CONFIG/storage.json"
  fi
}
case "${1:-status}" in
  install-units)
    NEWS_UNITS="$HOME/.config/systemd/user"
    mkdir -p "$NEWS_UNITS"
    python3 - "$NEWS_REPO" "$NEWS_UNITS" "$NEWS_RUNTIME" "$NEWS_CONFIG" "$NEWS_NODEDIR" "$HOME" <<'PY'
import sys, os, pwd, grp
from pathlib import Path
repo, units, runtime, config, node, home = sys.argv[1:]
storage=(Path(config)/'storage.json').exists()
(Path(config)/'storage-guard.py').write_text((Path(repo)/'scripts/check-storage.py').read_text())
(Path(config)/'runtime-ops.py').write_text((Path(repo)/'scripts/runtime-ops.py').read_text())
if storage:
 user=pwd.getpwuid(os.getuid()).pw_name
 group=grp.getgrgid(os.getgid()).gr_name
 p=Path(config)/'logrotate.conf'
 p.write_text(f'{runtime}/logs/*.log {{\n size 5M\n rotate 3\n compress\n delaycompress\n copytruncate\n missingok\n notifempty\n su {user} {group}\n}}\n')
 p.chmod(0o600)
for p in (runtime, config, node, home):
 if any(c.isspace() for c in p): raise SystemExit('Runtime paths must not contain whitespace')
for src in (Path(repo)/'deploy/wsl').iterdir():
 text=src.read_text()
 text=text.replace('@STORAGE_GUARD@','ExecStartPre=/usr/bin/python3 @CONFIG@/storage-guard.py --config @CONFIG@/storage.json --wait' if storage else '')
 text=text.replace('@STORAGE_TIMER@','Wants=news-logrotate.timer news-backup.timer news-capacity.timer' if storage else '')
 name=src.name.removesuffix('.service.in')
 text=text.replace('@STORAGE_LOG@',f'StandardOutput=append:@RUNTIME@/logs/{name}.log\nStandardError=inherit' if storage else '')
 for key,val in [('RUNTIME',runtime),('CONFIG',config),('NODEDIR',node),('HOME',home)]:text=text.replace('@'+key+'@',val)
 (Path(units)/src.name.removesuffix('.in')).write_text(text)
PY
    systemctl --user daemon-reload
    ;;
  sync)
    check_storage
    # Stop processing before replacing source files. Resume explicitly with start after checks.
    systemctl --user stop news-runtime.target
    rsync -a --exclude=.git --exclude='.env*' --exclude=.data --exclude=.runtime --exclude=node_modules --exclude=build --exclude=.react-router "$NEWS_REPO/" "$NEWS_RUNTIME/app/"
    systemctl --user start news-db.service
    ;;
  start) check_storage; systemctl --user start news-runtime.target ;;
  stop) systemctl --user stop news-runtime.target ;;
  restart) check_storage; systemctl --user restart news-runtime.target ;;
  enable) systemctl --user enable news-runtime.target ;;
  disable) systemctl --user disable news-runtime.target ;;
  status)
    check_storage
    node --env-file="$NEWS_CONFIG/env" "$NEWS_REPO/scripts/runtime-status.ts" "${@:2}"
    ;;
  configure-deepseek|configure-wechat|configure-wechat-template|configure-wechat-templates)
    python3 "$NEWS_REPO/scripts/configure-integrations.py" "${1#configure-}" --config "$NEWS_CONFIG/env"
    if [[ "$1" == configure-wechat* ]] && systemctl --user is-active --quiet news-worker.service; then
      systemctl --user restart news-api.service news-worker.service
    fi
    ;;
  model-check) check_storage; MODEL_CALLS_ENABLED=true node --env-file="$NEWS_CONFIG/env" "$NEWS_REPO/scripts/check-model.ts" "${@:2}" ;;
  deepseek-check) check_storage; MODEL_CALLS_ENABLED=true node --env-file="$NEWS_CONFIG/env" "$NEWS_REPO/scripts/check-model.ts" --provider deepseek --fresh --verification-file "$NEWS_CONFIG/deepseek-verified.json" ;;
  use-codex|use-deepseek)
    check_storage
    node --env-file="$NEWS_CONFIG/env" "$NEWS_REPO/scripts/switch-model.ts" "${1#use-}" --env-file "$NEWS_CONFIG/env"
    systemctl --user restart news-worker.service
    ;;
  wechat-test) check_storage; node --env-file="$NEWS_CONFIG/env" "$NEWS_REPO/scripts/test-wechat.ts" "${@:2}" --verification-file "$NEWS_CONFIG/wechat-verified.json" ;;
  wechat-menu) check_storage; node --env-file="$NEWS_CONFIG/env" "$NEWS_REPO/scripts/configure-wechat-menu.ts" "${@:2}" ;;
  wechat-callback-info) python3 "$NEWS_REPO/scripts/wechat-callback-info.py" --config "$NEWS_CONFIG/env" ;;
  wechat-callback-check) check_storage; node --env-file="$NEWS_CONFIG/env" "$NEWS_REPO/scripts/check-wechat-callback.ts" "${@:2}" ;;
  wechat-enable|wechat-disable)
    check_storage
    node --env-file="$NEWS_CONFIG/env" "$NEWS_REPO/scripts/enable-wechat.ts" "--${1#wechat-}" --env-file "$NEWS_CONFIG/env"
    python3 "$NEWS_REPO/scripts/configure-integrations.py" "${1#wechat-}-wechat" --config "$NEWS_CONFIG/env"
    systemctl --user restart news-api.service news-worker.service
    ;;
  backup)
    check_storage
    systemctl --user start news-backup.service
    ;;
  capacity) check_storage; systemctl --user start news-capacity.service ;;
  ops-status) check_storage; python3 "$NEWS_CONFIG/runtime-ops.py" status --runtime "$NEWS_RUNTIME" --config "$NEWS_CONFIG" ;;
  *) printf 'Usage: %s {install-units|sync|start|stop|restart|enable|disable|status [--json]|configure-deepseek|configure-wechat|configure-wechat-template|configure-wechat-templates|deepseek-check|use-codex|use-deepseek|model-check|wechat-test [--send]|wechat-menu [--apply]|wechat-callback-info|wechat-callback-check [--send]|wechat-enable|wechat-disable|backup|capacity|ops-status}\n' "$0" >&2; exit 2 ;;
esac
