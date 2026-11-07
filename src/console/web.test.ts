/** The web UI from dist/web (built by `pnpm build`), next to /api and /events. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { z } from "zod";
import { load } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { define } from "../rpc.ts";
import { tempDir } from "../test/until.ts";
import { type Console, startServer } from "./server.ts";

process.env.HORTUS_HOME = tempDir("hortus-web-");
const ctx: Ctx = { config: load(), db: openDb(paths.db()), paths, log: logger, async reload() {} };
const dist = new URL("../web/", import.meta.url);
const index = readFileSync(new URL("index.html", dist), "utf8");
let web: Console;

define("web.ping", { roles: ["owner"], input: z.unknown(), run: () => ({ pong: true }) });

before(async () => {
  web = await startServer(ctx, 0);
});
after(() => web.close());

interface Res {
  status: number;
  type: string | undefined;
  csp: string | string[] | undefined;
  body: string;
}

/** The raw path goes on the wire: `http.request` does not normalize it, as `fetch` would. */
function get({ port }: Console, path: string, method = "GET"): Promise<Res> {
  const post = method === "POST" ? { "content-type": "application/json", "x-hortus": "1" } : {};
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, method, headers: post }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          type: res.headers["content-type"],
          csp: res.headers["content-security-policy"],
          body,
        }),
      );
    })
      .on("error", reject)
      .end();
  });
}

test("the assets on the list are served with their types and the console's CSP", async () => {
  const files = readdirSync(new URL("assets/", dist));
  for (const [ext, type] of [
    [".js", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
  ] as const) {
    const file = files.find((f) => f.endsWith(ext));
    assert.ok(file, ext);
    const r = await get(web, `/assets/${file}`);
    assert.equal(r.status, 200);
    assert.equal(r.type, type);
    assert.equal(r.body, readFileSync(new URL(`assets/${file}`, dist), "utf8"));
  }
  assert.equal(
    (await get(web, "/")).csp,
    "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
  );
});

test("no request path reaches the filesystem", async () => {
  // on disk, but after the list was read
  const planted = new URL("assets/planted.js", dist);
  writeFileSync(planted, "planted");
  try {
    for (const path of [
      "/assets/planted.js",
      "/assets/../../package.json",
      "/assets/%2e%2e/index.html",
      "/assets/..%2f..%2fconfig.js",
      "/assets/",
      "/assets/nope.js",
      "/config.js",
    ]) {
      const r = await get(web, path);
      assert.deepEqual([path, r.status, r.body], [path, 200, index]);
    }
  } finally {
    rmSync(planted);
  }
});

test("any other GET is the app: a hard reload of a deep link", async () => {
  for (const path of ["/", "/tasks", "/tasks/abc", "/approvals/1/login", "/settings/general?x=1"]) {
    const r = await get(web, path);
    assert.deepEqual([path, r.status, r.type, r.body], [path, 200, "text/html; charset=utf-8", index]);
  }
  assert.equal((await get(web, "/", "HEAD")).body, "");
  assert.equal((await get(web, "/tasks/abc", "DELETE")).status, 405);
});

test("/api and /events are not the app", async () => {
  const pong = await get(web, "/api/web.ping", "POST");
  assert.deepEqual(JSON.parse(pong.body), { result: { pong: true } });
  for (const [path, method, status] of [
    ["/api/nope", "POST", 404],
    ["/api/web.ping", "GET", 404],
    ["/api", "GET", 404],
    ["/events", "GET", 404],
    ["/events/nope", "GET", 404],
    ["/events/a/b", "GET", 404],
    ["/tasks/abc/log", "GET", 404],
    ["/static/app.css", "GET", 200], // the old console's: no such file now, so the app (its Not found)
  ] as const) {
    const r = await get(web, path, method);
    assert.deepEqual([path, r.status, r.body === index], [path, status, status === 200]);
  }
  const stream = new AbortController();
  const r = await fetch(`http://127.0.0.1:${web.port}/events/tasks`, { signal: stream.signal });
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  stream.abort();
});
