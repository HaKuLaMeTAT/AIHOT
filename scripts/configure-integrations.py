"""Enter secrets in the user's local terminal, never in chat, argv or shell history."""
import argparse
import fcntl
import getpass
import os
import re
import sys
import tempfile
from pathlib import Path


def update_env(file, changes):
    # Preserve unrelated configuration, permissions and comments. Atomic replacement avoids partial reads.
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (file.parent / '.configure.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        lines = file.read_text().splitlines() if file.exists() else []
        remaining = dict(changes)
        result = []
        for line in lines:
            match = re.match(r'^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=', line)
            if match and match[1] in changes:
                if match[1] in remaining:
                    result.append(f'{match[1]}={remaining.pop(match[1])}')
            else:
                result.append(line)
        result.extend(f'{key}={value}' for key, value in remaining.items())
        descriptor, temporary = tempfile.mkstemp(prefix='.configure-', dir=file.parent)
        try:
            with os.fdopen(descriptor, 'w') as stream:
                stream.write('\n'.join(result) + '\n')
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, file)
        finally:
            Path(temporary).unlink(missing_ok=True)


def secret(label, minimum=1):
    value = getpass.getpass(f'{label}（隐藏输入）: ').strip()
    if not minimum <= len(value) <= 4096 or not re.fullmatch(r'[A-Za-z0-9_.:-]+', value):
        raise ValueError(f'{label} 为空或格式异常，未保存配置')
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('kind', choices=['deepseek', 'wechat', 'wechat-template', 'wechat-templates', 'use-codex', 'use-deepseek', 'enable-wechat', 'disable-wechat'])
    parser.add_argument('--config', default=str(Path.home() / '.config/news-runtime/env'))
    options = parser.parse_args()
    os.umask(0o077)
    if options.kind.startswith('use-'):
        update_env(Path(options.config).expanduser(), {'LLM_PROVIDER': 'codex' if options.kind == 'use-codex' else 'api'})
        return 0
    if options.kind.endswith('-wechat'):
        update_env(Path(options.config).expanduser(), {'WECHAT_PUSH_ENABLED': 'true' if options.kind == 'enable-wechat' else 'false'})
        return 0
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise ValueError('请在自己的 WSL 终端运行；不接受管道、参数或聊天中的密钥')
    if options.kind == 'wechat-templates':
        changes = {name: secret(label) for name, label in [
            ('WECHAT_AI_DAILY_TEMPLATE_ID', 'AI 日报模板 ID'),
            ('WECHAT_STOCK_DAILY_TEMPLATE_ID', '股市日报模板 ID'),
            ('WECHAT_URGENT_TEMPLATE_ID', '重大事件提醒模板 ID')]}
        changes.update({'WECHAT_SEPARATE_TEMPLATES': 'true', 'WECHAT_PUSH_ENABLED': 'false'})
    elif options.kind == 'wechat-template':
        changes = {'WECHAT_TEMPLATE_ID': secret('新的模板 ID'), 'WECHAT_PUSH_ENABLED': 'false'}
    elif options.kind == 'deepseek':
        key = secret('DeepSeek API Key', 8)
        changes = {'LLM_BASE_URL': 'https://api.deepseek.com/v1', 'LLM_MODEL': 'deepseek-flash',
                   'LLM_API_KEY': key, 'LLM_EXTRA_JSON': '{"thinking":{"type":"disabled"}}', 'LLM_VISION': 'false'}
    else:
        changes = {name: secret(label) for name, label in [
            ('WECHAT_APP_ID','测试号 AppID'), ('WECHAT_APP_SECRET','测试号 AppSecret'),
            ('WECHAT_OPEN_ID','关注用户 OpenID'), ('WECHAT_TEMPLATE_ID','测试模板 ID')]}
        changes['WECHAT_TEMPLATE_FIELDS'] = '{"title":"title","summary":"summary","source":"source","time":"time"}'
        # Replacing credentials requires another connectivity check before enabling routine delivery.
        changes['WECHAT_PUSH_ENABLED'] = 'false'
    update_env(Path(options.config).expanduser(), changes)
    print('配置已保存，权限 600。未切换模型、未发送消息；请回复“已填写”，随后验证连接。')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, EOFError, KeyboardInterrupt) as error:
        print(str(error) if isinstance(error, ValueError) else '配置未完成，未输出任何密钥', file=sys.stderr)
        sys.exit(1)
