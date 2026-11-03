/** Test-only placeholder-aware fetch (step 1's direct fetch, replaced by the pipeline's `coreFetch` in step 2): swaps
 * `hortus-secret-<name>` in `Authorization` for the vault.json value (read on every call), then the global fetch. */
import { readFileSync } from "node:fs";
import * as paths from "../paths.ts";

/** Only credentials in `names` are swapped; any other placeholder goes out as is (upstream refuses it). */
export function directFetch(names: string[]): (url: string, init?: RequestInit) => Promise<Response> {
  const allowed = new Set(names);
  return (url, init = {}) => {
    const headers = new Headers(init.headers);
    const auth = headers.get("authorization");
    if (auth?.includes("hortus-secret-")) {
      const vault = JSON.parse(readFileSync(paths.vault(), "utf8")) as Record<string, { value?: string }>;
      const swap = (m: string, n: string) => (allowed.has(n) && vault[n]?.value) || m;
      headers.set("authorization", auth.replace(/hortus-secret-([\w.-]+)/g, swap));
    }
    return fetch(url, { ...init, headers });
  };
}
