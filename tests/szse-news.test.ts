import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromSzseNews } from "@aihot/backend/sources/web-list";
import type { SourceRow } from "@aihot/backend/sources/types";
const source = { config: { allowUrlPrefixes: ["https://www.szse.cn/aboutus/trends/news/t"] } } as unknown as SourceRow;
const base = "https://www.szse.cn/aboutus/trends/news/index.html";
test("SZSE rows use active literals, ignore commented titles and never execute scripts", () => {
 const html = `<ul class="newslist"><li><script>var curHref = './t20260930_1.html';\n //var curTitle = '旧标题';\n var curTitle ='新制度实施';\nthrow Error('do not execute');</script><span class="time">2026-09-30</span></li><li><script>var curHref='javascript:evil()';var curTitle='无效链接';</script></li></ul>`;
 const items = fromSzseNews(html,base,source);
 assert.equal(items.length,1); assert.equal(items[0]!.title,"新制度实施");
 assert.equal(items[0]!.url,"https://www.szse.cn/aboutus/trends/news/t20260930_1.html");
 assert.equal(items[0]!.publishedAt!.toISOString().slice(0,10),"2026-09-30");
});
test("a changed or empty SZSE listing fails visibly",()=>assert.throws(()=>fromSzseNews('<ul></ul>',base,source),/no news rows/));
