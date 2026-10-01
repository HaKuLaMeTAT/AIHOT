import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { codexCompletion } from "@aihot/backend/providers/codex";
import { chatJson } from "@aihot/backend/providers/llm";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { BudgetExceededError, ReceiptUnknownError, ProviderRejectedError } from "@aihot/backend/providers/receipts";

const dir = await mkdtemp(path.join(tmpdir(), "news-cli-test-"));
const fake = path.join(dir, "codex");
const old = { ...process.env };
before(async () => {
  await writeFile(fake, `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2);let input='';
for await(const part of process.stdin) input+=part;
const overlap=/OVERLAP:(\\w+)/.exec(input);
if(overlap){fs.appendFileSync(${JSON.stringify(path.join(dir, "overlap.jsonl"))},JSON.stringify({name:overlap[1],event:'start',at:Date.now()})+'\\n');await new Promise(r=>setTimeout(r,250));fs.appendFileSync(${JSON.stringify(path.join(dir, "overlap.jsonl"))},JSON.stringify({name:overlap[1],event:'end',at:Date.now()})+'\\n');}
if(input.includes('TIMEOUT')) await new Promise(r=>setTimeout(r,10000));
const assertions=['--ignore-user-config','--ephemeral','--skip-git-repo-check','--output-schema'];
if(!assertions.every(a=>args.includes(a))||process.env.DATABASE_URL||process.env.WECHAT_APP_SECRET||process.env.LLM_API_KEY)process.exit(9);
if(input.includes('CHECK_TMPDIR')&&process.env.TMPDIR!==${JSON.stringify(dir)})process.exit(10);
if(input.includes('TOOL'))console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:4}}));
const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
if(input.includes('NATIVE_JSON')&&(!schema.properties.ok||schema.properties.content||!input.includes('Do not wrap it')))process.exit(11);
const data=input.includes('NATIVE_WRONG')?{ok:'wrong'}:{ok:true};
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(schema.properties.content?{content:JSON.stringify(data)}:data));
`, { mode: 0o700 });
  Object.assign(process.env, { CODEX_BIN: fake, CODEX_MODEL: "gpt-6-luna", LLM_PROVIDER: "codex", WECHAT_APP_SECRET: "must-not-inherit", LLM_API_KEY: "must-not-inherit" });
});
after(async () => {
  for (const k of ["CODEX_BIN", "CODEX_MODEL", "LLM_PROVIDER", "WECHAT_APP_SECRET", "LLM_API_KEY", "CODEX_CONCURRENCY"]) {
    if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k];
  }
  config.modelCallsEnabled = false;
  await rm(dir, { recursive: true, force: true });
  await closeDb();
});
const ask = (subject: string, user = "verify") => chatJson({ model: "default", purpose: "cli_test", subject, promptVersion: "v1", system: "Return JSON", user: `${user} ${subject}`, schema: z.object({ ok: z.boolean() }) });
test("CLI transport strips application secrets, parses usage and reuses a receipt", async () => {
  config.modelCallsEnabled = true;
  const subject = `cli:${tag()}`;
  const a = await ask(subject);
  const b = await ask(subject);
  assert.equal(a.data.ok, true);
  assert.equal(b.reused, true);
  assert.equal(a.receiptId, b.receiptId);
  assert.equal(a.usage!.input_tokens, 12);
  const [r] = await sql<{ service: string; model: string }[]>`SELECT service, model FROM receipts WHERE id = ${a.receiptId}`;
  assert.deepEqual(r, { service: "codex", model: "gpt-6-luna" });
});
test("CLI subprocess uses the configured temporary data directory", async () => {
  const previous = process.env.TMPDIR;
  try {
    process.env.TMPDIR = dir;
    const result = await codexCompletion({ model: "fake", system: "s", user: "CHECK_TMPDIR", timeoutMs: 2000 });
    assert.ok(result.response);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
});
test("configuring an HTTP fallback leaves Codex receipts reusable", async () => {
  const names = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_EXTRA_JSON"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    config.modelCallsEnabled = true;
    process.env.LLM_EXTRA_JSON = "";
    const subject = `fallback-config:${tag()}`;
    const before = await ask(subject);
    Object.assign(process.env, { LLM_BASE_URL: "https://api.deepseek.com/v1", LLM_API_KEY: "test-fallback-key",
      LLM_MODEL: "deepseek-flash", LLM_EXTRA_JSON: '{"thinking":{"type":"disabled"}}' });
    const after = await ask(subject);
    assert.equal(after.reused, true);
    assert.equal(after.receiptId, before.receiptId);
  } finally {
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  }
});
test("CLI calls obey the model valve and budget before spawning", async () => {
  config.modelCallsEnabled = false;
  await assert.rejects(ask(`off:${tag()}`), /disabled/);
  config.modelCallsEnabled = true;
  const [saved] = await sql<{ per_minute: number }[]>`SELECT per_minute FROM budgets WHERE service = 'codex'`;
  try {
    await sql`UPDATE budgets SET per_minute = 0 WHERE service = 'codex'`;
    await assert.rejects(ask(`budget:${tag()}`), BudgetExceededError);
  } finally { await sql`UPDATE budgets SET per_minute = ${saved!.per_minute} WHERE service = 'codex'`; }
});
test("tool activity leaves an unknown receipt and does not trigger another call", async () => {
  config.modelCallsEnabled = true;
  const subject = `tool:${tag()}`;
  await assert.rejects(ask(subject, "TOOL"));
  await assert.rejects(ask(subject, "TOOL"), ReceiptUnknownError);
  const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE r.subject=${subject}`;
  assert.equal(r!.n, 1);
});
test("timeout kills the subprocess and releases the serialization lock", async () => {
  await assert.rejects(codexCompletion({ model: "fake", system: "s", user: "TIMEOUT", timeoutMs: 100 }), /timed out/);
  const result = await codexCompletion({ model: "fake", system: "", user: "Return JSON", timeoutMs: 2000 });
  assert.ok(result.response);
});

test("queue wait shares the call deadline and expires before another subprocess starts", async () => {
  const first = codexCompletion({ model: "fake", system: "s", user: "TIMEOUT", timeoutMs: 200 });
  const second = codexCompletion({ model: "fake", system: "s", user: "verify", timeoutMs: 50 });
  const [a, b] = await Promise.allSettled([first, second]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "rejected");
  if (b.status === "rejected") assert.ok(b.reason instanceof ProviderRejectedError);
});

test("two CLI slots overlap different channels while preserving one slot per channel", async () => {
  process.env.CODEX_CONCURRENCY = "2";
  try {
    const run = (channel: "ai" | "stock", name: string) => codexCompletion({ model: "fake", system: "s", user: `OVERLAP:${name}`, channel, timeoutMs: 4000 });
    await Promise.all([run("ai", "ai1"), run("ai", "ai2"), run("stock", "stock1")]);
    const events = (await readFile(path.join(dir, "overlap.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { name: string; event: string; at: number });
    const at = (name: string, event: string) => events.find((e) => e.name === name && e.event === event)!.at;
    assert.ok(at("ai1", "start") < at("stock1", "end") && at("stock1", "start") < at("ai1", "end"), "AI and stock overlap, without AI's waiting item blocking stock");
    assert.ok(at("ai2", "start") >= at("ai1", "end"), "AI remains serial");
  } finally { delete process.env.CODEX_CONCURRENCY; }
});


test("native structured CLI output constrains task fields, validates them and reuses receipts", async () => {
  config.modelCallsEnabled = true;
  const subject = `native:${tag()}`;
  const opts = { model: "default", purpose: "cli_native", subject, promptVersion: "v1", system: "Return JSON",
    user: `NATIVE_JSON ${subject}`, schema: z.object({ ok: z.boolean() }),
    codexOutputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };
  const first = await chatJson(opts);
  const second = await chatJson(opts);
  assert.equal(first.data.ok, true);
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(second.reused, true);
  await assert.rejects(chatJson({ ...opts, subject: `invalid:${tag()}`, user: "NATIVE_JSON NATIVE_WRONG" }), /unusable output/);
});
