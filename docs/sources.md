# 信源

信源在后台“信源”页管理：新建、试抓一次看看抓到什么、改频率、启停、看失败原因和最近的条目。首次启动时，`industry/sources.json` 里的示范信源会被导入。

## 六种信源

| 类型 | 适合 | 需要 |
|---|---|---|
| `rss` | 有 RSS / Atom 的博客、媒体、Substack、公众号转 RSS 服务 | 无 |
| `web_list` | 没有 RSS 的网页列表（新闻页、博客列表、更新日志） | 写选择器；抓不到时可以经 Jina Reader 渲染（按次计费） |
| `json_list` | 返回 JSON 的接口（GitHub Releases 等） | 写字段路径 |
| `x_search` | X（推特）账号 | SocialData 的 key，按请求计费 |
| `mp_account` | 微信公众号 | 极致了（Dajiala）的 key，按请求计费 |
| `external` | 你自己的脚本推送进来的内容 | `INGEST_TOKEN`，见下文 |

每种信源认哪些配置项写在 `packages/backend/src/sources/config-keys.ts`。填了不认识的配置项，保存会被拒绝、抓取会直接失败并在后台显示原因，不会悄悄退回通用解析。

### rss

```json
{ "feedUrl": "https://example.com/feed.xml" }
```

可选：`summaryIsBody`（订阅里的摘要就是全文）、`allowCategories` / `denyCategories`（按订阅里的分类过滤）。

### web_list

```json
{
  "url": "https://example.com/news",
  "itemSelector": "article",
  "linkSelector": "a",
  "titleSelector": "h2",
  "publishedAtSelector": "time"
}
```

- `parseMode`：`html`（默认，用选择器）、`markdown`（经 Jina 渲染后按 Markdown 读）、`docusaurus_changelog`。
- `detail`：列表缺日期、标题或摘要时抓详情页补齐（`publishedAtSelector`、`titleSelector`、`summarySelector` 等）。
- `allowUrlPrefixes` / `denyUrlPrefixes`：只收某些路径下的文章。

### x_search

```json
{ "query": "from:SomeAccount -filter:replies" }
```

普通账号会被自动合并成一次搜索（每次最多二十几个账号），省请求数。

### mp_account

```json
{ "ghid": "gh_xxxxxxxx", "nickname": "公众号名称" }
```

每个公众号按它的抓取间隔检查一次（查列表按次计费），新文章的正文一并取回。

## 分级、参与方式与全文

- **分级** `tier`：`T1` 官方一手（官网、官方博客、机构）、`T1_5` 官方账号与准官方创作者、`T2` 媒体与个人、`EXCLUDE_MP` 不参与精选。入选门槛按分级不同（`industry/selection.ts`）。
- **参与方式** `participation_mode`：`editorial` 进精选和全部动态；`hot_signal` 不单独展示，只作为“大家在讨论什么”的热度证据；`isolated` 不进任何公开页面。
- **一手** `first_party`：来源是当事方自己。事件页会优先展示一手报道。
- **全文**：`site_fulltext` 决定站内能不能显示全文，`syndicate_fulltext` 决定全文 RSS 能不能带正文。两者**默认都关**，只显示摘要和原文链接；来源明确允许时再打开。公众号、付费墙内容不会因为技术上抓得到就获得全文展示。

## 抓取频率

每个信源有自己的抓取间隔。每天 04:20 会按近 7 天的产出自动调整：产出多的抓得勤，最短 15 分钟；免费信源最长 60 分钟，按次计费的信源最长 120–180 分钟。

抓取失败不推进位置，下次从同一处继续；连续失败的信源在后台标红，每周一会在运营群发一份信源周报（配置了飞书内部群时）。

## 规则：旧文不刷屏

首次发现时原文已经发布超过 48 小时的资料、新信源第一次导入的存量条目、标记为回灌的推送，都按原文时间归档：不进入“今天”，也不推送。这条规则所有入口共用，防止一次性导入历史内容刷屏。

## 个人热点扩展信源

本地部署启用 50 个来源：AI 22 个、股市 28 个（含原有四个专用股票采集入口）。新增 AI 来源为 Anthropic 官方发布、DeepSeek 官方更新、Qwen 官方 Hugging Face 模型目录，以及 arXiv 的 cs.AI/cs.CL/cs.LG 论文摘要。Qwen 的旧博客不作为当前发布入口。论文必须命中语言模型、多模态、推理、智能体等主题词，每个北京时间自然日最多新增 5 篇；Qwen 模型目录最多新增 4 项。关键词只控制采集，不替代精选评分。

美股公司首批为 NVDA、MSFT、AAPL、GOOGL、AMZN、META、TSLA、AVGO、AMD、TSM。每家公司每 30 分钟检查 SEC submissions，最多新增 2 份申报/北京时间自然日。接入 8-K、10-Q、10-K、6-K、20-F 及修订版；8-K 只保留业绩、重大协议、资产交易、债务风险、控制权或管理层变化等披露项目，普通 Form 4/144、仅有附件的 8-K 和台积电月末股数披露排除。它覆盖这些公司的重要公开申报，不是美股全市场实时新闻，也不代表所有申报都值得推送。

`json_list` 使用 `adapter: "sec_submissions"`、十位 `cik` 和 `ticker`，校验返回的公司身份和列长度，使用原始 acceptanceDateTime。正文任务读取申报原文，最多补充同一申报目录中的一份 99.1/业绩 HTML 附件；拒绝跨目录、外站和重定向。主文、附件各最多保留 30,000 字符，主文截取和附件缺失均明确标注，不凭申报标题推断业绩数字。网页仍只公开摘要及原文链接。

宏观补充国家统计局数据发布、财政部政策，以及美国 BLS 的 CPI、就业、PPI 和 BEA 的 GDP/PCE 等发布。中国两个来源每 120 分钟，美国四个来源每 30 分钟；原有来源频率不变。首次每源最多导入 2 条，沿用 72 小时采集窗口及历史推送边界。来源返回旧档案或当日没有公告时，正常检查成功仍记为健康，不制造新消息。

通用采集配置 `_aihot.maxNewItemsPerDay` 可设 1–60 的整数，按来源的当日新增文章计数，已存在文章的修订不占新增槽位。达到限量后未处理的条目保持可再读取；RSS 不保存导致这些条目被 304 隐藏的条件请求状态。该规则用于削减模型输入，付费调用仍受原有回执和模型预算硬限制约束。

## 外部推送接口

自己写脚本抓的内容，可以推进站里，走和普通采集一样的判重、精选和归组。

```
POST /api/ingest/items
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

{
  "sourceId": "my-crawler",
  "sourceName": "我的抓取脚本",
  "items": [
    { "title": "必填", "url": "必填", "publishedAt": "2026-10-01T08:00:00+08:00", "author": "可选" }
  ]
}
```

- `INGEST_TOKEN` 在 `.env` 里设置，至少 16 位；不设置时接口一律返回 401。
- 每次最多 50 条；每个客户端每分钟最多 10 次。
- 返回 `{"ok": true, "created": <新建条数>}`。缺标题或网址的条目会被跳过，同一请求里重复的网址只取第一条。
- `sourceId` 不存在时会自动建一个 `external` 信源，默认不进公开页面：到后台把它的参与方式改成 `editorial` 才会出现在站上。
- 在后台暂停信源后，推送接口返回 409，不再接收新文章；恢复信源后可以继续推送。
- 条目的 `raw._aihot.backfill` 为 `true` 时按历史回灌处理（不进入“今天”、不推送）。
