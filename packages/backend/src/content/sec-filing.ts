import { parseHTML } from "linkedom";
import { guardedFetch } from "../lib/http-fetch.ts";
import { stripTags } from "../lib/text.ts";
import { sanitizeBody } from "./sanitize.ts";
import type { ExtractedBody } from "./extract.ts";

/** Only a 99.1 HTML exhibit in this exact filing directory can supplement its main document. */
export function secEarningsExhibit(html: string, mainUrl: string): string | null {
  const main = new URL(mainUrl);
  if (main.origin !== "https://www.sec.gov" || !/^\/Archives\/edgar\/data\/\d+\/\d{18}\/[\w-]+\.html?$/.test(main.pathname)) return null;
  const directory = main.pathname.slice(0, main.pathname.lastIndexOf("/") + 1);
  const { document } = parseHTML(html);
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (!/99[._-]?1|exhibit\s*99\.1|press\s*release/i.test(`${href} ${a.textContent}`)) continue;
    try {
      const u = new URL(href, mainUrl);
      if (u.origin === main.origin && !u.username && !u.password && !u.search && u.pathname.startsWith(directory)
          && /^[\w-]+\.html?$/.test(u.pathname.slice(directory.length)) && u.pathname !== main.pathname) {
        u.hash = "";
        return u.href;
      }
    } catch { /* malformed links are not evidence */ }
  }
  return null;
}

function filingText(html: string, url: string): string {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("script,style,nav,header,footer")) node.remove();
  // Preserve financial tables and inline XBRL values rather than relying on a prose-only reader.
  return stripTags(sanitizeBody(document.body?.innerHTML || html, url));
}

export async function extractSecFiling(url: string): Promise<ExtractedBody | null> {
  const main = new URL(url);
  if (main.origin !== "https://www.sec.gov" || !/^\/Archives\/edgar\/data\/\d+\/\d{18}\/[\w-]+\.html?$/.test(main.pathname)) return null;
  const response = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024, maxRedirects: 0 });
  if (response.status !== 200 || !/html/i.test(response.headers.get("content-type") ?? "")) return null;
  const html = response.text();
  const primary = filingText(html, url);
  if (primary.length < 200) return null;
  const exhibit = secEarningsExhibit(html, url);
  let supplement = "";
  if (exhibit) {
    try {
      const extra = await guardedFetch(exhibit, { timeoutMs: 20_000, maxBytes: 3 * 1024 * 1024, maxRedirects: 0 });
      const text = extra.status === 200 && /html/i.test(extra.headers.get("content-type") ?? "") ? filingText(extra.text(), exhibit) : "";
      supplement = text.length >= 200 ? `\n\n【同一申报的附件原文：${exhibit}】\n${text.slice(0, 30_000)}`
        : "\n\n【附件原文未取得；不得根据主文推断附件中的业绩数字。】";
    } catch {
      supplement = "\n\n【附件原文未取得；不得根据主文推断附件中的业绩数字。】";
    }
  }
  const text = primary.slice(0, 30_000) + (primary.length > 30_000 ? "\n【主文仅保留前 30,000 字符，其余内容未进入分析。】" : "") + supplement;
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return { text, html: `<p>${escaped.replaceAll("\n", "<br>")}</p>`, images: [], via: "readability" };
}
