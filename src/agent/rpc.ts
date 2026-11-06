/** RPCs from inside a task to `<task.rpc>/rpc/<method>` (the proxy stamps the caller's task). Used by `dof` and tools. */
import { request } from "node:http";

export async function taskRpc<T>(base: string, method: string, input: unknown): Promise<T> {
  const local = process.env.HORTUS_RPC_LOCAL;
  const res = local
    ? await loopback(`${process.env.HORTUS_RPC}/rpc/${method}`, local, JSON.stringify(input))
    : await fetch(`${base}/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const e = body as { error?: { code?: string; message?: string }; message?: string } | undefined;
    throw Object.assign(new Error(e?.error?.message ?? e?.message ?? `${res.status} ${text}`), {
      code: e?.error?.code,
    });
  }
  // hortusd.internal wraps results as {result}; a bare value is taken as is
  return (body && typeof body === "object" && "result" in body ? body.result : body) as T;
}

/**
 * HORTUS_NO_NET=1 (tests): no DNS or DNAT for hortusd.internal, so the request goes to the proxy's plain listener on
 * 127.0.0.1 from the session's loopback alias, which is how the proxy knows the task.
 */
function loopback(
  url: string,
  localAddress: string,
  body: string,
): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", localAddress, headers: { host: "hortusd.internal", "content-type": "application/json" } },
      (res) => {
        let t = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          t += c;
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, text: async () => t });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
