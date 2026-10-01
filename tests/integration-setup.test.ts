import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { ensureContentTargets } from "@aihot/backend/notify/deliver";

const folder = await mkdtemp(path.join(tmpdir(), "integrations-test-"));
const file = path.join(folder, "env");
const key = "test-only-private-key";
const fields = '{"title":"title","summary":"summary","source":"source","time":"time"}';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const repo = path.resolve(import.meta.dirname, '..');
const env = { PATH: process.env.PATH, HOME: process.env.HOME };

async function reset() {
  await writeFile(file, `DATABASE_URL=${config.databaseUrl}\nLLM_PROVIDER=codex\nCODEX_MODEL=gpt-6-luna\nLLM_MODEL=deepseek-flash\nLLM_API_KEY=${key}\nLLM_BASE_URL=https://api.deepseek.com/v1\nWECHAT_APP_ID=test-app\nWECHAT_APP_SECRET=test-secret\nWECHAT_OPEN_ID=test-user\nWECHAT_TEMPLATE_ID=test-template\nWECHAT_TEMPLATE_FIELDS=${fields}\nMODEL_CALLS_ENABLED=false\nCOLLECT_ENABLED=false\nWECHAT_PUSH_ENABLED=false\n`, { mode: 0o600 });
}
async function run(script: string, args: string[]) {
  return promisify(execFile)(process.execPath, ['--env-file', file, path.join(repo,'scripts',script), ...args, '--env-file', file], { env });
}
before(async () => { await ensureContentTargets(); });
after(async () => {
  await sql`UPDATE notify_targets SET enabled=false,enabled_at=NULL WHERE key='wechat-personal'`;
  await rm(folder, { recursive: true, force: true }); await closeDb();
});

test("DeepSeek switch refuses unverified or changed credentials without touching the main provider", async () => {
  await reset();
  await assert.rejects(run('switch-model.ts',['deepseek']));
  assert.match(await readFile(file,'utf8'), /LLM_PROVIDER=codex/);
  await writeFile(path.join(folder,'deepseek-verified.json'), JSON.stringify({ keyHash:hash('previous-key'),receiptId:1,model:'deepseek-flash',baseUrl:'https://api.deepseek.com/v1' }));
  await assert.rejects(run('switch-model.ts',['deepseek']));
  assert.match(await readFile(file,'utf8'), /LLM_PROVIDER=codex/);
});

test("verified manual switching preserves the API key and can return to Codex", async () => {
  await reset();
  const [original] = await sql`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='llm'`;
  try {
    await sql`UPDATE budgets SET per_minute=6,per_hour=60,per_day=300 WHERE service='llm'`;
    const [receipt] = await sql`INSERT INTO receipts (logical_key,service,model,purpose,status,response)
      VALUES (${`verification-${tag()}`},'llm','deepseek-flash','deployment_connectivity','completed','{}') RETURNING id`;
    await writeFile(path.join(folder,'deepseek-verified.json'), JSON.stringify({ keyHash:hash(key),receiptId:receipt.id,model:'deepseek-flash',baseUrl:'https://api.deepseek.com/v1' }));
    await run('switch-model.ts',['deepseek']);
    assert.match(await readFile(file,'utf8'), /LLM_PROVIDER=api/);
    assert.match(await readFile(file,'utf8'), new RegExp(`LLM_API_KEY=${key}`));
    await run('switch-model.ts',['codex']);
    assert.match(await readFile(file,'utf8'), /LLM_PROVIDER=codex/);
  } finally {
    await sql`UPDATE budgets SET per_minute=${original.per_minute},per_hour=${original.per_hour},per_day=${original.per_day} WHERE service='llm'`;
  }
});

test("WeChat activation needs an accepted test for the current credentials and template", async () => {
  await reset();
  await sql`UPDATE notify_targets SET enabled=false WHERE key='wechat-personal'`;
  await assert.rejects(run('enable-wechat.ts',['--enable']));
  assert.equal((await sql`SELECT enabled FROM notify_targets WHERE key='wechat-personal'`)[0].enabled, false);
  const signature = hash(JSON.stringify(['test-app','test-secret','test-user','test-template',fields]));
  await writeFile(path.join(folder,'wechat-verified.json'), JSON.stringify({ signature, status:'accepted' }));
  await run('enable-wechat.ts',['--enable']);
  assert.equal((await sql`SELECT enabled FROM notify_targets WHERE key='wechat-personal'`)[0].enabled, true);
  const floor = (await sql`SELECT enabled_at FROM notify_targets WHERE key='wechat-personal'`)[0].enabled_at;
  await run('enable-wechat.ts',['--enable']);
  assert.equal((await sql`SELECT enabled_at FROM notify_targets WHERE key='wechat-personal'`)[0].enabled_at.getTime(), floor.getTime());
  await run('enable-wechat.ts',['--disable']);
  assert.equal((await sql`SELECT enabled FROM notify_targets WHERE key='wechat-personal'`)[0].enabled, false);
});
