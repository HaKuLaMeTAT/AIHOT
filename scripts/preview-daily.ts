// Read-only preview; does not call models, reserve a delivery or contact WeChat.
import { previewDaily } from "@aihot/backend/notify/daily";
import { closeDb } from "@aihot/backend/db";
const channel = process.argv[2] ?? "ai";
if (channel !== "ai" && channel !== "stock") throw new Error("Usage: preview-daily.ts [ai|stock]");
try {
  const edition = await previewDaily(channel);
  console.log(JSON.stringify({ channel, key: edition.key, edition: edition.edition, windowStart: edition.start, windowEnd: edition.end,
    entries: edition.entries.length, messages: edition.messages }, null, 2));
} finally { await closeDb(); }
