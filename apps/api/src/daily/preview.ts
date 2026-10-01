import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import type { PersonalDaily } from "@aihot/backend/publication/personal-daily";

export function previewEdition(channel: "ai" | "stock", now = new Date()): PersonalDaily {
  const key = beijingDate(now);
  const end = new Date(beijingMidnight(key).getTime() + (channel === "ai" ? 8 : 18) * 3600_000);
  const entries = channel === "ai" ? [
    { title: "【虚构示例】研究团队发布新模型与公开评测", category: "ai-models", summary: "这是一条排版演示，不是实际新闻。正式日报会说明模型的能力变化、评测条件、开放范围及局限，保留完整中文摘要。这里使用较长的说明，验证手机上能够自然换行、完整阅读，而不会像微信卡片一样只显示开头。", sourceName: "演示来源", sourceUrl: "https://arxiv.org/" },
    { title: "【虚构示例】开发工具新增工作流能力", category: "ai-products", summary: "这也是虚构示例。实际内容会区分已经发布的功能和未来计划，说明适用场景，并提供一手来源供你核对。阅读日报及打开原文不会触发本项目的模型请求。", sourceName: "演示来源", sourceUrl: "https://github.com/" },
  ] : [
    { title: "【虚构示例】监管部门发布资本市场政策", category: "stock-policy", summary: "这是一条虚构的排版示例，不代表今天有此政策。实际股市日报会说明正式文件、实施时间、适用范围和相关影响；公告与分析分开表述，不把未经验证的市场传言作为事实。", sourceName: "演示来源", sourceUrl: "https://www.csrc.gov.cn/" },
    { title: "【虚构示例】上市公司披露重大经营变化", category: "stock-company", summary: "本条仅验证版式。实际摘要会保留公告中的经营事实、关键数字与可核对依据，不能由摘要直接得出买卖结论。每条都有独立原文入口，方便后续在 PowerQuant 研究中核对。", sourceName: "演示来源", sourceUrl: "https://www.cninfo.com.cn/" },
  ];
  return { channel, key, windowStart: new Date(end.getTime() - 86400_000).toISOString(), windowEnd: end.toISOString(),
    entries: entries.map((e) => ({ ...e, publishedAt: end.toISOString() })) };
}
