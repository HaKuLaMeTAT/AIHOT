export type StockMarket = "sh" | "sz" | "bj";

export interface StockAnnouncementsQuery {
  market: StockMarket;
  code: string;
  from: string;
  to: string;
  limit: number;
  cursor: string | null;
}

export interface StockAnnouncementsResponse {
  schemaVersion: 1;
  asOf: string;
  query: { market: StockMarket; code: string; from: string; to: string; ordering: "publishedAtDesc" };
  items: Array<{
    id: string;
    code: string;
    name: string;
    title: string;
    publishedAt: string;
    firstSeenAt: string;
    baseline: boolean;
    processingState: "indexed" | "preparing" | "queued" | "failed";
    bodyStatus: "pending" | "ok" | "unconfirmed" | "none" | null;
    article: { id: string; url: string } | null;
    links: { original: string };
  }>;
  page: { count: number; hasMore: boolean; nextCursor: string | null };
  coverage: {
    scope: "cninfo_market_index";
    source: {
      id: string;
      name: string | null;
      enabled: boolean | null;
      health: string | null;
      lastAttemptAt: string | null;
      lastSuccessAt: string | null;
    };
    retentionDays: number;
    retainedFrom: string;
    days: Array<{
      date: string;
      scanComplete: boolean | null;
      expectedCount: number | null;
      indexedCount: number;
      updatedAt: string | null;
      gaps: Array<"outside_retention" | "not_scanned" | "scan_incomplete" | "count_mismatch" | "source_unavailable" | "source_disabled" | "source_degraded" | "source_stale" | "open_day">;
    }>;
  };
}
