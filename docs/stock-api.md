# 公告索引查询

`GET /api/v1/stock/announcements` 是匿名、只读的公告检索入口，适合 PQSelector 按已有候选或持仓名单查资料。读取现有数据库，不下载 PDF、不调用模型、不启动处理任务，也不修改名单或评分规则。

```bash
curl 'http://localhost:3001/api/v1/stock/announcements?market=sh&code=600036&from=2026-09-29&to=2026-09-30'
```

参数：

| 参数 | 规则 |
| --- | --- |
| `market` | 必填，`sh`、`sz`、`bj`；对应沪、深、北巨潮索引来源 |
| `code` | 必填，与市场匹配的六位证券代码，作为字符串保留前导零 |
| `from`、`to` | 北京时间日期，均包含当天；默认 `to` 为今天，`from` 为 `to` 前六天。最多 31 天，不接受未来日期 |
| `limit` | 每页 1–100 条，默认 50 |
| `cursor` | 上一页的 `page.nextCursor`；绑定市场、代码及解析后的起止日期 |

未知或重复参数返回 400 Problem JSON。结果按原文发布时间倒序，再按公告 ID 倒序排列。`page.hasMore` 只表示查询分页，不能表示采集是否完整。连续翻页应显式带上返回的 `query.from`、`query.to`，避免跨北京时间零点后默认日期改变。跨页没有冻结快照；下一轮轮询从第一页开始，以发现迟到公告，按 `items[].id` 去重。

`items` 包含基线、标题规则未命中及处理失败的索引，不要求新闻入选：

- `title` 为原始索引标题；`links.original` 指向公告 PDF。
- `publishedAt` 为来源提供的发布时间，日期精度取决于来源；`firstSeenAt` 是本系统首次发现时间。`asOf` 是本次读取时间，不是采集完成时间。
- `baseline` 标明上线基线，不代表材料无研究价值。
- `processingState` 是公告调度状态：`indexed`、`preparing`、`queued`、`failed`。`queued` 不代表分析完成。
- `bodyStatus` 来自已关联文章的正文提取状态，无关联文章时为 `null`；`ok` 表示提取成功，不代表事实核验或投资判断完成。
- `article` 仅在关联文章允许公开、已通过发布时限时返回站内 ID 和阅读链接，否则为 `null`。不返回正文、内部错误或新闻评分。

只有 `editorial` 来源的索引可见，暂停采集的来源保留公开历史；`isolated`、`hot_signal` 或缺失来源不展示索引或来源诊断。关联文章撤稿后，相应索引也不展示。

## 覆盖状态

`coverage.scope = cninfo_market_index` 只描述对应巨潮市场索引。`coverage.days` 包含请求范围内每一天，即使股票查询结果为零；数量是**整个来源、市场、日期的索引数量**，不是该股票数量，也不是当前页数量。

`scanComplete` 为 `null` 表示没有可见扫描记录；`false` 表示分页未完成或已入库数量少于提供方预计数量；`true` 仅表示本地分页和数量校验完成，不能证明其他来源、迟到披露或所有历史资料均已覆盖。`updatedAt` 是该日扫描最近更新时间；来源最近尝试、成功时间另在 `coverage.source` 返回。

| `gaps` 值 | 含义 |
| --- | --- |
| `outside_retention` | 早于配置保留边界，数据可能已清理；清理任务尚未执行时仍可能返回残存记录 |
| `not_scanned` | 没有可见扫描记录，不能当作零公告日 |
| `scan_incomplete` | 扫描记录尚未完成 |
| `count_mismatch` | 全市场已入库数量少于提供方预计数量 |
| `source_unavailable` | 来源缺失或当前不允许公开读取 |
| `source_disabled` | 来源暂停采集 |
| `source_degraded` | 来源健康状态不是 `ok` |
| `source_stale` | 查询包含今天，但来源超过 30 分钟没有成功采集，或没有成功记录 |
| `open_day` | 查询包含北京时间今天，今天仍可能出现新增披露 |

来源启停和健康缺口反映当前状态；历史扫描完成情况应同时结合该日 `scanComplete` 和 `updatedAt` 判断。列表、扫描记录和计数在单次只读数据库快照中读取。

PQSelector 应表述为“本地索引未检出”，附上查询日期、扫描时间及覆盖缺口；不能将空结果改写成“无公告”“无风险”或“核查通过”。重要原文仍需核验。当前索引保留约 30 天，采集不会自动补齐任意历史日期；本接口不改变该边界或 PDF 处理限额：每个早晚报窗口最多尝试 12 份，滚动 24 小时最多 24 份，失败也占额度。具体配置见 `industry/stock.ts`。

响应支持 CORS、ETag 和 `If-None-Match`，缓存最多 60 秒，须重新验证。即使 304，客户端也应保留既有扫描时间，不能把请求成功时间当作新的采集时间。完整字段定义见 `/openapi-v1.json`。
