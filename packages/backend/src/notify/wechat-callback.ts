// Signed, owner-only callbacks. No raw XML, OpenID or signature is stored or logged.
import { createHash, timingSafeEqual } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { credential } from "../config.ts";
import { sql, type Db } from "../db.ts";
import type { WechatResult } from "./wechat.ts";

export interface IncomingWechat { to: string; from: string; at: number; type: string; text: string; event: string; eventKey: string; messageId: string; status: string }

export function validWechatSignature(query: Record<string, unknown>, now = Date.now()): boolean {
  const token = credential("integrations", "WECHAT_CALLBACK_TOKEN");
  const { signature, timestamp, nonce } = query;
  if (!token || typeof signature !== "string" || !/^[a-f0-9]{40}$/i.test(signature) || typeof timestamp !== "string" || !/^\d{9,11}$/.test(timestamp)
      || typeof nonce !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(nonce) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export function parseWechatCallback(xml: string): IncomingWechat | null {
  if (Buffer.byteLength(xml) > 16_384 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) return null;
  const parsed = new XMLParser({ ignoreAttributes: true, parseTagValue: false, processEntities: false, trimValues: false }).parse(xml);
  if (Object.keys(parsed).filter(k => k !== "?xml").join(",") !== "xml") return null;
  const row = parsed.xml;
  if (!row || Array.isArray(row) || typeof row !== "object" || row.Encrypt) return null;
  const str = (k: string, max = 128) => typeof row[k] === "string" && row[k].length <= max ? row[k].trim() : "";
  const to = str("ToUserName"), from = str("FromUserName"), at = str("CreateTime");
  if (!to || !from || !/^\d{9,11}$/.test(at)) return null;
  return { to, from, at: Number(at), type: str("MsgType"), text: str("Content", 4096), event: str("Event"), eventKey: str("EventKey"),
    messageId: str("MsgID") || str("MsgId"), status: str("Status") };
}

export function wechatTextReply(message: IncomingWechat, text: string): string {
  const cdata = (s: string) => `<![CDATA[${s.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
  return `<xml><ToUserName>${cdata(message.from)}</ToUserName><FromUserName>${cdata(message.to)}</FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content>${cdata(text)}</Content></xml>`;
}

export async function applyWechatDeliveryEvent(message: IncomingWechat): Promise<void> {
  const appId = credential("integrations", "WECHAT_APP_ID");
  const openId = credential("integrations", "WECHAT_OPEN_ID");
  const status = ({ success: "success", "failed:user block": "user_block", "failed: system failed": "system_failed", "failed:system failed": "system_failed" } as Record<string, string>)[message.status];
  if (!appId || message.from !== openId || !/^\d{1,20}$/.test(message.messageId) || !status || message.at * 1000 > Date.now() + 60_000) return;
  await sql.begin(async tx => {
    await tx`SET LOCAL statement_timeout='1500ms'`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`wechat:${appId}:${message.messageId}`},0))`;
    await tx`INSERT INTO wechat_delivery_events(app_id,message_id,recipient_hash,status,provider_at)
      VALUES(${appId},${message.messageId},${createHash("sha256").update(message.from).digest("hex")},${status},${new Date(message.at * 1000)})
      ON CONFLICT(app_id,message_id) DO NOTHING`;
    await reconcileWechatDelivery(appId, message.messageId, tx);
  });
}

export async function recordWechatSend(deliveryId: number, result: WechatResult): Promise<void> {
  const appId = credential("integrations", "WECHAT_APP_ID");
  await sql.begin(async tx => {
    if (appId && result.messageId) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`wechat:${appId}:${result.messageId}`},0))`;
    await tx`UPDATE deliveries SET status=${result.status},response=${result.response},sent_at=${result.status === "sent" ? new Date() : null},
      wechat_delivery_status=CASE WHEN wechat_message_id IS DISTINCT FROM ${result.messageId ?? null}
        OR wechat_app_id IS DISTINCT FROM ${result.messageId ? appId : null} THEN NULL ELSE wechat_delivery_status END,
      wechat_delivery_at=CASE WHEN wechat_message_id IS DISTINCT FROM ${result.messageId ?? null}
        OR wechat_app_id IS DISTINCT FROM ${result.messageId ? appId : null} THEN NULL ELSE wechat_delivery_at END,
      wechat_message_id=${result.messageId ?? null},wechat_app_id=${result.messageId ? appId : null},updated_at=now() WHERE id=${deliveryId}`;
    if (appId && result.messageId) await reconcileWechatDelivery(appId, result.messageId, tx);
  });
}

/** Handles callbacks that arrive before the sender has finished recording API acceptance. */
export async function reconcileWechatDelivery(appId: string, messageId: string, db: Db = sql): Promise<void> {
  await db`UPDATE deliveries d SET wechat_delivery_status=e.status,wechat_delivery_at=e.provider_at,updated_at=now()
    FROM wechat_delivery_events e WHERE d.wechat_app_id=e.app_id AND d.wechat_message_id=e.message_id
      AND e.app_id=${appId} AND e.message_id=${messageId}
      AND d.wechat_delivery_status IS NULL`;
}
