export function wechatMenu(base: string) {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error("A fixed HTTPS reading origin is required");
  const view = (name: string, path: string) => ({ type: "view", name, url: new URL(path, url).href });
  return { button: [view("AI 日报", "/daily/ai/latest"), view("股市日报", "/daily/stock/latest"),
    { name: "更多", sub_button: [view("AI 历史日报", "/daily/ai/history"), view("股市历史日报", "/daily/stock/history"), { type: "click", name: "服务状态", key: "NEWS_STATUS" }] }] as const };
}

/** No messages are sent. Provider errors contain only a code, never echoed tokens or URLs. */
export async function configureWechatMenu(appId: string, secret: string, base: string, savePrevious: (data: unknown) => Promise<void>, fetcher: typeof fetch = fetch): Promise<void> {
  const menu = wechatMenu(base);
  const api = "https://api.weixin.qq.com";
  const read = async (url: string, init?: RequestInit) => {
    try {
      const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
      const data = await res.json() as Record<string, any>;
      if (!res.ok) throw new Error();
      return data;
    } catch { throw new Error("WeChat configuration request failed; no credential was printed"); }
  };
  let token = await read(`${api}/cgi-bin/stable_token`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credential", appid: appId, secret, force_refresh: false }) });
  if (!token.access_token && [48001, 40002].includes(Number(token.errcode))) {
    token = await read(`${api}/cgi-bin/token?${new URLSearchParams({ grant_type: "client_credential", appid: appId, secret })}`);
  }
  if (typeof token.access_token !== "string") throw new Error(`WeChat token unavailable (code=${Number(token.errcode) || "unknown"})`);
  const auth = `access_token=${encodeURIComponent(token.access_token)}`;
  const previous = await read(`${api}/cgi-bin/menu/get?${auth}`);
  if (previous.errcode !== undefined && previous.errcode !== 46003 && previous.errcode !== 0) throw new Error(`WeChat menu query rejected (code=${Number(previous.errcode)})`);
  await savePrevious(previous);
  const result = await read(`${api}/cgi-bin/menu/create?${auth}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(menu) });
  if (result.errcode !== 0) throw new Error(`WeChat menu creation rejected (code=${Number(result.errcode) || "unknown"})`);
  const verified = await read(`${api}/cgi-bin/menu/get?${auth}`);
  const actual = verified.menu?.button;
  if (!Array.isArray(actual) || actual.length !== 3 || actual[0]?.url !== menu.button[0]!.url || actual[1]?.url !== menu.button[1]!.url
      || actual[2]?.sub_button?.[2]?.key !== "NEWS_STATUS") throw new Error("WeChat menu verification did not match the submitted menu");
}
