// One active model call per channel, including auxiliary judgements and the manual API fallback.
import { ProviderRejectedError } from "./receipts.ts";

let active = 0;
const channels = new Set<string>();
const waiting: Array<{ channel: string; grant: () => void }> = [];

function dispatch() {
  const limit = process.env.CODEX_CONCURRENCY === "2" ? 2 : 1;
  while (active < limit) {
    const index = waiting.findIndex((w) => !channels.has(w.channel));
    if (index < 0) return;
    const [next] = waiting.splice(index, 1);
    active++; channels.add(next!.channel); next!.grant();
  }
}

export async function acquireModelSlot(channel: string, timeoutMs: number): Promise<() => void> {
  await new Promise<void>((resolve, reject) => {
    const entry = { channel, grant: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
      reject(new ProviderRejectedError("Codex queue wait exceeded deadline; no subprocess started", null, true));
    }, timeoutMs);
    waiting.push(entry); dispatch();
  });
  return () => { active--; channels.delete(channel); dispatch(); };
}
