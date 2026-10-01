import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import http from "node:http";
import { collectSource } from "@aihot/backend/sources/collect";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
after(async()=>{await stopBoss();await closeDb();});
test("a rolling collection window excludes the archive on both initial and subsequent fetches",async()=>{
 const saved=config.allowPrivateNetworkFetch;
 const age=process.env.COLLECT_MAX_AGE_HOURS;
 config.allowPrivateNetworkFetch=true;process.env.COLLECT_MAX_AGE_HOURS='72';
 const source=`window-${tag()}`;
 const server=http.createServer((_req,res)=>{
  res.setHeader('content-type','application/rss+xml');
  res.end(`<rss version="2.0"><channel><title>Local</title><item><title>新政策</title><link>https://example.com/${source}/new</link><pubDate>${new Date().toUTCString()}</pubDate></item><item><title>旧政策</title><link>https://example.com/${source}/old</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>`);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const {port}=server.address() as {port:number};
 try{
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${source},'local window','rss',${sql.json({feedUrl:`http://127.0.0.1:${port}/rss`})})`;
  assert.equal((await collectSource(source,{force:true})).created,1);
  assert.equal((await collectSource(source,{force:true})).created,0);
  const rows=await sql`SELECT title FROM articles WHERE source_id=${source}`;
  assert.deepEqual(rows.map(r=>r.title),['新政策']);
 }finally{
  config.allowPrivateNetworkFetch=saved;
  if(age===undefined)delete process.env.COLLECT_MAX_AGE_HOURS;else process.env.COLLECT_MAX_AGE_HOURS=age;
  await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
});
