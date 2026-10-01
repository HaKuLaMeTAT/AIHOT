# 部署

## 用 Docker（推荐）

需要一台装了 Docker（带 Compose）的机器。云服务器建议至少 2 核、4 GB 内存，构建镜像时要用到。

```bash
git clone https://github.com/KKKKhazix/AIHOT.git myhot
cd myhot
node scripts/init-env.ts --llm-key <你的模型 API Key>
docker compose up -d --build
```

`init-env.ts` 会生成 `.env`，填好随机密钥和管理员密码，并把密码打印一次。机器上没有 Node 的话，把 `.env.example` 复制成 `.env`，自己填 `ADMIN_PASSWORD`（至少 12 位）、`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、`POSTGRES_PASSWORD`（各用 `openssl rand -hex 32` 生成）和 `LLM_API_KEY`。

启动后打开 `http://服务器地址:3000`，后台在 `/admin`，用管理员密码登录。第一次启动会导入示范信源，一两分钟后开始出现内容；第一次导入的一百多条资料大约半小时处理完（每条都要预筛、评分，入选的还要写标题摘要）。

`docker compose` 会起五个容器：`db`（PostgreSQL 17）、`setup`（每次启动先跑数据库迁移和种子数据，然后退出）、`api`、`worker`（抓取、模型处理、定时任务）、`web`（网页）。

### 在中国大陆的服务器上

- 构建时 npm 走国内镜像：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`，然后 `docker compose up -d`。
- 拉取 Docker 镜像慢，先给 Docker 配置镜像加速。
- 海外信源抓不到时，在 `.env` 里设置 `EGRESS_PROXY_URL`：抓信源、图片和模型榜数据时走这个代理，调用模型接口不走。
- 对外提供网站服务需要先完成 ICP 备案，备案号填在 `industry/site.ts` 的 `icp`。

### 配域名和 HTTPS

先把域名解析到服务器，然后在 `.env` 里设置：

```bash
SITE_URL=https://example.com
SITE_DOMAIN=example.com
PORT=127.0.0.1:3000        # 3000 端口只给本机的 Caddy 用，不直接对外
TRUST_PROXY=true           # 访客地址从 Caddy 转来的请求头里读
```

再用带 HTTPS 的方式启动，Caddy 会自动申请和续期证书：

```bash
docker compose --profile https up -d --build
```

已经有 Nginx 的话，不用 Caddy，把站点反向代理到 `http://127.0.0.1:3000`，带上 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，并在 `.env` 里设 `TRUST_PROXY=true`。`SITE_URL` 一定要写成读者实际访问的地址：生成的链接、RSS、分享图和 MCP 都用它。

### 更新

```bash
git pull
docker compose up -d --build
```

数据库迁移只做向后兼容的增量，更新时自动执行。

### 备份

在 `.env` 里配置 `DB_BACKUP_STORE_*`（任何 S3 兼容的对象存储），每天 04:10 自动备份到那里。也可以手动导出：

```bash
docker compose exec -T db pg_dump -U aihot aihot | gzip > myhot-$(date +%F).sql.gz
```

数据都在三个 Docker 卷里：`db`（数据库）、`data`（上传的图片、图片缓存、本地备份）、`caddy`（证书）。`docker compose down` 不会删除它们；`docker compose down -v` 会。

### 看日志

```bash
docker compose logs -f --tail 100 api worker web
```

后台的“运行”页能看到每个定时任务最近的结果，“信源”页能看到每个信源的抓取状况。

## 花多少钱

- **模型**：每条新资料至少预筛一次；可能入选的再评分两次，入选的还要写标题摘要、打标签、归组，另外还有日报和事件综述。我们用示范信源在本地试跑，第一次导入的 152 条资料一共用了大约 930 次模型调用。之后每天用多少，取决于你的信源每天更新多少条。后台“模型与评测”页能看到每一步的调用次数和输入输出 token 数。
- **付费采集**（X、公众号、Jina）：按请求计费，默认不启用，填了 key 才会用。
- 所有付费服务都有每分钟、每小时、每天的调用上限（后台“设置 → 预算”），超过就暂停，不会一夜之间刷爆账单。填 0 表示立即停用这个服务。

## 不用 Docker

需要 Node.js 24.11 以上和 PostgreSQL 16 或 17。

```bash
npm ci
node scripts/init-env.ts --llm-key <你的模型 API Key>
createdb myhot
```

在 `.env` 里加上：

```bash
DATABASE_URL=postgres://你的用户名@127.0.0.1:5432/myhot
API_BASE_URL=http://127.0.0.1:3001
```

然后：

```bash
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run build -w @aihot/web

node --env-file=.env apps/api/src/main.ts          # 接口，3001 端口
node --env-file=.env apps/worker/src/main.ts       # 后台任务
cd apps/web && NODE_ENV=production node --env-file=../../.env server.ts   # 网页，3000 端口
```

三个进程要一直运行，生产环境用 systemd 或 pm2 守护。

开发时用带热更新的方式：`npm run dev:api`、`npm run dev:worker`、`npm run dev:web`。开发时想免登录进后台，在 `.env` 里设 `DEV_AUTH_ROLE=admin`（生产环境会拒绝启动）。

## 个人热点：AI、股市与微信

此 fork 增加了个人使用的低资源后台：AI 技术资讯与股市事件独立采集、分析，微信发送早晚报和经过单独判断的重大事件提醒。股票以 A 股为主，兼顾港股和美股科技、AI 公司。程序可只运行 PostgreSQL、API 和 worker；手机阅读页复用 API 进程，无需启动完整网页服务。

仓库仅包含代码、公开信源和空配置示例。模型 Key、微信标识、Tunnel Token、数据库、日志、备份及操作交接记录均保留在使用者本地。

### WSL 目录与资源

示例源码目录为 `D:\personal-hot`（WSL 中为 `/mnt/d/personal-hot`）。运行副本默认位于 `$HOME/.local/share/news-runtime`，私有配置位于 `$HOME/.config/news-runtime/env`，权限应为 600。`NEWS_RUNTIME`、`NEWS_CONFIG`、`NEWS_NODEDIR` 可覆盖脚本默认位置；Node 24 路径只用于本项目，不修改其他服务。

`deploy/wsl/` 包含当前用户的 systemd 模板，依赖本地 PostgreSQL 16 二进制及配置。`install-units` 渲染模板，`sync` 停止本项目并同步源码，完成迁移和检查后再 `start`。首次部署应先准备数据库二进制、数据库和私有 env；这些管理命令不会自动安装 PostgreSQL 或填写密钥。

```bash
./scripts/wsl-runtime.sh install-units
./scripts/wsl-runtime.sh sync
node --env-file="$HOME/.config/news-runtime/env" scripts/migrate.ts
./scripts/wsl-runtime.sh start
./scripts/wsl-runtime.sh status
```

建议采集并发 2、提取并发 1，AI、股市各一个分析任务。启用 `ANALYZE_CHANNELS_ENABLED=true`、`CODEX_CONCURRENCY=2`、`MODEL_CHANNEL_BUDGETS_ENABLED=true` 后，每个通道各占模型限额的一半，闲置份额不转借。`news-runtime.slice` 的模板硬限制为 CPU 75%、MemoryHigh 768 MiB、MemoryMax 1.25 GiB，服务 Nice=10，降低对同机其他服务的影响。可按自己的机器修改模板。

所有采集、模型调用、微信推送及回调安全阀默认关闭。开发、测试应保持关闭；验证本地配置后再按需要启用。查询状态和打开阅读页不会触发采集或模型调用。Windows 可双击 `查看热点状态.cmd`；它按自身所在目录定位项目，`NEWS_WSL_DISTRO` 默认 Ubuntu，可由使用者覆盖。

### 将实际数据放在 D 盘

不需要再创建一个 WSL 发行版。`deploy/storage/` 提供只挂载本项目数据目录的 metadata 示例，将 `D:\personal-hot\.runtime` 挂载到 `/mnt/newsruntime`。安装前必须将 Windows 路径、UID/GID 和用户服务 UID 改成自己的值。数据库、WAL、备份、缓存、日志和模型临时目录应指向这个挂载；运行程序和少量私有配置可以留在 Linux 用户目录。

存储检查读取使用者自己的 `$HOME/.config/news-runtime/storage.json`，内容包括 `mount`、`source` 和 `volume_id`，校验实际挂载、metadata 和 `.storage-id` 标记。身份不符时拒绝运行，避免挂载失效后意外在 C 盘创建数据。此文件和标记不应提交到 Git。

保留任务、备份和容量管理只控制本项目：

- 03:00 做在线备份，日备份保留 7 份，周备份保留 4 份；新备份验证成功后才轮换，手动及迁移备份不删除。
- 03:30 清理旧文章大字段：未入选保留 90 天，曾入选保留 180 天。身份、摘要、来源、关联与日报保留；新稿、待处理、人工修订、正在公开全文及回执未确定的资料受到保护。
- 日志每小时检查，单份超过 5 MiB 后轮换三份。数据库回执和未知结果不能随意删除，避免重新购买或重复推送。
- 空间低于 5 GiB 时暂停本项目 worker，恢复到 10 GiB 后只恢复此前由容量监控暂停的 worker；不启动使用者主动停止的服务。

```bash
./scripts/wsl-runtime.sh backup
./scripts/wsl-runtime.sh capacity
./scripts/wsl-runtime.sh ops-status
systemctl --user list-timers 'news-*'
```

数据迁移、恢复以及系统级 mount 安装应先另做备份，并在隔离数据库验证。日、周备份在同一磁盘上不能防止整块磁盘损坏。WSL 停止或电脑休眠期间不会采集或推送；这套模板不配置 Windows 开机或 WSL 自动启动。

### 模型与回执

主通道支持已登录的本机 Codex CLI，例如 `CODEX_MODEL=gpt-6-luna`；备选通道为 DeepSeek 兼容 API，手动切换，不在失败后自动转计费 API。

```bash
./scripts/wsl-runtime.sh configure-deepseek
./scripts/wsl-runtime.sh deepseek-check
./scripts/wsl-runtime.sh use-codex
./scripts/wsl-runtime.sh use-deepseek
```

填写命令使用本地隐藏输入；配置不打印到日志。验证命令会发送一笔真实模型请求。所有模型调用经过回执和预算熔断，已有成功结果可复用；结果不确定时不盲目重试。Codex 子进程只做文本分析，剥离应用密钥，禁用工具、浏览、MCP 和仓库读写，临时文件写入配置的 TMPDIR。

评分和内容理解使用原生输出 schema 约束实际 JSON 字段，而不是把 JSON 放进字符串。评分兼容完整的 0–100 整数；摘要缺失结尾仍判失败，不猜补内容。失败修复后重新排队对应材料，保持评分标准，复用已成功的步骤。

### 信源与报告

`industry/sources.json` 是公开 AI、监管和宏观信源配置；`industry/stock.ts` 定义额外股票入口与美股科技、AI 关注名单。来源、分类、重要性标准由使用者按自身需求调整。`PRIORITY_SOURCE_INTERVAL_MINUTES=30` 可固定重点源的检查间隔；`COLLECT_MAX_AGE_HOURS=72` 限制新采集材料的年龄，防止首次导入档案大量占用模型额度。

股票入口覆盖公告索引、盘中行情观测及 SEC 申报；只有满足规则的材料进入模型分析。免费接口的可用性与时效不作保证；SEC 联系方式需要使用者在本地填写。股票摘要是事件资料，不生成买卖指令，也不猜测证券代码。新闻默认只提供中文摘要与原文链接。

设置 `PERSONAL_REPORTS_ENABLED=true`、`PERSONAL_DAILY_TWICE_ENABLED=true` 后，AI、股市均在北京时间 08:00 发早报、20:00 发晚报。每期覆盖前 12 小时，按实际公开时间纳入；分析延迟完成的内容可进入下一期。已有事实和文章在七天内判重；同一事件的不同进展合并展示，保留各自来源。没有新内容不发空报，也不额外调用模型生成日报导语。

每期首次生成后冻结成员。卡片、日期阅读页、历史入口共用公开读取层，并重新检查撤稿、静默及公开资格。卡片按可读事件数量计数，启用时间不再对本期文章重复过滤；在报次结束后才启用的收件人不会补收该报次。已发送卡片不能回写，后续撤稿或归组变化仍可能改变阅读页数量。

### 微信模板与阅读入口

普通微信可通过公众号测试号的官方模板 API 接收消息。使用者申请测试号、关注并建立 AI 日报、股市日报、重大事件提醒三个模板，字段都使用 `title`、`summary`、`source`、`time`。

```bash
./scripts/wsl-runtime.sh configure-wechat
./scripts/wsl-runtime.sh configure-wechat-templates
./scripts/wsl-runtime.sh wechat-test --send
./scripts/wsl-runtime.sh wechat-enable
```

测试发送和启用应在使用者自己的终端完成。`WECHAT_DAILY_MODE=page` 每期只发一张简短卡片；`DAILY_PUBLIC_BASE_URL=https://news.example.com` 指向手机可访问的 HTTPS 根地址。缺少有效地址时不发送或预占投递键。阅读页展示完整摘要和每篇原文链接，不展示全文或内部回执，不调用模型。

设置 `DAILY_READING_ENABLED=true` 后，独立的 `127.0.0.1:3002` 只提供阅读、事件详情和显式启用的微信回调路由。Tunnel 只连接这个端口，不暴露包含后台的 3001。`DAILY_PREVIEW_ENABLED=true` 可开启明确标记虚构的排版示例，验收后关闭。

Windows 的 `scripts/start-reading-preview.ps1` 提供临时 Quick Tunnel；地址重启会变化，仅用于测试。正式部署用自己的域名和命名隧道，例如 `news.example.com` 对应 `http://127.0.0.1:3002`。`scripts/named-tunnel.ps1` 管理独立连接器，隐藏输入 Token，在 `.runtime/cloudflare/private/` 用当前 Windows 用户 ACL 保存。日志、状态和令牌均被 Git 忽略。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\named-tunnel.ps1" -Action Configure
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\named-tunnel.ps1" -Action Start -Cloudflared "C:\Tools\cloudflared.exe"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\named-tunnel.ps1" -Action Status -Cloudflared "C:\Tools\cloudflared.exe"
```

需要同一个隧道接入其他本地站点时，另外配置独立 hostname 路由，并传入 `-Ports` 指定连接器启动时需要检查的端口。脚本采用 BelowNormal、GOMAXPROCS=2，不修改已有隧道；不自动安装 Windows 服务或开机任务。`Status.running` 只说明进程存在，仍要验证外网阅读和 Cloudflare 健康状态。

### 微信交互、回调与紧急卡片

微信交互入口支持查询 AI、股市、历史和状态。菜单命令先备份并预览，只有显式 `--apply` 才修改菜单。回调参数通过本地配置命令提供，不将签名地址、Token 或用户标识写入文档。

```bash
./scripts/wsl-runtime.sh wechat-menu
./scripts/wsl-runtime.sh wechat-menu --apply
./scripts/wsl-runtime.sh wechat-callback-info
./scripts/wsl-runtime.sh wechat-callback-check --send
```

回调只响应已配置的接收者，校验签名和时间窗口，限制 XML 大小并拒绝危险 XML。微信平台投递成功与 API 已接受分别记录；回执重复或先于发送记录到达时仍做去重。消息结果未知时不自动重复推送。

重大事件单独评估紧急程度和原始依据，不用精选分数替代。卡片标题、要点采用短完整句，详情跳转到自己的事件阅读页，展示完整摘要和原始来源。紧急判断与卡片短文案同一次调用生成，页面访问不产生模型费用。
