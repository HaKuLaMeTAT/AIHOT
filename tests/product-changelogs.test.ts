import { test } from "node:test";
import assert from "node:assert/strict";
import { openAiChangelog, xAiReleases } from "@aihot/backend/sources/product-changelogs";

const base = "https://official.example/releases";
function release(id: string, printed: string, text = "A newly available model.") {
  return `<div class="grid"><div>${printed}</div><div class="min-w-0"><span><h3 id="${id}">Model ${id}</h3></span><p>${text}</p></div></div>`;
}

test("OpenAI updates keep each section's body, date and stable fragment identity", () => {
  const html = '<li id="release-one" data-product="codex"><time>2026-10-05</time><h3>New Codex model</h3><article><p>Available to users.</p></article></li>'
    + '<li id="release-two" data-product="chatgpt"><time>2026-10-06</time><h3>New usage limits</h3><article><p>A separate change.</p></article></li>';
  const items = openAiChangelog(html, base);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.url, base + "#release-one");
  assert.equal(items[0]!.publishedAt!.toISOString(), "2026-10-05T00:00:00.000Z");
  assert.match(items[0]!.bodyText!, /Available to users/);
  assert.doesNotMatch(items[0]!.bodyText!, /separate change/);
  assert.equal((items[0]!.raw as any)._aihot.datePrecision, "day");
  for (const bad of [html.replace('2026-10-05','2026-02-31'), html.replace('id="release-two"','id="release-one"'), '<h2>Navigation only</h2>']) {
    assert.throws(() => openAiChangelog(bad, base));
  }
});

test("xAI dates use an explicit archive year across New Year and accept printed month abbreviations", () => {
  const html = '<h2>February</h2>'+release('new-model','Feb 2')+'<h2>January</h2>'+release('price-change','January 8')
    + '<h2>December 2025</h2>'+release('old-model','Dec 31');
  const items = xAiReleases(html, base);
  assert.deepEqual(items.map(c => c.publishedAt!.toISOString().slice(0,10)), ['2026-02-02','2026-01-08','2025-12-31']);
  assert.equal(items[0]!.identityKey, 'url:'+base+'#new-model');
  assert.doesNotMatch(items[0]!.bodyText!, /price-change|old-model/);
  for (const bad of [html.replace('<h2>December 2025</h2>','<h2>December</h2>'),html.replace('Feb 2','Feb 31'),html.replace('Feb 2','March 2')]) {
    assert.throws(() => xAiReleases(bad, base));
  }
});
