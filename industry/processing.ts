// Queue order only: this does not change selection scores or publication boundaries.
import { announcementPriority } from "./stock.ts";

interface Material {
  source_id: string;
  title: string;
  first_party: boolean;
  published_at: Date | null;
  discovered_at: Date;
}

const POLICY = /政策|监管|条例|办法|规则|指导意见|金融支持|指引|征求意见|利率|降准|货币政策|工具调整|贷款|融资|guidance|regulation|rule|consultation|listing framework|interest rate|monetary|policy/i;
const TECH = /模型|发布|更新|推理|能力|开源|芯片|安全评估|model|launch|release|introduc|reasoning|capabilit|open.weight|gpu|speech|cyber/i;
const REGULATOR = /^(web-(pboc|csrc)|rss-(fed|sec)|rss-hkex-regulatory|stock-(cn-(nbs|mof)|us-(bls|bea)))/;
const STOCK_SOURCE = /^(stock-|web-(pboc|csrc|sse|szse)-|rss-(fed|sec|hkex)-)/;

export const PRIORITY_SOURCES = ["rss-openai-news", "rss-google-deepmind", "rss-hugging-face", "rss-microsoft-research",
  "rss-nvidia-blog", "rss-mistral", "web-csrc-news", "web-pboc-news", "web-sse-news", "web-szse-news"];

export function processingChannel(sourceId: string): "ai" | "stock" {
  return STOCK_SOURCE.test(sourceId) ? "stock" : "ai";
}

export function processingPriority(a: Material, now = Date.now()): number {
  // Arrival time must not make an old original look recent. Recent first-install material can run.
  const age = Math.max(0, now - (a.published_at ?? a.discovered_at).getTime());
  if (age > 72 * 3600_000) return -2;
  const announcement = a.source_id.startsWith("stock-") ? announcementPriority(a.title) : 0;
  const policy = a.first_party && REGULATOR.test(a.source_id) && POLICY.test(a.title);
  const technical = !STOCK_SOURCE.test(a.source_id) && (TECH.test(a.title) || a.source_id === "json-qwen-models");
  const filing = a.first_party && a.source_id.startsWith("stock-us-sec-");
  const rank = announcement > 0 || filing ? 4 : policy ? 4 : technical && a.first_party ? 3 : technical ? 2 : 1;
  return rank * 10 + (age <= 24 * 3600_000 ? 2 : age <= 48 * 3600_000 ? 1 : 0);
}
