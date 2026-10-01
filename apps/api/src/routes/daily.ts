import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import { listPersonalDailies, loadPersonalDaily } from "@aihot/backend/publication/personal-daily";
import { renderDaily } from "../daily/render.ts";
import { previewEdition } from "../daily/preview.ts";
import { dailyEditionLabel } from "@aihot/contracts/personal-daily";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { publicNotification } from "@aihot/backend/publication/notification";

export function registerDaily(app: FastifyInstance) {
  app.get("/event/:articleId", async (req, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex, nofollow")
      .header("Referrer-Policy", "no-referrer").header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const { articleId } = req.params as { articleId: string };
    const row = await publicNotification(articleId);
    if (!row) return reply.code(404).type("text/plain; charset=utf-8").send("此事件暂不可显示。");
    return reply.type("text/html; charset=utf-8").send(renderDaily({ channel: row.category?.startsWith("stock-") ? "stock" : "ai",
      key: beijingDate(row.timeline_at), windowStart: row.timeline_at.toISOString(), windowEnd: row.timeline_at.toISOString(),
      entries: [{ title: row.title, summary: row.summary ?? "", category: row.category, sourceName: row.source_name,
        sourceUrl: row.url, publishedAt: row.timeline_at.toISOString() }] }, false, true));
  });
  app.get("/daily/:channel/latest", async (req, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex, nofollow");
    const { channel } = req.params as { channel: string };
    if (channel !== "ai" && channel !== "stock") return reply.code(404).send();
    const [latest] = await listPersonalDailies(channel, new Date(), 1);
    if (!latest) return reply.code(404).type("text/plain; charset=utf-8").send("暂无已生成且可显示的日报。");
    return reply.redirect(latest.path);
  });
  app.get("/daily/:channel/history", async (req, reply) => {
    const { channel } = req.params as { channel: string };
    if (channel !== "ai" && channel !== "stock") return reply.code(404).send();
    const entries = await listPersonalDailies(channel);
    reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex, nofollow")
      .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
      .header("Referrer-Policy", "no-referrer").header("X-Content-Type-Options", "nosniff");
    const name = channel === "ai" ? "AI" : "股市";
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}历史日报</title><style>body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#24241f;background:#f5f2e9;line-height:1.8;max-width:760px;margin:auto;padding:24px}a{color:#175d51;display:block;padding:16px 0;border-bottom:1px solid #c9c7bc}small{color:#65675c}a:focus-visible{outline:2px solid #175d51}</style><h1>${name}历史日报</h1><p>最近已生成且仍有公开精选的 30 期</p>${entries.map(e => `<a href="${e.path}">${e.key} ${dailyEditionLabel(e.edition)}${e.supplement ? ` · 补充 ${e.supplement}` : ""}<br><small>精选 ${e.count} 条 · 截止 ${beijingDate(e.windowEnd)} ${beijingTime(e.windowEnd)}</small></a>`).join("") || "<p>暂无已生成且可显示的日报。</p>"}<p><a href="/daily/${channel === "ai" ? "stock" : "ai"}/history">查看${channel === "ai" ? "股市" : "AI"}归档</a></p></html>`;
    return reply.type("text/html; charset=utf-8").send(html);
  });
  app.get("/daily/preview/:channel", async (req, reply) => {
    const { channel } = req.params as { channel: string };
    if (process.env.DAILY_PREVIEW_ENABLED !== "true" || (channel !== "ai" && channel !== "stock")) return reply.code(404).send();
    return reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex, nofollow")
      .header("Referrer-Policy", "no-referrer").header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
      .type("text/html; charset=utf-8").send(renderDaily(previewEdition(channel), true));
  });
  const reading: RouteHandlerMethod = async (req, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex, nofollow")
      .header("Referrer-Policy", "no-referrer").header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const { channel, key, supplement, edition } = req.params as { channel: string; key: string; supplement?: string; edition?: string };
    const report = await loadPersonalDaily(channel, key, new Date(), supplement, edition);
    if (!report) return reply.code(404).type("text/plain; charset=utf-8").send("这期日报尚未生成。");
    return reply.type("text/html; charset=utf-8").send(renderDaily(report));
  };
  app.get("/daily/:channel/:key", reading);
  app.get("/daily/:channel/:key/:edition", reading);
  app.get("/daily/:channel/:key/supplement/:supplement", reading);
}
