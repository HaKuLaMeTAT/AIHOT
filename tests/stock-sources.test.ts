import { enableLocalModelStub, stub, tag } from "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { sql,closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { announcementPage, collectAnnouncements, ANNOUNCEMENT_SOURCES } from "@aihot/backend/sources/stock-announcements";
import { collectMarket, marketSession, quoteTimestamp, MARKET_SOURCE } from "@aihot/backend/sources/stock-market";
import { promoteAnnouncement, composeMarketMaterial } from "@aihot/backend/sources/stock";
import { parseStockPdf } from "@aihot/backend/content/stock-pdf";
import { STOCK } from "@aihot/industry/stock";
import { processingPriority } from "@aihot/industry/processing";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { upsertMaterial } from "@aihot/backend/content/materials";
import type { StockJsonFetch } from "@aihot/backend/sources/stock-http";
const T=tag();
const day="2022-03-08", now=new Date(`${day}T10:00:00+08:00`);
const base=String(Date.now()).slice(-9);
const local=await stub(()=>({}));
before(async()=>{
 for(const id of [...Object.values(ANNOUNCEMENT_SOURCES),MARKET_SOURCE]) await sql`INSERT INTO sources(id,name,kind,tier,first_party,participation_mode)
   VALUES (${id},${id},'external','T1',true,'editorial') ON CONFLICT DO NOTHING`;
 config.modelCallsEnabled=false;
});
after(async()=>{await local.close();await stopBoss();await closeDb();});
function ann(i:number, market="sh", d=day){return {announcementId:`${base}${i}`,secCode:market==="sh"?"600001":market==="sz"?"000001":"920001",secName:"公司",
 announcementTitle:i===0?"重大资产重组公告":`公告 ${i}`,announcementTime:new Date(`${d}T09:50:00+08:00`).getTime(),adjunctUrl:`finalpage/${d}/${base}${i}.PDF`};}

test("recent policies, technical releases and major announcements reach the queue before history", async () => {
  const at = new Date();
  const material = { source_id: "rss-official-ai", first_party: true, title: "New model release", published_at: at, discovered_at: at };
  const technical = processingPriority(material, at.getTime());
  assert.ok(processingPriority({ ...material, source_id: "web-pboc-news", title: "货币政策工具调整" }, at.getTime()) > technical);
  assert.ok(processingPriority({ ...material, source_id: "web-pboc-news", title: "关于金融支持服务业扩能提质的指导意见" }, at.getTime()) > technical);
  assert.ok(processingPriority({ ...material, source_id: "rss-hkex-news", title: "HKEX Launches A Place to Connect Exhibition" }, at.getTime()) < technical);
  assert.ok(processingPriority({ ...material, source_id: ANNOUNCEMENT_SOURCES.sh, title: "重大资产重组公告" }, at.getTime()) > technical);
  assert.ok(technical > processingPriority({ ...material, title: "公司活动回顾" }, at.getTime()));
  assert.equal(processingPriority({ ...material, published_at: new Date(at.getTime() - 96 * 3600_000) }, at.getTime()), -2);
  assert.ok(processingPriority({ ...material, published_at: null }, at.getTime()) > 0);
  process.env.EDITORIAL_PRIORITY_RECENT = "true";
  try {
    const source = `stock-priority-${T}`;
    await sql`INSERT INTO sources(id,name,kind,tier,first_party,participation_mode,next_fetch_at)
      VALUES(${source},'优先级测试','external','T1',true,'editorial','2100-01-01')`;
    const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.com/priority-${T}`, title: "重大资产重组公告",
      bodyText: "原始公告内容", bodyStatus: "ok", via: "fetch", publishedAt: at });
    await queueProcessing(articleId);
    const [job] = await sql`SELECT priority FROM pgboss.job WHERE name='content.analyze' AND data->>'articleId'=${articleId}`;
    assert.equal(job.priority, 42);
  } finally { delete process.env.EDITORIAL_PRIORITY_RECENT; }
});

test("announcement pages reject mismatched dates and unsafe links without guessing identity",()=>{
 const parsed=announcementPage({totalAnnouncement:1,announcements:[ann(0)]},"sh",day);
 assert.equal(parsed.items[0].title,"重大资产重组公告");
 assert.throws(()=>announcementPage({totalAnnouncement:1,announcements:[{...ann(0),adjunctUrl:"https://attacker.invalid/doc.pdf"}]},"sh",day));
 assert.throws(()=>announcementPage({totalAnnouncement:1,announcements:[ann(0,"sh","2022-03-07")]},"sh",day));
 assert.throws(()=>announcementPage({totalAnnouncement:0,announcements:"not an array"},"sh",day));
});

test("bounded announcement paging exceeds the ordinary 60-item cap and resumes on the next run",async()=>{
 const fetcher:StockJsonFetch=async(_url,opts)=>{
  const form=new URLSearchParams(opts?.body),d=form.get("seDate")!.split("~")[0],page=Number(form.get("pageNum"));
  assert.equal(form.get("sortName"),"");assert.equal(form.get("sortType"),"");
  if(d!==day)return {totalAnnouncement:0,announcements:[]};
  return {totalAnnouncement:210,totalpages:7,announcements:Array.from({length:30},(_,i)=>ann((page-1)*30+i))};
 };
 const first=await collectAnnouncements("sh",now,fetcher);
 assert.equal(first.pages,STOCK.announcementPagesPerRun);
 const [scan]=await sql`SELECT next_page,complete FROM stock_announcement_scans WHERE source_id=${ANNOUNCEMENT_SOURCES.sh} AND day=${day}`;
 assert.equal(scan.complete,false);
 const second=await collectAnnouncements("sh",new Date(now.getTime()+15*60_000),fetcher);
 assert.ok(second.pages>0);
 const [count]=await sql`SELECT count(*)::int AS n,bool_and(baseline) AS baseline FROM stock_announcements WHERE source_id=${ANNOUNCEMENT_SOURCES.sh} AND day=${day}`;
 assert.equal(count.n,210);assert.equal(count.baseline,true);
 const [done]=await sql`SELECT complete FROM stock_announcement_scans WHERE source_id=${ANNOUNCEMENT_SOURCES.sh} AND day=${day}`;
 assert.equal(done.complete,true);
 assert.equal((await sql`SELECT 1 FROM articles WHERE source_id=${ANNOUNCEMENT_SOURCES.sh}`).length,0,"indexing does not enqueue every document");
});

test("current-day paging makes progress alongside an unfinished previous day",async()=>{
 const d="2022-03-11",at=new Date(`${d}T10:00:00+08:00`);
 const fetcher:StockJsonFetch=async(_url,opts)=>{
  const form=new URLSearchParams(opts?.body),requested=form.get("seDate")!.split("~")[0],page=Number(form.get("pageNum"));
  return {totalAnnouncement:900,announcements:Array.from({length:30},(_,i)=>ann((requested===d?1000:2000)+(page-1)*30+i,"bj",requested))};
 };
 assert.equal((await collectAnnouncements("bj",at,fetcher)).pages,6);
 const rows=await sql`SELECT day,count(*)::int AS n FROM stock_announcements WHERE source_id=${ANNOUNCEMENT_SOURCES.bj} AND day IN (${d},'2022-03-10') GROUP BY day ORDER BY day`;
 assert.deepEqual(rows.map(r=>r.n),[90,90]);
});

test("a failed page never advances the last committed checkpoint",async()=>{
 const d="2022-03-09",at=new Date(`${d}T10:00:00+08:00`);
 let hit=0;
 const fetcher:StockJsonFetch=async(_url,opts)=>{
  const form=new URLSearchParams(opts?.body),requested=form.get("seDate")!.split("~")[0];
  if(requested!==d)return {totalAnnouncement:0,announcements:[]};
  if(++hit>1)throw new Error("local page failure");
  return {totalAnnouncement:90,announcements:Array.from({length:30},(_,i)=>ann(300+i,"sz",d))};
 };
 await assert.rejects(collectAnnouncements("sz",at,fetcher),/local page failure/);
 const [scan]=await sql`SELECT next_page FROM stock_announcement_scans WHERE source_id=${ANNOUNCEMENT_SOURCES.sz} AND day=${d}`;
 assert.equal(scan.next_page,2);
});

test("market polling respects sessions and rejects a prior-day holiday quote before loading events",async()=>{
 assert.equal(marketSession(new Date("2022-03-12T10:00:00+08:00")),false);
 assert.equal(marketSession(new Date(`${day}T12:00:00+08:00`)),false);
 let requests=0;
 const fetcher:StockJsonFetch=async()=>{requests++;throw new Error("should not fetch");};
 const result=await collectMarket(now,fetcher,async()=>new Date("2022-03-07T15:00:00+08:00"));
 assert.equal(result.status,"skipped");assert.equal(requests,0);
 await assert.rejects(collectMarket(now,fetcher,async()=>{throw new Error("local quote unavailable");}),/local quote unavailable/);
 const [health]=await sql`SELECT fail_count,last_error FROM sources WHERE id=${MARKET_SOURCE}`;
 assert.equal(health.fail_count,1);assert.match(health.last_error,/local quote unavailable/);assert.equal(requests,0);
 const fields=Array(31).fill("");fields[2]="000001";fields[30]="20220308100000";
 assert.equal(quoteTimestamp(`v_sh000001="${fields.join("~")}";`).toISOString(),now.toISOString());
 assert.throws(()=>quoteTimestamp('v_sh000001="no timestamp";'));
});

test("market observations exclude old/future events, dedupe repeats, and baseline the first poll",async()=>{
 let recent=95500;
 const fetcher:StockJsonFetch=async(url)=>{
  if(url.includes("getAllBK"))return {rc:0,data:{allbk:[{c:"BK0001",n:"板块",u:"2.1",ct:100}]}};
  const type=new URL(url).searchParams.get("type");
  return {rc:0,data:{tc:3,allstock:[{c:"600001",n:"公司",t:Number(type),tm:recent,i:"raw"},
   {c:"600002",n:"太早",t:Number(type),tm:93000,i:"raw"},{c:"600003",n:"未来",t:Number(type),tm:110000,i:"raw"}]}};
 };
 const first=await collectMarket(now,fetcher,async()=>now);
 assert.equal(first.baseline,true);assert.equal(first.events,6);
 assert.equal((await collectMarket(now,fetcher,async()=>now)).events,0);
 recent=100100;
 const next=new Date(now.getTime()+5*60_000);
 assert.equal((await collectMarket(next,fetcher,async()=>next)).events,6);
 const [counts]=await sql`SELECT count(*)::int AS n,count(*) FILTER (WHERE NOT baseline)::int AS live FROM stock_market_events WHERE day=${day}`;
 assert.equal(counts.n,12);assert.equal(counts.live,6);
});

test("market summary is created once and goes through normal editorial processing",async()=>{
 await enableLocalModelStub(local.url);
 const at=new Date(`${day}T15:05:00+08:00`);
 const result=await composeMarketMaterial(at);
 assert.equal(result.status,"queued");
 const again=await composeMarketMaterial(at);
 assert.equal(again.status,"existing");
 const [article]=await sql`SELECT body_text,processing_state FROM articles WHERE id=${result.articleId!}`;
 assert.ok(article.body_text.includes("不代表全市场总数"));assert.equal(article.processing_state,"new");
 assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${result.articleId!}`).length,0);
});

test("five PDF attempts cap successes and failures without changing selection thresholds",async()=>{
 const d="2022-03-10",at=new Date(`${d}T10:00:00+08:00`);
 for(let i=0;i<8;i++)await sql`INSERT INTO stock_announcements(id,source_id,day,code,name,title,pdf_url,published_at,baseline,priority)
  VALUES (${`${T}-${i}`},${ANNOUNCEMENT_SOURCES.sh},${d},'600001','公司','重大重组',${`https://static.cninfo.com.cn/finalpage/${d}/${i}.PDF`},${at},false,30)`;
 let attempts=0;
 const fake=async()=>{attempts++;if(attempts===1)throw new Error("local PDF failure");return "原文证据".repeat(40);};
 for(let i=0;i<8;i++)await promoteAnnouncement(at,fake);
 assert.equal(attempts,5);
 const [counts]=await sql`SELECT count(*) FILTER (WHERE state='queued')::int AS queued,count(*) FILTER (WHERE state='failed')::int AS failed FROM stock_announcements WHERE day=${d}`;
 assert.equal(counts.queued,4);assert.equal(counts.failed,1);
});

test("isolated PDF parser extracts a local document and rejects non-PDF bytes",{skip: !process.env.STOCK_PDF_TEST_LIB},async()=>{
 const text="A verified announcement with readable original evidence. ".repeat(4);
 const content=`BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
 const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
 let pdf="%PDF-1.4\n",offsets=[0];
 objects.forEach((obj,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
 const xref=pdf.length;pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 const library=process.env.STOCK_PDF_TEST_LIB!;
 assert.ok((await parseStockPdf(Buffer.from(pdf),library)).includes("verified announcement"));
 await assert.rejects(parseStockPdf(Buffer.from("not PDF"),library),/signature rejected/);
});
