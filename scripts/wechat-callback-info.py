"""Display the callback secret only in the owner's local interactive terminal."""
import argparse
import re
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--config', default=str(Path.home() / '.config/news-runtime/env'))
options = parser.parse_args()
if not sys.stdout.isatty():
    raise SystemExit('请在自己的 WSL 交互终端运行；Token 不写入管道或日志。')
values = {}
for line in Path(options.config).read_text().splitlines():
    m = re.fullmatch(r'(WECHAT_CALLBACK_TOKEN|DAILY_PUBLIC_BASE_URL)=(.*)', line)
    if m:
        values[m[1]] = m[2].strip()
base = values.get('DAILY_PUBLIC_BASE_URL', '').rstrip('/')
token = values.get('WECHAT_CALLBACK_TOKEN', '')
if not base.startswith('https://') or not re.fullmatch(r'[A-Za-z0-9]{3,32}', token):
    raise SystemExit('回调配置尚未准备好；未输出其他凭据。')
print('请在微信测试号控制台的“接口配置信息”填写：')
print('URL: ' + base + '/wechat/callback')
print('Token: ' + token)
print('若有加密模式选项，当前选择明文模式。提交成功后可回复“回调已保存”。')
