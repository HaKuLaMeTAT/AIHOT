import { guardedFetch, type GuardedFetchOptions } from "../lib/http-fetch.ts";
import { FetchError } from "./types.ts";

export type StockJsonFetch = (url: string, options?: GuardedFetchOptions) => Promise<any>;
export const stockJson: StockJsonFetch = async (url, options = {}) => {
  const response = await guardedFetch(url, { timeoutMs: 8000, maxBytes: 1024 * 1024, ...options });
  if (response.status !== 200) throw new FetchError(`Stock source HTTP ${response.status}`, response.status);
  try { return JSON.parse(response.text()); }
  catch { throw new FetchError("Stock source response is not JSON"); }
};
