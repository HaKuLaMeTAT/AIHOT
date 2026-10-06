// Official changelog sections are individual materials, with date precision kept in raw metadata.
import * as cheerio from "cheerio";
import { sanitizeBody } from "../content/sanitize.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { FetchError, type Candidate } from "./types.ts";

function day(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) {
    throw new FetchError("Invalid changelog publication date");
  }
  return date;
}

function material(title: string, id: string, html: string, base: string, date: Date): Candidate {
  if (!title || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new FetchError("Invalid changelog section identity");
  const url = `${base.replace(/#.*$/, "")}#${id}`;
  const bodyHtml = sanitizeBody(html, base), bodyText = stripTags(bodyHtml);
  if (!bodyText.trim()) throw new FetchError("Empty changelog section body");
  return { title, url, identityKey: `url:${url}`, publishedAt: date, bodyHtml, bodyText, bodyStatus: "ok",
    raw: { _aihot: { datePrecision: "day" } } };
}

export function openAiChangelog(html: string, base: string): Candidate[] {
  const $ = cheerio.load(html);
  const out: Candidate[] = [];
  $("li[id][data-product]").each((_i, node) => {
    const row = $(node), title = collapseWhitespace(row.find("h3").first().text());
    const date = day(collapseWhitespace(row.find("time").first().text()));
    out.push(material(title, row.attr("id")!, row.find("article").first().html() ?? "", base, date));
  });
  if (!out.length || new Set(out.map(c => c.url)).size !== out.length) throw new FetchError("OpenAI changelog sections missing or duplicated");
  return out;
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTH = new RegExp(`^(${MONTHS.join("|")})(?: (\\d{4}))?$`);

export function xAiReleases(html: string, base: string): Candidate[] {
  const $ = cheerio.load(html);
  const headings = $("h2").toArray().filter(n => MONTH.test(collapseWhitespace($(n).text())));
  const years = new Map<object, number>();
  let year: number | null = null, previousMonth = 0;
  // The archive explicitly names past years. Infer unlabelled newer months from that anchor,
  // never from the computer's current year (which would redetermine old publication dates).
  for (const n of [...headings].reverse()) {
    const match = MONTH.exec(collapseWhitespace($(n).text()))!;
    const month = MONTHS.indexOf(match[1]!) + 1;
    if (match[2]) {
      const explicit = Number(match[2]);
      if (year !== null && (explicit < year || explicit === year && month < previousMonth)) throw new FetchError("Unordered xAI release archive");
      year = explicit;
    } else {
      if (year === null) throw new FetchError("xAI release archive has no year anchor");
      if (month < previousMonth) year++;
    }
    years.set(n, year); previousMonth = month;
  }
  const out: Candidate[] = [];
  let sectionYear: number | null = null, sectionMonth = "";
  $("h2,h3[id]").each((_i, node) => {
    const head = $(node);
    if (head.is("h2")) {
      sectionYear = years.get(node) ?? null;
      sectionMonth = MONTH.exec(collapseWhitespace(head.text()))?.[1] ?? "";
      return;
    }
    if (sectionYear === null) return;
    const content = head.closest("div.min-w-0"), row = content.parent();
    const printed = collapseWhitespace(row.children().first().text());
    const dateMatch = /^(\w+) (\d{1,2})$/.exec(printed);
    if (!content.length || !dateMatch || dateMatch[1] !== sectionMonth && dateMatch[1] !== sectionMonth.slice(0,3)) throw new FetchError("Invalid xAI release section date");
    const date = day(`${sectionYear}-${String(MONTHS.indexOf(sectionMonth)+1).padStart(2,"0")}-${dateMatch[2]!.padStart(2,"0")}`);
    const body = content.clone(); body.find("h3").first().remove();
    out.push(material(`Grok · ${collapseWhitespace(head.text())}`, head.attr("id")!, body.html() ?? "", base, date));
  });
  if (!out.length || new Set(out.map(c => c.url)).size !== out.length) throw new FetchError("xAI release sections missing or duplicated");
  return out;
}
