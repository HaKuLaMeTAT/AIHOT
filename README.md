# 个人热点：AI 技术与股市资讯

基于 [KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT) 定制的个人资讯后台：持续采集 AI 技术前沿和股市事件，筛选、分析并归组，通过普通微信接收早晚报与重大事件提醒。

目标是单人使用、低并发、资源有上限。日常采集和分析不依赖完整网页；微信日报卡片链接到轻量手机阅读页，微信也可查询最新日报、历史和服务状态。本仓库保留上游 MIT 许可与版权声明。

## 与源仓库的差异

| 方面 | 上游框架 | 本定制版 |
| --- | --- | --- |
| 使用定位 | 通用行业热点网站，默认 AI 行业示例 | 个人 AI 技术兴趣与股市资讯后台 |
| 内容范围 | 18 个公开 AI 示例信源 | 50 个配置入口：AI 22 个、股市 28 个，包含公告索引与行情观测 |
| 模型接入 | OpenAI 兼容 HTTP API | 新增已登录的本机 Codex CLI；DeepSeek API 作手动切换的备用通道 |
| 分析调度 | 通用 worker 任务 | AI、股市各一个分析任务；每通道一个模型调用，最多两个同时进行 |
| 模型预算 | 回执与预算熔断 | CLI 调用也计入回执；可将每个服务的调用预算平均分给两个通道 |
| 报告安排 | 网站日报及周期报告 | 两个通道每日 08:00 早报、20:00 晚报，北京时间，每期覆盖 12 小时 |
| 通知方式 | 网站、RSS、API、MCP 及飞书相关能力 | 新增公众号测试号官方模板消息、查询菜单和微信投递回执 |
| 阅读方式 | 完整网站前端 | 新增独立轻量阅读入口，直接复用 API 进程 |
| 事件呈现 | 事件归组框架 | 个人日报按已归组事件展示主项，相关进展展开阅读并保留所有来源 |
| 数据与运维 | 通用部署与保留能力 | 新增 WSL 用户服务、资源硬限制、D 盘挂载检查、备份轮换与容量告警 |
| 可选模块 | 模型榜与 Codex 重置监控 | 当前行业配置关闭这两项，减少后台工作量 |

原有采集、预筛、两次独立评分、中文摘要、结构化与事件归组流程继续使用。增加股市相关提示词和分类，不将股票标题直接当作交易信号。原网站、RSS、公开 API、MCP 的代码保留，可按需要运行。

## AI 与股市分别关注什么

**AI** 覆盖模型、产品、行业、论文、教程和观点。来源包括 OpenAI、Anthropic、Google DeepMind / Research、Hugging Face、Microsoft Research、NVIDIA、Mistral、DeepSeek、Qwen、arXiv，以及技术媒体与研究者博客。重点保留有原始依据的技术发布、能力变化、论文和工程实践，压制广告、重复转发与没有依据的宣传。

**股市** 以 A 股为主，兼顾港股与美股科技、AI 公司，分类为政策监管、公司公告、行业产业、市场异动和宏观事件。监管与宏观来源包括证监会、沪深交易所、央行、港交所、SEC、美联储、统计局、财政部、美国 BLS 和 BEA。

美股公司申报目前关注 NVDA、MSFT、AAPL、GOOGL、AMZN、META、TSLA、AVGO、AMD、TSM；名单写在信源配置中，可以自行调整。没有声称覆盖所有美股公司或所有公告全文。

为控制采集与模型工作量：

- 重点官方来源每 30 分钟检查，其他来源保留各自频率，具体以 [信源配置](industry/sources.json) 为准。
- 沪、深、北公司公告每 15 分钟采集索引，先按标题规则筛选；当前每天最多尝试处理 5 份公告 PDF，失败尝试也计入限额。
- 行情异动每 5 分钟采样，记录提供方观测；不逐条调用模型。盘后可组成一份观察材料进入分析队列，不从盘口标签猜测事件原因。
- 普通采集默认只接收最近 72 小时有日期的资料；首次历史补采不触发微信通知。

公告规则和处理限额见 [industry/stock.ts](industry/stock.ts)。免费信源可能失败、限流或改变格式；索引与行情观测有采样、页数和频率边界，不能视为完整实时行情服务。

## 微信推送规则

使用公众号测试号的官方 API，接收端是普通微信。需要自行申请测试号、关注并创建三个模板，不需要通过 PushPlus。AppSecret、接收者标识和模板 ID 只填在本地配置中。

| 消息 | 什么时候发 | 卡片与详情 |
| --- | --- | --- |
| AI 早报 / 晚报 | 每日 08:00 / 20:00 | 一张短卡片，点击阅读完整 AI 精选 |
| 股市早报 / 晚报 | 每日 08:00 / 20:00 | 一张短卡片，点击阅读完整股市精选 |
| 重大事件提醒 | 原始依据和紧急程度均通过单独判断后 | 短完整标题与要点，点击自己的事件详情页，再跳转原文 |

早报窗口为前一天 20:00 至当天 08:00，晚报为当天 08:00 至 20:00。以实际公开时间纳入，分析延迟完成的资料可进入后续报次。没有新增精选时不发空报，也不额外调用模型撰写日报导语。

每期首次组成后冻结成员；已覆盖事实与文章在七天内判重。同一事件的不同进展合并展示，保留各自摘要、原文日期和来源链接。卡片与阅读页共用公开读取层，按可读事件数计数，避免分别筛选造成数量不一致。已发送卡片不能修改，后续撤稿或归组变化仍可能改变阅读页数量。

微信交互可回复 `AI`、`股市`、`历史`、`状态`。查询只读取已生成数据，不触发模型。API 接受发送与微信平台确认投递分别记录；平台成功回执不等于用户已读，结果未知时不自动重复发送。

## 模型与低资源运行

主通道支持本机已登录的 Codex CLI，当前部署轮廓使用 `gpt-6-luna`。CLI 子进程只承担文本分析，剥离应用密钥，关闭工具、浏览、MCP 和仓库操作。DeepSeek 作为手动切换的备选，失败时不会自动转到另一个付费通道。

所有模型请求都通过回执与预算熔断，复用已经成功的步骤；预算按调用次数和滚动时间窗口计算，不是 Token 额度或金额上限。新库的 Codex 初始上限为每分钟 6 次、每小时 60 次、滚动一天 300 次；实际部署可在本地 `budgets` 表调整。开启通道预算隔离后各占一半，闲置份额不转借。本机运行中的预算状态不包含在源码备份里。

评分、内容理解使用 Codex 原生 JSON schema 约束实际字段；评分另兼容完整的 0–100 整数。截断的摘要仍判失败，不拼补内容。失败材料可以重新排队，已成功的回执不重新购买。

WSL 模板的建议运行轮廓：

| 项目 | 设置 |
| --- | --- |
| 采集并发 | 2 |
| 正文提取并发 | 1 |
| 分析并发 | AI 1、股市 1 |
| Codex 并发 | 每通道 1，全局最多 2 |
| CPU 上限 | 75% |
| 内存高水位 / 硬上限 | 768 MiB / 1280 MiB |
| 调度优先级 | Nice=10，降低 I/O 优先级 |

资源限制来自 [news-runtime.slice](deploy/wsl/news-runtime.slice)，不是内存占用承诺；实际用量应从状态命令观察。这些服务只管理本项目，不停止其他应用。WSL 停止、电脑休眠或关机期间不会采集和推送。

## 部署与配置

需要 Node.js 24；个人 WSL 模板使用 PostgreSQL 16，原 Docker 部署使用 PostgreSQL 17。后端直接运行 TypeScript，无后端构建步骤。

```bash
git clone https://github.com/HaKuLaMeTAT/AIHOT.git personal-hot
cd personal-hot
npm ci
cp .env.example .env
```

复制配置并不等于完成部署。先准备数据库、管理员与签名密钥、模型认证、微信信息和阅读地址。个人 WSL 后台使用独立私有配置文件，目录、数据库二进制、挂载与 systemd 安装步骤见 [部署文档](docs/deploy.md#个人热点ai股市与微信)；Docker 与完整网站的启动步骤也在该文档中。

下列配置说明个人后台的运行轮廓。采集、模型和通知安全阀保持关闭；完成本地配置与验证后再按需要开启。

```dotenv
LLM_PROVIDER=codex
CODEX_MODEL=gpt-6-luna
ANALYZE_CHANNELS_ENABLED=true
CODEX_CONCURRENCY=2
MODEL_CHANNEL_BUDGETS_ENABLED=true
FETCH_CONCURRENCY=2
EXTRACT_BODY_CONCURRENCY=1

PERSONAL_REPORTS_ENABLED=true
PERSONAL_DAILY_TWICE_ENABLED=true
WECHAT_DAILY_MODE=page
DAILY_READING_ENABLED=true
DAILY_READING_PORT=3002
DAILY_PUBLIC_BASE_URL=https://news.example.com

COLLECT_ENABLED=false
MODEL_CALLS_ENABLED=false
WECHAT_PUSH_ENABLED=false
WECHAT_CALLBACK_ENABLED=false
STOCK_SOURCES_ENABLED=false
```

轻量阅读入口监听 `127.0.0.1:3002`。自己的 Cloudflare 命名隧道只转发这个入口，不转发包含后台的 `3001`。手机域名使用自己的 HTTPS 地址；仓库只给出 `news.example.com` 示例。Windows 隧道脚本为 [named-tunnel.ps1](scripts/named-tunnel.ps1)，临时验收脚本为 [start-reading-preview.ps1](scripts/start-reading-preview.ps1)。

密钥通过本地隐藏输入命令配置，验证命令可能产生真实请求或测试消息：

```bash
./scripts/wsl-runtime.sh configure-deepseek
./scripts/wsl-runtime.sh deepseek-check
./scripts/wsl-runtime.sh configure-wechat
./scripts/wsl-runtime.sh configure-wechat-templates
./scripts/wsl-runtime.sh wechat-test --send
```

## 状态、存储与保留

```bash
./scripts/wsl-runtime.sh status
./scripts/wsl-runtime.sh status --json
./scripts/wsl-runtime.sh backup
./scripts/wsl-runtime.sh capacity
./scripts/wsl-runtime.sh ops-status
```

Windows 可双击 [查看热点状态.cmd](查看热点状态.cmd)。状态包括服务、Worker 心跳、采集与分析队列、内存、推送回执、备份和容量；有排队内容不等于故障。

实际业务数据可通过专用 metadata 挂载落在 D 盘目录，无需再创建 WSL 发行版。挂载身份不符时拒绝运行，防止意外回落到 C 盘；示例路径、UID/GID 必须改成自己的值。程序和少量私有配置可以保留在 Linux 用户目录。

- 日备份保留 7 份，周备份 4 份；验证新备份成功后才轮换。
- 未入选新闻大字段保留 90 天，曾入选保留 180 天；摘要、身份、来源、关联与日报保留，待处理、人工修改及回执不确定的资料受到保护。
- 常规日志超过 5 MiB 轮换三份；空间低于 5 GiB 暂停本项目 Worker，恢复到 10 GiB 后仅恢复监控此前暂停的服务。

保留、备份与容量规则见 [部署文档](docs/deploy.md)。新闻默认仅提供摘要与原文链接，不展示来源全文；股市内容是事件资料，不生成买卖指令。

## 配置与验证入口

| 文件 / 目录 | 用途 |
| --- | --- |
| [industry/site.ts](industry/site.ts) | 个人热点站名与文案 |
| [industry/sources.json](industry/sources.json) | 信源、轮询频率与美股公司名单 |
| [industry/taxonomy.ts](industry/taxonomy.ts) | AI / 股市分类、标签和实体 |
| [industry/prompts/](industry/prompts/) | 预筛、评分、写作与紧急判断标准 |
| [industry/processing.ts](industry/processing.ts) | 通道与近期重点材料的处理优先级 |
| [industry/stock.ts](industry/stock.ts) | 公告筛选及处理限额 |
| [industry/selection.ts](industry/selection.ts) | 精选门槛；调整前须用标注样本校准 |
| [scripts/wsl-runtime.sh](scripts/wsl-runtime.sh) | 本地后台管理 |
| [docs/customize.md](docs/customize.md) | 继续定制行业的步骤 |

验证使用隔离的空测试库，采集、模型和外部通知默认关闭，模型测试只使用本地 stub：

```bash
npm run typecheck
DATABASE_URL=postgres://127.0.0.1:5432/personal_hot_test node scripts/migrate.ts
DATABASE_URL=postgres://127.0.0.1:5432/personal_hot_test npm test
npm run build -w @aihot/web
node --test apps/web/tests/*.test.ts
python3 tests/configure-integrations.test.py
python3 tests/runtime-ops.test.py
python3 tests/storage-guard.test.py
```

这次脱敏源码版本已通过类型检查、网页构建、237 项后端测试（另 1 项跳过）、16 项网页测试及 21 项 Python 测试。Docker 集成检查仍保留在 GitHub 工作流中，信源数量按当前配置核对。

## 源码范围与许可

这是可公开的源码版本：包含定制代码、增量数据库迁移、测试、公开信源、部署模板和空配置示例。不包含真实密钥、微信账号及接收者标识、Tunnel Token、数据库、新闻数据、日志、备份或个人交接记录；个人路径和域名已改成通用示例。源码不能还原当前运行实例的数据或本地配置。

上游作者：数字生命卡兹克。源项目：[KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT)。许可：[MIT](LICENSE)，保留上游版权声明。对外使用的站名为“个人热点”。
