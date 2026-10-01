// SEC submissions are columnar. Only original, material company filings enter editorial work.
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

const FORMS = new Set(["8-K", "10-Q", "10-K", "6-K", "20-F"]);
const ITEMS: Record<string, string> = {
  "1.01": "重大协议", "1.02": "重大协议终止", "1.03": "破产",
  "2.01": "收购或资产处置", "2.02": "业绩披露", "2.03": "重大债务",
  "2.04": "债务触发事件", "2.05": "重组", "2.06": "资产减值",
  "3.01": "上市资格风险", "4.02": "财务报告可靠性", "5.01": "控制权变更",
  "5.02": "高管或董事变动", "7.01": "公平披露", "8.01": "其他重大事项",
};

export function fromSecSubmissions(data: unknown, source: SourceRow): Candidate[] {
  const d = data as Record<string, any> | null;
  const cik = String(source.config.cik ?? "");
  const ticker = String(source.config.ticker ?? "");
  if (!/^\d{10}$/.test(cik) || !ticker || !d || String(d.cik).padStart(10, "0") !== cik || !d.tickers?.includes(ticker) || typeof d.name !== "string") {
    throw new FetchError("SEC company identity mismatch");
  }
  const r = d.filings?.recent;
  const fields = ["accessionNumber", "form", "primaryDocument", "acceptanceDateTime", "items"];
  if (!r || !fields.every(k => Array.isArray(r[k]) && r[k].length === r.accessionNumber?.length)) throw new FetchError("invalid SEC recent filings columns");
  const out: Candidate[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = String(r.form[i]);
    const baseForm = form.replace(/\/A$/, "");
    if (!FORMS.has(baseForm)) continue;
    const items = String(r.items[i] ?? "").split(",").map(s => s.trim()).filter(Boolean);
    if (baseForm === "8-K" && !items.some(k => k in ITEMS)) continue;
    const accession = String(r.accessionNumber[i]);
    const doc = String(r.primaryDocument[i]);
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession) || !/^[a-zA-Z0-9_-]+\.html?$/.test(doc)) throw new FetchError("invalid SEC filing document identity");
    // TSM's monthly share-count filings are routine; its revenue and operating releases remain eligible.
    if (baseForm === "6-K" && /monthend/i.test(doc)) continue;
    const date = new Date(r.acceptanceDateTime[i]);
    if (!Number.isFinite(date.getTime()) || !/Z$|[+-]\d\d:\d\d$/.test(String(r.acceptanceDateTime[i]))) throw new FetchError("invalid SEC acceptance timestamp");
    const labels = items.filter(k => k in ITEMS).map(k => ITEMS[k]);
    const description = String(r.primaryDocDescription?.[i] ?? "");
    out.push({
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/${doc}`,
      title: `${d.name}（${ticker}）· ${form}${labels.length ? ` · ${labels.join("、")}` : ""}`,
      excerpt: `SEC 原始申报：${form}。${items.length ? `披露项目：${items.join(", ")}。` : ""}${description}`,
      publishedAt: date, bodyStatus: "pending", raw: { cik, ticker, form, accession, items },
    });
  }
  return out;
}
