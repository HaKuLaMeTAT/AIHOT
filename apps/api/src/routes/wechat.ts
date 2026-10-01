import type { FastifyInstance } from "fastify";
import { credential } from "@aihot/backend/config";
import { applyWechatDeliveryEvent, parseWechatCallback, validWechatSignature, wechatTextReply } from "@aihot/backend/notify/wechat-callback";
import { answerWechatQuery } from "@aihot/backend/notify/wechat-query";

export function registerWechatCallback(app: FastifyInstance, answer = answerWechatQuery) {
  const cache = new Map<string, { until: number; reply: Promise<string> }>();
  let minute = 0, count = 0;
  app.addContentTypeParser(["text/xml", "application/xml"], { parseAs: "string" }, (_req, body, done) => done(null, body));
  const enabled = () => process.env.WECHAT_CALLBACK_ENABLED === "true";
  app.get("/wechat/callback", async (req, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex, nofollow");
    if (!enabled()) return reply.code(404).send();
    const q = req.query as Record<string, unknown>;
    if (!validWechatSignature(q) || typeof q.echostr !== "string" || q.echostr.length > 1024) return reply.code(403).send();
    return reply.type("text/plain; charset=utf-8").send(q.echostr);
  });
  app.post("/wechat/callback", { bodyLimit: 16_384 }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!enabled()) return reply.code(404).send();
    if (!validWechatSignature(req.query as Record<string, unknown>)) return reply.code(403).send();
    const message = typeof req.body === "string" ? parseWechatCallback(req.body) : null;
    if (!message) return reply.code(400).send();
    if (message.from !== credential("integrations", "WECHAT_OPEN_ID")) return reply.type("text/plain").send("success");
    if (message.type === "event" && message.event === "TEMPLATESENDJOBFINISH") {
      await applyWechatDeliveryEvent(message);
      return reply.type("text/plain").send("success");
    }
    const command = message.type === "text" ? message.text : message.type === "event" && message.event === "CLICK" ? message.eventKey : "";
    if (!command) return reply.type("text/plain").send("success");
    const now = Date.now();
    for (const [key, value] of cache) if (value.until < now) cache.delete(key);
    const key = `${message.at}:${message.messageId || message.eventKey}:${message.type}`;
    const previous = cache.get(key);
    if (previous) return reply.type("application/xml; charset=utf-8").send(await previous.reply);
    const current = Math.floor(now / 60_000); if (current !== minute) { minute = current; count = 0; }
    if (++count > 30) return reply.type("application/xml; charset=utf-8").send(wechatTextReply(message, "查询过于频繁，请稍后再试。"));
    // Bounded retries reuse their original response; no worker jobs or model calls are created.
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<string>(resolve => { timer = setTimeout(() => resolve("查询暂时较慢，请稍后重试。不会触发额外模型调用。"), 3500); timer.unref(); });
    const result = Promise.race([answer(command), timeout]).catch(() => "暂时未能读取结果，请稍后重试。不会触发额外模型调用。")
      .finally(() => clearTimeout(timer))
      .then(text => wechatTextReply(message, text));
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, { until: now + 300_000, reply: result });
    return reply.type("application/xml; charset=utf-8").send(await result);
  });
}
