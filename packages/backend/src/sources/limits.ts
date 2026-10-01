import { identityKeyFor } from "../content/materials.ts";
import type { Candidate } from "./types.ts";

export function candidateIdentity(c: Candidate, sourceId: string): string {
  return identityKeyFor({ ...c, sourceId, via: "fetch" });
}

/** Existing revisions do not spend new-item slots; duplicate listing entries spend only one. */
export function limitNewCandidates(candidates: Candidate[], sourceId: string, known: Set<string>, remaining: number): { candidates: Candidate[]; deferred: number } {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  let deferred = 0;
  for (const c of candidates) {
    const key = candidateIdentity(c, sourceId);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!known.has(key)) {
      if (remaining <= 0) { deferred++; continue; }
      remaining--;
    }
    out.push(c);
  }
  return { candidates: out, deferred };
}
