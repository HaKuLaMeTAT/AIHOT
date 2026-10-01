import { CATEGORIES } from "@aihot/industry/taxonomy";
import { SITE } from "@aihot/industry/site";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { dailyEditionLabel } from "@aihot/contracts/personal-daily";
import type { PersonalDaily } from "@aihot/backend/publication/personal-daily";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const labels = new Map<string, string>(CATEGORIES.map((c) => [c.key, c.label]));
function original(url: string): string | null {
  try { const u = new URL(url); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}

function source(entry: PersonalDaily["entries"][number], manualSupplement: boolean): string {
  const published = entry.publishedAt ? `${beijingDate(entry.publishedAt)}${manualSupplement ? "" : ` ${beijingTime(entry.publishedAt)}`}` : "信源未提供";
  const lines = [`${escape(entry.sourceName)} · ${manualSupplement ? "原文日期" : "原文发布时间"} ${published}`];
  if (!manualSupplement && entry.discoveredAt) lines.push(`采集时间 ${beijingDate(entry.discoveredAt)} ${beijingTime(entry.discoveredAt)}`);
  if (!manualSupplement && entry.includedAt) lines.push(`收录时间 ${beijingDate(entry.includedAt)} ${beijingTime(entry.includedAt)}`);
  return `<div class="source">${lines.join("<br>")}</div>`;
}

function note(entry: PersonalDaily["entries"][number], report: PersonalDaily): string {
  if (report.manualSupplement) return "";
  const text = entry.delayedAnalysis ? "跨期补分析 · 此前采集，本期完成收录"
    : entry.publishedAt && entry.publishedAt < report.windowStart ? "较早发布 · 本期收录" : "";
  return text ? `<div class="source">${text}</div>` : "";
}

function related(entry: PersonalDaily["entries"][number], report: PersonalDaily): string {
  return (entry.relatedEntries ?? []).map(member => {
    const url = original(member.sourceUrl);
    return `<details><summary>同一事件的其他报道或进展：${escape(member.title)}</summary>${note(member, report)}<p>${escape(member.summary)}</p>${source(member, report.manualSupplement === true)}${url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">阅读此篇原文 ↗</a>` : ""}</details>`;
  }).join("");
}

// No scripts, external fonts, images or model calls. All text is escaped, not interpreted as HTML.
export function renderDaily(report: PersonalDaily, preview = false, singleEvent = false): string {
  const title = singleEvent ? "事件详情" : (report.channel === "ai" ? "AI 前沿" : "股市热点") + dailyEditionLabel(report.edition) + (report.supplement ? " · 补充" : "");
  const accent = report.channel === "ai" ? "#175d51" : "#943f27";
  const end = new Date(report.windowEnd);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${escape(title)} · ${escape(report.key)}</title><style>
*{box-sizing:border-box}html{color:#24241f;background:#f5f2e9;font-family:"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.8}body{margin:0;border-top:6px solid ${accent}}main{max-width:760px;margin:auto;padding:28px 24px 52px}.masthead{display:flex;justify-content:space-between;font-size:12px;letter-spacing:.12em;color:${accent};border-bottom:1px solid #c9c7bc;padding-bottom:14px}h1{font-family:"Songti SC","Noto Serif CJK SC",serif;font-size:clamp(32px,8vw,48px);line-height:1.25;font-weight:600;margin:34px 0 14px}.intro{color:#65675c;font-size:14px;margin-bottom:28px}.edition{font-variant-numeric:tabular-nums}article{display:grid;grid-template-columns:36px 1fr;border-top:1px solid #c9c7bc;padding:26px 0;gap:10px}.number{font:italic 24px Georgia,serif;color:${accent}}.category{color:${accent};font-size:12px;letter-spacing:.06em}h2{font-size:21px;line-height:1.5;margin:6px 0 14px;overflow-wrap:anywhere}p{margin:0 0 14px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px}.source{font-size:12px;color:#65675c}a{display:inline-block;color:${accent};font-size:14px;text-underline-offset:5px;padding:6px 0}a:focus-visible{outline:2px solid ${accent};outline-offset:4px}footer{border-top:2px solid ${accent};padding-top:18px;font-size:12px;color:#65675c}details{margin-top:18px;padding-top:14px;border-top:1px dashed #c9c7bc}summary{cursor:pointer;font-size:14px;color:${accent};overflow-wrap:anywhere}details[open] summary{margin-bottom:14px}.empty{padding:32px 0}@media(max-width:380px){main{padding:22px 18px 40px}article{grid-template-columns:28px 1fr;gap:8px}h2{font-size:19px}}
</style></head><body><main><div class="masthead"><span>${escape(SITE.name)}</span><span>${singleEvent ? "EVENT BRIEF" : "DAILY BRIEF"}</span></div><h1>${title}</h1>${preview ? `<p><strong>排版演示 · 内容虚构，并非实际新闻</strong><br><a href="/daily/preview/${report.channel === "ai" ? "stock" : "ai"}">查看${report.channel === "ai" ? "股市" : "AI"}日报示例 ↗</a></p>` : ""}<div class="intro"><span class="edition">${escape(report.key)} · ${singleEvent ? "收录于 " : "截至 "}${beijingTime(end)}（北京时间）</span><br>${singleEvent ? "事件详情" : report.manualSupplement ? `首日补发 · 近期真实精选 ${report.entries.length} 件事<br>本次包含首次采集的历史资料；下方时间为原文发布时间，不代表今天发布。` : report.edition ? `收录窗口：${beijingDate(report.windowStart)} ${beijingTime(report.windowStart)} 至 ${beijingDate(report.windowEnd)} ${beijingTime(report.windowEnd)} · 精选 ${report.entries.length} 件事` : `过去 24 小时收录精选 ${report.entries.length} 件事`} · 完整摘要与原始来源${!singleEvent && !report.manualSupplement ? "<br>按本期收录时间统计；原文发布时间可能早于本期，跨期完成的资料标为补分析。" : ""}</div>${report.entries.length ? report.entries.map((entry, i) => {
    const url = original(entry.sourceUrl);
    return `<article><div class="number">${String(i + 1).padStart(2, "0")}</div><div><div class="category">${escape(labels.get(entry.category ?? "") ?? "其他")}</div><h2>${escape(entry.title)}</h2>${note(entry, report)}<p>${escape(entry.summary)}</p>${source(entry, report.manualSupplement === true)}${url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">阅读原文 ↗</a>` : ""}${related(entry, report)}</div></article>`;
  }).join("") : report.noNewSelection ? '<p class="empty">本期暂无新增精选事件。<br>未入选或尚未分析的资料不在此列，这不代表相关领域没有事件。</p>' : '<p class="empty">本期暂无可显示的精选内容。</p>'}<footer>仅展示摘要，全文请阅读原始来源。<br>${singleEvent ? "撤回或不再公开的事件将停止显示。" : "条目按本期收录保留，撤回或不再公开的内容会移除。"}</footer></main></body></html>`;
}
