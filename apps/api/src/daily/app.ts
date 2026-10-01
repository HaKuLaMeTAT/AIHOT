import Fastify from "fastify";
import { registerDaily } from "../routes/daily.ts";
import { registerWechatCallback } from "../routes/wechat.ts";

/** Tunnel listener: public reading and signed owner-only WeChat callbacks; no generic/admin API. */
export function buildReadingApp() {
  const app = Fastify({ logger: false, bodyLimit: 1024, requestTimeout: 15_000 });
  registerDaily(app);
  registerWechatCallback(app);
  app.setNotFoundHandler((_req, reply) => reply.code(404).header("Cache-Control", "no-store").send());
  app.setErrorHandler((_error, _req, reply) => reply.code(503).header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("日报暂时无法读取，请稍后再试。"));
  return app;
}
