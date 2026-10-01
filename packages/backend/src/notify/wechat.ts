// Official-account template API. An accepted request is not a delivery receipt; ambiguous sends
// are never retried. Credentials stay out of stored payloads, responses and error messages.
import { credential } from "../config.ts";
import { createHash } from "node:crypto";

export const WECHAT_TEMPLATES = { ai_daily: "WECHAT_AI_DAILY_TEMPLATE_ID", stock_daily: "WECHAT_STOCK_DAILY_TEMPLATE_ID", urgent: "WECHAT_URGENT_TEMPLATE_ID" } as const;

export interface WechatMessage {
  title: string;
  summary: string;
  source: string;
  time: string;
  url?: string;
  template?: keyof typeof WECHAT_TEMPLATES;
}

export function templateReady(message: WechatMessage): boolean {
  return !message.template || process.env.WECHAT_SEPARATE_TEMPLATES !== "true" || !!credential("integrations", WECHAT_TEMPLATES[message.template]);
}

export function wechatVerificationSignature(): string {
  const values = ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_OPEN_ID", "WECHAT_TEMPLATE_ID"].map((k) => credential("integrations", k));
  const signature: unknown[] = [...values, process.env.WECHAT_TEMPLATE_FIELDS ?? "default"];
  if (process.env.WECHAT_SEPARATE_TEMPLATES === "true") signature.push(...Object.values(WECHAT_TEMPLATES).map((k) => credential("integrations", k)));
  return createHash("sha256").update(JSON.stringify(signature)).digest("hex");
}

export interface WechatResult {
  status: "sent" | "failed" | "unknown";
  response: string;
  messageId?: string;
}

/** Deliberately brief fields; the linked reader or original carries the full explanation. */
export function briefWechat(message: WechatMessage): WechatMessage {
  const brief = (s: string) => {
    const chars = [...s.replace(/\s+/g, " ").trim()];
    return chars.length <= 20 ? chars.join("") : `${chars.slice(0, 19).join("")}…`;
  };
  return { ...message, title: brief(message.title), summary: brief(message.summary), source: brief(message.source), time: brief(message.time) };
}

type Fetch = typeof globalThis.fetch;
const API = "https://api.weixin.qq.com";

class TokenRejected extends Error {
  readonly code: number | undefined;
  readonly httpStatus: number;
  constructor(code: number | undefined, httpStatus: number) {
    super("WeChat token rejected");
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Injectable transport for local stub tests; production always uses the official HTTPS endpoint. */
export function createWechatSender(fetcher: Fetch = globalThis.fetch) {
  let cached: { appId: string; secret: string; token: string; until: number } | null = null;
  let pending: Promise<string> | null = null;

  async function token(appId: string, secret: string): Promise<string> {
    if (cached?.appId === appId && cached.secret === secret && cached.until > Date.now()) return cached.token;
    pending ??= (async () => {
      const query = new URLSearchParams({ grant_type: "client_credential", appid: appId, secret });
      const res = await fetcher(`${API}/cgi-bin/token?${query}`, { signal: AbortSignal.timeout(15_000) });
      const json = await res.json() as { access_token?: string; expires_in?: number; errcode?: number };
      if (!res.ok || !json.access_token || !json.expires_in) throw new TokenRejected(typeof json.errcode === "number" ? json.errcode : undefined, res.status);
      cached = { appId, secret, token: json.access_token, until: Date.now() + Math.max(1, json.expires_in - 120) * 1000 };
      return json.access_token;
    })();
    try { return await pending; } finally { pending = null; }
  }

  return async (message: WechatMessage): Promise<WechatResult> => {
    const appId = credential("integrations", "WECHAT_APP_ID");
    const secret = credential("integrations", "WECHAT_APP_SECRET");
    const openId = credential("integrations", "WECHAT_OPEN_ID");
    const templateId = credential("integrations", message.template && process.env.WECHAT_SEPARATE_TEMPLATES === "true" ? WECHAT_TEMPLATES[message.template] : "WECHAT_TEMPLATE_ID");
    if (!appId || !secret || !openId || !templateId) return { status: "failed", response: "WeChat credentials or template not configured" };
    let fields: Record<string, string>;
    try {
      fields = JSON.parse(process.env.WECHAT_TEMPLATE_FIELDS || '{"title":"title","summary":"summary","source":"source","time":"time"}');
      if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.entries(fields).some(([key, value]) => !["title", "summary", "source", "time"].includes(key) || typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(value)) || !Object.keys(fields).length) throw new Error();
    } catch {
      return { status: "failed", response: "Invalid WECHAT_TEMPLATE_FIELDS" };
    }
    const data = Object.fromEntries(Object.entries(fields).map(([key, field]) => [field, { value: message[key as keyof WechatMessage] ?? "" }]));
    // A public HTTPS reader or an original HTTP(S) source can carry the full explanation.
    const url = message.url && /^https?:\/\//i.test(message.url) ? message.url : undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let accessToken: string;
      try { accessToken = await token(appId, secret); }
      catch (error) {
        const detail = error instanceof TokenRejected ? ` (HTTP ${error.httpStatus}, errcode=${error.code ?? "unavailable"})` : "";
        return { status: "failed", response: `WeChat token could not be obtained${detail}; message was not sent` };
      }
      try {
        const res = await fetcher(`${API}/cgi-bin/message/template/send?access_token=${encodeURIComponent(accessToken)}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ touser: openId, template_id: templateId, url, data }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status >= 500) return { status: "unknown", response: `WeChat HTTP ${res.status}; delivery uncertain` };
        if (!res.ok) return { status: "failed", response: `WeChat HTTP ${res.status}` };
        const raw = await res.text();
        const json = JSON.parse(raw) as { errcode?: number; msgid?: number | string };
        // Never round a 64-bit message ID through JavaScript Number before matching its callback.
        const id = /"msgid"\s*:\s*(?:"(\d{1,20})"|(\d{1,20}))(?=\s*[,}])/.exec(raw);
        const messageId = id?.[1] ?? id?.[2];
        if ([40001, 40014, 42001].includes(json.errcode ?? 0) && attempt === 0) { cached = null; continue; }
        if (json.errcode === 0) return { status: "sent", ...(messageId ? { messageId } : {}), response: `WeChat accepted msgid=${messageId ?? "unknown"}; delivery unconfirmed` };
        return { status: typeof json.errcode === "number" ? "failed" : "unknown", response: `WeChat errcode=${json.errcode ?? "unparseable"}` };
      } catch {
        return { status: "unknown", response: "WeChat send interrupted; delivery uncertain" };
      }
    }
    return { status: "failed", response: "WeChat token rejected" };
  };
}

export const sendWechat = createWechatSender();
