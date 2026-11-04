/**
 * Step 3h on loopback (HORTUS_NO_NET=1): headless Chromium through the proxy to a fake site (dev.upstreams). The
 * Worker's browser is a BrowserSession pointed at a loopback alias registered as its session (127.0.0.2, task T) by
 * `--host-resolver-rules`; the login view does the same for itself (role login). The console runs on an ephemeral port
 * and the login flow is driven through its SSE and `login.input` endpoints, as the page's script does.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { browserTools } from "../agent/tools/browser.ts";
import { Config } from "../config.ts";
import { startServer } from "../console/server.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { links, listen, proxyModule } from "../proxy/index.ts";
import { call } from "../rpc.ts";
import * as tasks from "../runtime/tasks.ts";
import { type FakeSite, fakeSite, PASSWORD, SESSION, TOKEN, USER } from "../test/fakes/site.ts";
import { tempDir, until } from "../test/until.ts";
import type { TaskJson } from "../types.ts";
import { gate, transforms, vaultModule } from "../vault/index.ts";
import { invoke } from "../vault/transforms.ts";
import { connect, flags, launch } from "./cdp.ts";
import { jar, registrable } from "./jar.ts";
import { browserModule, IDLE } from "./login-view.ts";
import { BrowserSession } from "./tools.ts";

process.env.HORTUS_HOME = tempDir("hortus-browser-");
process.env.HORTUS_NO_NET = "1";
const hasChromium = existsSync("/usr/bin/chromium") || process.env.HORTUS_CHROMIUM !== undefined;

let site: FakeSite;
let ctx: Ctx;
let shared: { https: number; http: number };
let console_: Awaited<ReturnType<typeof startServer>>;
const sessions: BrowserSession[] = [];
/** the fixture site manifest: a form password, a body token capture, `GET /logout` consequential */
const fixtures = tempDir("hortus-browser-tf-");

before(async () => {
  site = await fakeSite();
  const hosts = ["fake.test", "app.fake.test", "other.test", "site.test", "idle.test"];
  ctx = {
    config: Config.parse({
      dev: { upstreams: Object.fromEntries(hosts.map((h) => [h, site.url])) },
      proxy: { https: 0, http: 0, dns: 0 },
      worker: { provider: "fake", model: "m" },
    }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  const insert = ctx.db.prepare(
    "INSERT INTO tasks(id, kind, title, brief, status, scope, origins, created, updated) VALUES (?, 'unattended', ?, 'b', 'running', ?, ?, 't', 't')",
  );
  const scope = JSON.stringify({ credentials: [], repos: [] });
  for (const id of ["T", "T3", "T4"]) insert.run(id, id, scope, null);
  insert.run("T2", "T2", scope, JSON.stringify(["fake.test"]));
  ctx.config.origins = "*";
  mkdirSync(join(fixtures, "fakesite"), { recursive: true });
  writeFileSync(
    join(fixtures, "fakesite", "manifest.json"),
    JSON.stringify({
      name: "fakesite",
      credentials: { fakesite: { type: "token", hosts: ["site.test"], locations: ["form:password"] } },
      captures: [{ path: "/api/token", json: "token" }],
      consequential: ["GET site.test/logout"],
    }),
  );
  writeFileSync(
    join(fixtures, "fakesite", "transform.js"),
    "export function request(req) { return req; }\nexport function response(res) { return { res }; }\n",
  );
  tasks.bind(ctx);
  await vaultModule.start(ctx);
  await proxyModule.start(ctx);
  await transforms.load([transforms.shippedDir(), fixtures]);
  gate.deps.inboxWrite = (id, m) => void tasks.inboxWrite(id, m);
  await browserModule.start(ctx);
  shared = await listen("127.0.0.1", { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" });
  for (const [a, t] of [
    ["127.0.0.2", "T"],
    ["127.0.0.3", "T3"],
    ["127.0.0.4", "T2"],
  ] as const)
    links.register(a, "worker", t, "session");
  console_ = await startServer(ctx, 0);
});

after(async () => {
  for (const s of sessions) await s.close();
  await browserModule.stop();
  await console_?.close();
  await proxyModule.stop();
  await vaultModule.stop();
  await site.close();
});

const workers = new Map<string, { s: BrowserSession; task: TaskJson }>();

/** A Worker browser for `task` (one per directory: a profile is one Chromium), its traffic from the session address. */
async function worker(
  id: string,
  address: string,
  dir = paths.task(id),
): Promise<{ s: BrowserSession; task: TaskJson }> {
  const have = workers.get(dir);
  if (have) return have;
  const p = await listen(address, { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" });
  const task = tasks.taskJson(ctx.config, tasks.get(id));
  task.paths.work = join(dir, "out", "work");
  mkdirSync(join(dir, "ctl", "inbox"), { recursive: true });
  const s = new BrowserSession(task, dir, {
    args: [`--host-resolver-rules=MAP *:443 ${address}:${p.https}, MAP *:80 ${address}:${p.http}`],
    caCert: join(paths.ca(), "ca.crt"),
  });
  sessions.push(s);
  workers.set(dir, { s, task });
  return { s, task };
}

/** A plain request to the proxy's shared plain listener from a session address. */
function raw(o: { host: string; path: string; method?: string; from?: string; headers?: Record<string, string> }) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port: shared.http,
        method: o.method ?? "GET",
        path: o.path,
        localAddress: o.from ?? "127.0.0.2",
        headers: { host: o.host, ...o.headers },
        agent: false,
      },
      (res) => {
        let b = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          b += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

const approvals = () => (ctx.db.prepare("SELECT count(*) AS n FROM approvals").get() as { n: number }).n;
const cookieRow = (origin: string, cookie: string) =>
  ctx.db
    .prepare(
      "SELECT name, value FROM captured WHERE origin = ? AND json_extract(meta, '$.cookieName') = ? ORDER BY id DESC",
    )
    .get(origin, cookie) as { name: string; value: string } | undefined;

// ---------------------------------------------------------------------------------------------------------------------

test("the registrable-domain rule (TypeScript and the cookie transform agree); the cookie transform's tests pass", () => {
  const cases: [string, string][] = [
    ["app.example.co.uk", "example.co.uk"],
    ["api.example.co.uk", "example.co.uk"],
    ["example.com", "example.com"],
    ["example.org", "example.org"],
    ["a.b.example.com", "example.com"],
    ["fake.test", "fake.test"],
    ["127.0.0.1", "127.0.0.1"],
  ];
  for (const [host, want] of cases) {
    assert.equal(registrable(host), want, host);
    assert.equal(invoke("cookie", "registrable", [host]), want, `transform: ${host}`);
  }
  assert.equal(registrable("app.example.co.uk"), registrable("api.example.co.uk"));
  assert.notEqual(registrable("example.com"), registrable("example.org"));
  for (const r of transforms.runTests("cookie")) assert.ok(r.ok, `${r.file}: ${r.diff}`);
});

test("CDP: navigate through the proxy, screenshot PNG, eval, tree, console", { skip: !hasChromium }, async () => {
  const { s } = await worker("T", "127.0.0.2");
  // TLS through the proxy: the leaf minted for the SNI verifies against the hortus CA (pinned by its SPKI)
  assert.match(await s.navigate("https://fake.test/"), /"anonymous" https:\/\/fake\.test\//);
  assert.match(await s.navigate("http://fake.test/"), /"anonymous" http:\/\/fake\.test\//);
  const png = await s.screenshot();
  assert.equal(png.mediaType, "image/png");
  assert.ok(
    Buffer.from(png.data, "base64")
      .subarray(0, 4)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  );
  assert.equal(await s.eval("1+1"), "2");
  assert.match(await s.tree(), /button "Press me"/);
  assert.match(await s.console(), /console\.log: hello from fake/);
  assert.ok(site.seen.some((x) => x.host === "fake.test" && x.path === "/"));
});

test("cookies: captured as a placeholder in the browser, the real value at the fake, scrubbed when echoed", {
  skip: !hasChromium,
}, async () => {
  const { s } = await worker("T", "127.0.0.2");
  await s.navigate("http://fake.test/set");
  const row = cookieRow("fake.test", "session");
  assert.ok(row, "captured");
  assert.equal(row.value, SESSION);
  assert.match(row.name, /^c-\d+$/);
  const ph = `hortus-secret-${row.name}`;
  assert.equal(await s.eval("document.cookie"), `session=${ph}`);
  await s.navigate("http://fake.test/echo");
  assert.equal(site.seen.at(-1)?.cookie, `session=${SESSION}`);
  // the page echoed the real value; what reached the browser is the placeholder
  assert.equal(await s.eval("document.getElementById('c').textContent"), `session=${ph}`);
  // the same placeholder to another site: destination
  const other = await raw({ host: "other.test", path: "/echo", headers: { cookie: `session=${ph}` } });
  assert.equal(other.status, 403);
  assert.match(other.body, /destination/);
});

test("captured requests: GET passes, POST asks per request; another task needs a grant first", {
  skip: !hasChromium,
}, async () => {
  const row = cookieRow("fake.test", "session");
  assert.ok(row);
  const cookie = { cookie: `session=hortus-secret-${row.name}` };
  const n = approvals();
  assert.equal((await raw({ host: "fake.test", path: "/me", headers: cookie })).status, 200);
  assert.equal(approvals(), n, "a GET with the task's own capture asks nothing");
  const post = await raw({ host: "fake.test", path: "/act", method: "POST", headers: cookie });
  assert.equal(post.status, 403);
  const id = (JSON.parse(post.body) as { approval: number; category: string }).approval;
  assert.equal(JSON.parse(post.body).category, "origin:fake.test");
  gate.decide(id, "approve", "owner");
  assert.equal((await raw({ host: "fake.test", path: "/act", method: "POST", headers: cookie })).status, 200);
  assert.equal(
    (await raw({ host: "fake.test", path: "/act", method: "POST", headers: cookie })).status,
    403,
    "single use",
  );

  // T3 holds T's placeholder but no grant: a task-scoped grant entry; after it, GET passes and POST still asks
  const g = await raw({ host: "fake.test", path: "/me", from: "127.0.0.3", headers: cookie });
  assert.equal(g.status, 403);
  const gid = (JSON.parse(g.body) as { approval: number }).approval;
  const entry = ctx.db.prepare("SELECT kind, category, task_id FROM approvals WHERE id = ?").get(gid);
  assert.deepEqual({ ...entry }, { kind: "grant", category: "origin:fake.test", task_id: "T3" });
  gate.decide(gid, "approve", "owner");
  assert.equal((await raw({ host: "fake.test", path: "/me", from: "127.0.0.3", headers: cookie })).status, 200);
  assert.equal(
    (await raw({ host: "fake.test", path: "/act", method: "POST", from: "127.0.0.3", headers: cookie })).status,
    403,
  );
});

test("a site manifest: GET /logout is consequential; a bearer token in a body is captured and swapped back", async () => {
  const set = await raw({ host: "site.test", path: "/set" });
  const ph = String(set.headers["set-cookie"]).match(/session=(hortus-secret-c-\d+)/)?.[1];
  assert.ok(ph, String(set.headers["set-cookie"]));
  const me = await raw({ host: "site.test", path: "/me", headers: { cookie: `session=${ph}` } });
  assert.equal(me.status, 200, me.body);
  const out = await raw({ host: "site.test", path: "/logout", headers: { cookie: `session=${ph}` } });
  assert.equal(out.status, 403);
  assert.match(out.body, /"approval"/);
  const tok = await raw({ host: "site.test", path: "/api/token" });
  const placeholder = (JSON.parse(tok.body) as { token: string }).token;
  assert.match(placeholder, /^hortus-secret-c-\d+$/);
  assert.ok(!tok.body.includes(TOKEN));
  const who = await raw({
    host: "site.test",
    path: "/api/whoami",
    headers: { authorization: `Bearer ${placeholder}` },
  });
  assert.equal(who.status, 200);
  assert.equal(site.seen.at(-1)?.auth, `Bearer ${TOKEN}`);
});

test("origins: a list refuses other hosts with the final page and browser.login refuses them, no entry", {
  skip: !hasChromium,
}, async () => {
  const { s } = await worker("T2", "127.0.0.4");
  const n = approvals();
  assert.match(await s.navigate("http://other.test/"), /host not in origins: other\.test — final/);
  await assert.rejects(
    call("browser.login", { url: "https://other.test/login", why: "x" }, { role: "worker", task: "T2" }),
    /host not in origins/,
  );
  assert.equal(approvals(), n);
});

// ---------------------------------------------------------------------------------------------------------------------
// the login view, driven the way app.js drives it

const base = () => `http://127.0.0.1:${console_.port}`;
const api = async (method: string, input: unknown) => {
  const r = await fetch(`${base()}/api/${method}`, {
    method: "POST",
    headers: { "x-hortus": "1", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result as Record<string, unknown>;
};

/** `/events/login?id=` as a stream of parsed events. */
function events(id: number) {
  const ac = new AbortController();
  const got: { frame?: string; closed?: string; error?: string; until?: number }[] = [];
  const done = fetch(`${base()}/events/login?id=${id}`, { signal: ac.signal })
    .then(async (r) => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(c, { stream: true });
        let i = buf.indexOf("\n\n");
        while (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (line.startsWith("data: ")) got.push(JSON.parse(line.slice(6)));
          i = buf.indexOf("\n\n");
        }
      }
    })
    .catch(() => {});
  const wait = async (pred: (e: (typeof got)[number]) => boolean, ms = 15_000) => {
    const t = Date.now();
    for (;;) {
      const e = got.find(pred);
      if (e) return e;
      if (Date.now() - t > ms)
        throw new Error(`no matching event in ${ms} ms: ${JSON.stringify(got.map((g) => Object.keys(g)))}`);
      await sleep(50);
    }
  };
  const close = () => {
    ac.abort();
    return done;
  };
  return { got, wait, close };
}

const click = async (id: number, x: number, y: number) => {
  for (const event of ["mousePressed", "mouseReleased"])
    await api("login.input", { id, type: "mouse", event, x, y, button: "left", clickCount: 1 });
};
const typeKeys = async (id: number, text: string) => {
  for (const ch of text) {
    await api("login.input", {
      id,
      type: "key",
      event: "keyDown",
      key: ch,
      code: "",
      keyCode: ch.toUpperCase().charCodeAt(0),
    });
    await api("login.input", {
      id,
      type: "key",
      event: "keyUp",
      key: ch,
      code: "",
      keyCode: ch.toUpperCase().charCodeAt(0),
    });
  }
};

test("v6 done-when: browser_login → login view (SSE + login.input) → Done → inbox cookies; logged in, also after a restart", {
  skip: !hasChromium,
}, async () => {
  process.env.HORTUS_RPC = `http://127.0.0.1:${shared.http}`;
  process.env.HORTUS_RPC_LOCAL = "127.0.0.2";
  const { s, task } = await worker("T", "127.0.0.2");
  const login = browserTools(task, s).find((t) => t.name === "browser_login");
  assert.ok(login);
  const said = await (login.execute as (i: unknown) => Promise<string>)({
    url: "http://fake.test/login",
    why: "read the dashboard",
  });
  assert.match(said, /waiting for the owner \(approval (\d+), sign in\)/);
  const id = Number(/approval (\d+)/.exec(said)?.[1]);
  const row = ctx.db.prepare("SELECT kind, category, task_id, summary, status FROM approvals WHERE id = ?").get(id) as {
    kind: string;
    summary: string;
    status: string;
  };
  assert.equal(row.kind, "login");
  assert.deepEqual(JSON.parse(row.summary), {
    url: "http://fake.test/login",
    why: "read the dashboard",
    origin: "fake.test",
  });

  // the Approvals entry links the view; the view page carries the canvas
  const page = await (await fetch(`${base()}/approvals/${id}`)).text();
  assert.match(page, new RegExp(`href="/approvals/${id}/login"`));
  assert.match(await (await fetch(`${base()}/approvals/${id}/login`)).text(), /<canvas/);

  const ev = events(id);
  const first = await ev.wait((e) => e.frame !== undefined);
  assert.ok(
    Buffer.from(first.frame ?? "", "base64")
      .subarray(0, 2)
      .equals(Buffer.from([0xff, 0xd8])),
    "JPEG",
  );
  const t0 = Date.now();
  await click(id, 150, 115); // #user
  assert.ok(Date.now() - t0 < 1000, "input round trips are quick on loopback");
  await typeKeys(id, USER);
  await click(id, 150, 165); // #pw
  await typeKeys(id, PASSWORD);
  await api("login.input", { id, type: "key", event: "keyDown", key: "Enter", code: "Enter", keyCode: 13 });
  await api("login.input", { id, type: "key", event: "keyUp", key: "Enter", code: "Enter", keyCode: 13 });
  for (let i = 0; i < 100 && !site.auth; i++) await sleep(100);
  assert.ok(site.auth, "the form posted the JS hash and the site signed the view in");
  // the site sets `auth` before its response (and the Set-Cookie capture) reaches the proxy: wait for the row
  const auth = await until(() => cookieRow("fake.test", "auth"), 5000, "the auth cookie captured");
  assert.equal(auth?.value, site.auth);

  const done = await api("login.done", { id });
  assert.equal(done.id, id);
  await ev.wait((e) => e.closed === "done");
  await ev.close();
  assert.equal(
    (ctx.db.prepare("SELECT status FROM approvals WHERE id = ?").get(id) as { status: string }).status,
    "approved",
  );
  const grant = ctx.db
    .prepare("SELECT status FROM approvals WHERE kind = 'grant' AND category = 'origin:fake.test' AND task_id = 'T'")
    .get() as { status: string };
  assert.equal(grant.status, "approved");
  const inbox = ctx.db.prepare("SELECT body FROM inbox WHERE task_id = 'T' ORDER BY seq DESC").all() as {
    body: string;
  }[];
  const msg = inbox.map((r) => JSON.parse(r.body)).find((m) => m.from === "cookies");
  assert.ok(msg, "inbox cookies");
  assert.ok(
    msg.data.some(
      (c: { name: string; value: string }) => c.name === "auth" && c.value === `hortus-secret-${auth?.name}`,
    ),
  );

  // the Worker's next navigation is signed in (the inbox jar injected), and the browser never held the real value
  assert.match(await s.navigate("http://fake.test/me"), /"logged in as owner"/);
  assert.ok(!(JSON.stringify(msg) + (await s.eval("document.cookie"))).includes(String(site.auth)));

  // stop and start again: a new process and a fresh profile, only task.json's jar
  const again = await worker("T", "127.0.0.2", tempDir("hortus-browser-restart-"));
  assert.ok(
    again.task.cookies?.some((c) => c.name === "auth"),
    "task.json carries the jar",
  );
  assert.match(await again.s.navigate("http://fake.test/me"), /"logged in as owner"/);
  assert.deepEqual(
    jar(ctx.db, "T3", "fake.test").filter((c) => c.name === "auth").length,
    1,
    "T3's grant covers the login too",
  );
});

test("browser.login for an origin with a stored login → a grant entry; approving it sends the jar", {
  skip: !hasChromium,
}, async () => {
  const n0 = (ctx.db.prepare("SELECT count(*) AS n FROM inbox WHERE task_id = 'T4'").get() as { n: number }).n;
  const r = (await call(
    "browser.login",
    { url: "http://app.fake.test/", why: "again" },
    { role: "worker", task: "T4" },
  )) as {
    approval: number;
    kind: string;
  };
  assert.equal(r.kind, "grant");
  const e = ctx.db.prepare("SELECT category, summary FROM approvals WHERE id = ?").get(r.approval) as {
    category: string;
    summary: string;
  };
  assert.equal(e.category, "origin:fake.test");
  assert.ok(JSON.parse(e.summary).cookies >= 1);
  assert.match(
    await (await fetch(`${base()}/approvals/${r.approval}`)).text(),
    /reuse the stored login for <b>fake\.test<\/b>/,
  );
  gate.decide(r.approval, "approve", "owner");
  const msgs = (ctx.db.prepare("SELECT body FROM inbox WHERE task_id = 'T4' ORDER BY seq").all() as { body: string }[])
    .slice(n0)
    .map((x) => JSON.parse(x.body));
  assert.ok(msgs.some((m) => m.from === "cookies" && m.data.some((c: { name: string }) => c.name === "auth")));
});

test("idle: the view closes after IDLE with the entry pending; reopening (also after a module restart) streams again", {
  skip: !hasChromium,
}, async () => {
  const r = (await call(
    "browser.login",
    { url: "http://idle.test/login", why: "idle" },
    { role: "worker", task: "T4" },
  )) as {
    approval: number;
    kind: string;
  };
  assert.equal(r.kind, "login");
  IDLE.ms = 1500;
  try {
    const a = events(r.approval);
    await a.wait((e) => e.frame !== undefined);
    await a.wait((e) => e.closed === "idle", 10_000);
    await a.close();
    assert.equal(
      (ctx.db.prepare("SELECT status FROM approvals WHERE id = ?").get(r.approval) as { status: string }).status,
      "pending",
    );
    await assert.rejects(api("login.input", { id: r.approval, type: "text", text: "x" }), /closed/);
    // hortusd restarts: the entry is kept, the view starts a new Chromium on open
    await browserModule.stop();
    await browserModule.start(ctx);
    IDLE.ms = 60_000;
    const b = events(r.approval);
    await b.wait((e) => e.frame !== undefined);
    await api("login.reject", { id: r.approval });
    await b.wait((e) => e.closed === "rejected");
    await b.close();
    assert.equal(
      (ctx.db.prepare("SELECT status FROM approvals WHERE id = ?").get(r.approval) as { status: string }).status,
      "rejected",
    );
  } finally {
    IDLE.ms = 15 * 60_000;
  }
});

test("Credentials: captured origins listed; forget deletes them and old placeholders then 403", async () => {
  const html = await (await fetch(`${base()}/credentials`)).text();
  assert.match(html, /Captured logins/);
  assert.match(html, /<td>site\.test<\/td>/);
  const row = cookieRow("site.test", "session");
  assert.ok(row);
  assert.deepEqual(await api("captured.forget", { origin: "site.test" }), { deleted: 2 });
  const r = await raw({ host: "site.test", path: "/me", headers: { cookie: `session=hortus-secret-${row.name}` } });
  assert.equal(r.status, 403);
  assert.match(r.body, /unknown credential/);
  rmSync(fixtures, { recursive: true, force: true });
});

test("cdp: DevTools over a pipe, never a TCP port (sessions reach 127.0.0.0/8)", () => {
  const f = flags({ userDataDir: "/x" });
  assert.ok(f.includes("--remote-debugging-pipe"));
  assert.ok(!f.some((x) => x.startsWith("--remote-debugging-port")));
});

test("cdp: a missing chromium fails connect at once, naming the binary (no 15 s wait, close does not hang)", async () => {
  const t = Date.now();
  const b = await launch({ userDataDir: join(tempDir("hortus-nochrome-"), "u"), cmd: ["/nonexistent/chromium"] });
  await assert.rejects(connect(b), /chromium did not start .*\/nonexistent\/chromium ENOENT/);
  await b.close();
  assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
});
