import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { config } from "@aihot/backend/config";
import { STOCK, hongKongAnnouncementPriority } from "@aihot/industry/stock";
import { hongKongAnnouncementPage, collectHongKongAnnouncements, HKEX_ANNOUNCEMENT_SOURCES } from "@aihot/backend/sources/hkex-announcements";
import { processingPriority } from "@aihot/industry/processing";
import { trustedAnnouncementPdf } from "@aihot/backend/content/stock-pdf";
import { promoteAnnouncement, announcementUsage } from "@aihot/backend/sources/stock";

after(async () => { await stopBoss(); await closeDb(); });
const board = "sehk";
const sourceId = HKEX_ANNOUNCEMENT_SOURCES[board];
const now = new Date("2021-04-09T10:00:00+08:00");
function row(id: number, title = "年度業績公告", time = "09/04/2021 09:50") {
  return { newsId: id, t1Code: "10000", ext: "pdf", title, relTime: time, stock: [{ sc: "00700", sn: "測試公司" }],
    webPath: `/listedco/listconews/sehk/2021/0409/20210409${id}_c.pdf` };
}
function page(rows: unknown[], pages = 5) { return { maxNumOfFile: pages, newsInfoLst: rows }; }

test("HKEX parsing keeps original issuer identity and Hong Kong publication time, excluding routine forms", () => {
  const parsed = hongKongAnnouncementPage(page([row(101), { ...row(102), t1Code: "51500" }, { ...row(103), t1Code: "50000" }]), board);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0]!.code, "00700");
  assert.equal(parsed.items[0]!.publishedAt.toISOString(), "2021-04-09T01:50:00.000Z");
  assert.ok(hongKongAnnouncementPriority(parsed.items[0]!.title) > 0);
  // A republished/corrected disclosure can retain its original PDF filename date.
  assert.equal(hongKongAnnouncementPage(page([{ ...row(105), webPath: "/listedco/listconews/sehk/2021/0409/20210408105_c.pdf" }]), board).items.length, 1);
  assert.equal(processingPriority({ source_id: sourceId, title: "盈利警告", first_party: true, published_at: now, discovered_at: now }, now.getTime()), 42);
  assert.throws(() => hongKongAnnouncementPage(page([{ ...row(104), webPath: "https://evil.example/a.pdf" }]), board));
  assert.throws(() => hongKongAnnouncementPage(page([{ ...row(104), relTime: "31/02/2021 09:50" }]), board));
  assert.throws(() => hongKongAnnouncementPage(page([{ ...row(104), webPath: "/listedco/listconews/gem/2021/0409/20210409104_c.pdf" }]), board));
  assert.throws(() => hongKongAnnouncementPage({ maxNumOfFile: 101, newsInfoLst: [] }, board));
  assert.equal(trustedAnnouncementPdf(parsed.items[0]!.pdfUrl), true);
  for (const url of ["https://www1.hkexnews.hk.evil.example/listedco/listconews/sehk/2021/0409/20210409101_c.pdf",
    parsed.items[0]!.pdfUrl + "?next=https://evil.example", parsed.items[0]!.pdfUrl.replace("https:", "http:")]) {
    assert.equal(trustedAnnouncementPdf(url), false);
  }
});

test("HKEX indexing repeats the head, resumes bounded older pages and keeps a stable activation baseline", async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,first_party,participation_mode) VALUES(${sourceId},'local HKEX','external','T1',true,'editorial')
    ON CONFLICT(id) DO UPDATE SET enabled=true,cursor=NULL,next_fetch_at=NULL`;
  const hits: number[] = [];
  const fetcher = async (url: string) => { const n = Number(/_(\d+)\.json$/.exec(url)![1]); hits.push(n); return page([row(200+n)]); };
  assert.equal((await collectHongKongAnnouncements(board, now, fetcher)).status, "ok");
  assert.deepEqual(hits, [1, 2, 3]);
  const [baseline] = await sql`SELECT count(*)::int AS n,bool_and(baseline) AS baseline FROM stock_announcements WHERE source_id=${sourceId}`;
  assert.equal(baseline.n, 3); assert.equal(baseline.baseline, true);
  assert.equal((await sql`SELECT 1 FROM articles WHERE source_id=${sourceId}`).length, 0);
  hits.length = 0;
  const later = new Date(now.getTime()+30*60_000);
  await collectHongKongAnnouncements(board, later, async url => {
    const n = Number(/_(\d+)\.json$/.exec(url)![1]); hits.push(n);
    return page(n === 1 ? [row(299, "盈利警告", "09/04/2021 10:15"), row(201)] : [row(200+n)]);
  });
  assert.deepEqual(hits, [1, 4, 5]);
  const [newItem] = await sql`SELECT baseline,priority FROM stock_announcements WHERE id='hkex:sehk:299'`;
  assert.equal(newItem.baseline, false); assert.equal(newItem.priority, 30);
  const [oldItem] = await sql`SELECT baseline FROM stock_announcements WHERE id='hkex:sehk:201'`;
  assert.equal(oldItem.baseline, true);
  const [source] = await sql`SELECT cursor FROM sources WHERE id=${sourceId}`;
  assert.equal(source.cursor.hkexNextPage, 2);
  assert.equal(source.cursor.hkexEnabledAt, now.toISOString());
});

test("failed HKEX pages retain the last committed index and checkpoint", async () => {
  const later = new Date(now.getTime()+60*60_000);
  const result = await collectHongKongAnnouncements(board, later, async url => {
    if (url.endsWith('_2.json')) throw new Error("local page failure");
    return page([row(300, "內幕消息", "09/04/2021 10:45")]);
  });
  assert.equal(result.status, "failed");
  const [source] = await sql`SELECT cursor,health FROM sources WHERE id=${sourceId}`;
  assert.equal(source.cursor.hkexNextPage, 2); assert.equal(source.health, "degraded");
  assert.equal((await sql`SELECT 1 FROM stock_announcements WHERE id='hkex:sehk:300'`).length, 1);
});

test("Hong Kong PDF attempts, including failures, consume both the sublimit and shared document quota", async () => {
  const at = new Date(now.getTime()+90*60_000);
  const saved = config.modelCallsEnabled; config.modelCallsEnabled = true;
  try {
    await sql`UPDATE stock_announcements SET priority=0 WHERE source_id=${sourceId}`;
    for (let i=0;i<STOCK.hongKongDocumentsPerDay+1;i++) {
      await sql`INSERT INTO stock_announcements(id,source_id,day,code,name,title,pdf_url,published_at,baseline,priority)
        VALUES(${'hk-quota-'+i},${sourceId},'2021-04-09','00700','測試公司','盈利警告',${'https://www1.hkexnews.hk/listedco/listconews/sehk/2021/0409/20210409'+(400+i)+'_c.pdf'},${at},false,30)`;
    }
    let attempts = 0;
    const extractor = async () => { attempts++; throw new Error("local PDF failure"); };
    for (let i=0;i<STOCK.hongKongDocumentsPerDay;i++) assert.equal((await promoteAnnouncement(at, extractor)).status, "failed");
    assert.equal((await promoteAnnouncement(at, extractor)).status, "skipped");
    assert.equal(attempts, STOCK.hongKongDocumentsPerDay);
    assert.equal((await announcementUsage(at)).rollingUsed, STOCK.hongKongDocumentsPerDay);
  } finally { config.modelCallsEnabled = saved; }
});
