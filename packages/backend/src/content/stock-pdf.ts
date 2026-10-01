import { spawn } from "node:child_process";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";

export async function extractStockPdf(url: string): Promise<string> {
  if (!/^https:\/\/static\.cninfo\.com\.cn\/finalpage\/\d{4}-\d{2}-\d{2}\/\d+\.pdf$/i.test(url)) throw new Error("Untrusted announcement PDF URL");
  const library = process.env.STOCK_PDF_LIB;
  if (!library) throw new Error("STOCK_PDF_LIB not configured");
  const response = await guardedFetch(url, { timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024 });
  if (response.status !== 200 || response.body.subarray(0, 5).toString() !== "%PDF-") throw new Error("Announcement PDF unavailable");
  return parseStockPdf(response.body, library);
}

/** stdin and a fixed local script; no application secrets, network access or shell are needed. */
export function parseStockPdf(bytes: Buffer, library: string, python = process.env.STOCK_PDF_PYTHON || "/usr/bin/python3"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-I", path.join(REPO_ROOT, "scripts/extract-stock-pdf.py"), library], { env: { LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", settled = false;
    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(text!);
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("PDF extraction timed out")); }, 20_000);
    child.on("error", () => finish(new Error("PDF extractor could not start")));
    child.stdin.on("error", () => {});
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 256_000) { child.kill("SIGKILL"); finish(new Error("PDF output exceeds limit")); }
    });
    child.on("close", (code) => {
      try {
        const parsed = JSON.parse(output);
        if (code !== 0 || typeof parsed.text !== "string" || parsed.text.length < 100 || parsed.text.length > 60_000) throw new Error(parsed.error || "PDF extraction failed");
        finish(undefined, parsed.text);
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid PDF extraction output")); }
    });
    child.stdin.end(bytes);
  });
}
