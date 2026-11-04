/**
 * 3e: the gate's `auto` policy, `grant` records, task scope and the judge, through the pipeline on loopback (like
 * proxy/pipeline.test.ts). Clients: 127.0.0.2 = task T (slack, github in scope), .4 = T2 (slack only), .5 = T3 (slack,
 * github), .7 = T4 (slack only). The judge's LLM is a fake behind `dev.upstreams["api.openai.com"]`, reached by
 * `coreFetch` with the `llm` credential (transform `openai`) as the Planner's provider.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { Config } from "../config.ts";
import { bus } from "../console/events.ts";
import { approvals as approvalsPage } from "../console/pages/approvals.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { links, listen, proxyModule } from "../proxy/index.ts";
import { call } from "../rpc.ts";
import * as tasks from "../runtime/tasks.ts";
import { tempDir } from "../test/until.ts";
import type { InboxMsg } from "../types.ts";
import { caCert } from "./ca.ts";
import { gate, transforms, vaultModule } from "./index.ts";
import * as judge from "./judge.ts";
import { read as readVault, write as writeVault } from "./vault.ts";

process.env.HORTUS_HOME = tempDir("hortus-gate-");
const owner = { role: "owner" as const };

// upstream: every API answers ok
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
});

// the judge's LLM
type Mode = "allow" | "escalate" | "500" | "nonjson" | "badverdict" | "hang";
let mode: Mode = "allow";
const llmSeen: {
  auth?: string;
  body: { model: string; temperature: number; response_format: unknown; messages: { role: string; content: string }[] };
}[] = [];
const llm = http.createServer((req, res) => {
  const c: Buffer[] = [];
  req.on("data", (x: Buffer) => c.push(x));
  req.on("end", () => {
    llmSeen.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(c).toString()) });
    if (mode === "hang") return;
    if (mode === "500") {
      res.writeHead(500);
      return res.end("boom");
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (mode === "nonjson") return res.end("<html>not json</html>");
    const verdict = mode === "badverdict" ? "yes" : mode;
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ verdict, reason: `fake says ${verdict}` }) } }],
        usage: { total_tokens: 100 },
      }),
    );
  });
});

const fixtures = tempDir("hortus-gate-tf-");
mkdirSync(join(fixtures, "ghfake"));
writeFileSync(
  join(fixtures, "ghfake", "manifest.json"),
  JSON.stringify({
    name: "ghfake",
    credentials: { ghfake: { type: "token", hosts: ["api.gh.test"], locations: ["header:Authorization"] } },
  }),
);
writeFileSync(
  join(fixtures, "ghfake", "transform.js"),
  `export function request(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = k === "authorization" ? v.replace(/^Bearer hortus-secret-([a-z0-9_-]+)$/, "Bearer {secret:$1}") : v;
  return { ...req, headers };
}
export function response(res) { return { res }; }`,
);

let ports: { https: number; http: number; dns: number };
let ca: Buffer;
let ctx: Ctx;
let base: Record<string, unknown>;
const inbox: [string, Omit<InboxMsg, "seq" | "ts">][] = [];
const setConfig = (patch: Record<string, unknown>) => {
  ctx.config = Config.parse({ ...base, ...patch });
};

before(async () => {
  process.env.HORTUS_NO_NET = "1";
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  const up = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  base = {
    dev: {
      upstreams: {
        "slack.com": up,
        "api.gh.test": up,
        "api.openai.com": `http://127.0.0.1:${(llm.address() as AddressInfo).port}`,
      },
    },
    proxy: { https: 0, http: 0, dns: 0 },
    planner: { provider: "llm", model: "judge-1" },
    policy: { "credential:slack": "auto", "credential:github": "auto", "*": "human" },
  };
  ctx = { config: Config.parse(base), db: openDb(paths.db()), paths, log: logger, reload: async () => {} };
  writeVault({
    slack: { type: "token", value: "xoxb-real", transform: "slack" },
    github: { type: "token", value: "ghp-real", transform: "ghfake" },
    llm: { type: "token", value: "sk-llm-real", transform: "openai" },
  });
  const task = ctx.db.prepare(
    "INSERT INTO tasks(id, kind, title, brief, status, scope, origins) VALUES (?, 'unattended', ?, ?, 'running', ?, ?)",
  );
  const scope = (c: string[]) => JSON.stringify({ credentials: c, repos: [] });
  task.run(
    "T",
    "Reply in #general",
    "Post a short reply to the thread in #general.",
    scope(["slack", "github"]),
    '"*"',
  );
  task.run("T2", "t2", "b2", scope(["slack"]), '"*"');
  task.run("T3", "t3", "b3", scope(["slack", "github"]), '"*"');
  task.run("T4", "t4", "b4", scope(["slack"]), '"*"');
  tasks.bind(ctx);
  await vaultModule.start(ctx);
  await proxyModule.start(ctx);
  await transforms.load([transforms.shippedDir(), fixtures]);
  gate.deps.inboxWrite = (t, m) => inbox.push([t, m]);
  links.register("127.0.0.2", "worker", "T", "session");
  links.register("127.0.0.4", "worker", "T2", "session");
  links.register("127.0.0.5", "worker", "T3", "session");
  links.register("127.0.0.7", "worker", "T4", "session");
  ports = await listen("127.0.0.1", { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" });
  ca = readFileSync(caCert());
});

after(async () => {
  await proxyModule.stop();
  await vaultModule.stop();
  for (const s of [upstream, llm]) {
    s.close();
    s.closeAllConnections();
  }
});

interface R {
  status: number;
  body: string;
}

let n = 0;
/** A POST with a credential; a fresh body each call unless given, so each is a new template hash. */
function send(o: {
  host?: string;
  path?: string;
  from?: string;
  cred?: string;
  body?: string;
  type?: string;
}): Promise<R> {
  const host = o.host ?? "slack.com";
  const body = o.body ?? JSON.stringify({ channel: "C1", text: `hello ${++n}` });
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        host: "127.0.0.1",
        port: ports.https,
        method: "POST",
        path: o.path ?? "/api/chat.postMessage",
        headers: {
          host,
          authorization: `Bearer hortus-secret-${o.cred ?? "slack"}`,
          "content-type": o.type ?? "application/json",
        },
        localAddress: o.from ?? "127.0.0.2",
        agent: false,
        servername: host,
        ca,
      },
      (res) => {
        const c: Buffer[] = [];
        res.on("data", (x: Buffer) => c.push(x));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(c).toString() }));
      },
    );
    r.on("error", reject);
    r.end(body);
  });
}

interface Row {
  id: number;
  kind: string;
  category: string;
  task_id: string | null;
  status: string;
  decided_by: string | null;
  prompt_hash: string | null;
  reason: string | null;
  summary: string;
  payload: string | null;
}
const row = (id: number) => ctx.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as unknown as Row;
const lastRow = () => ctx.db.prepare("SELECT * FROM approvals ORDER BY id DESC LIMIT 1").get() as unknown as Row;
const pendingId = (r: R): number => {
  assert.equal(r.status, 403, r.body);
  const j = JSON.parse(r.body) as { approval: number; url: string };
  assert.equal(typeof j.approval, "number");
  return j.approval;
};
const approve = (id: number) => call("approval.decide", { id, decision: "approve" }, owner);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------------------------------------------------

test("auto: the first post asks for a durable grant; after one click every later post passes via the judge", async () => {
  const first = await send({});
  const id = pendingId(first);
  const g = row(id);
  assert.deepEqual([g.kind, g.category, g.task_id, g.status], ["grant", "credential:slack", null, "pending"]);
  assert.equal(JSON.parse(g.payload ?? "{}").task, "T");
  assert.equal(llmSeen.length, 0, "no judge call before the grant");
  // the retry before the click is the same entry
  assert.equal(pendingId(await send({})), id);

  await approve(id);
  assert.equal(inbox.at(-1)?.[0], "T", "the requesting task hears the durable grant's decision");
  for (let i = 0; i < 3; i++) {
    const r = await send({});
    assert.equal(r.status, 200, r.body);
    const a = lastRow();
    assert.deepEqual([a.kind, a.status, a.decided_by, a.task_id], ["request", "allowed", "judge", "T"]);
    assert.match(a.prompt_hash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(a.reason, "fake says allow");
  }
  assert.equal(llmSeen.length, 3);
  const j = llmSeen[0];
  assert.equal(j?.auth, "Bearer sk-llm-real", "the LLM credential is inserted by the pipeline");
  assert.equal(j?.body.model, "judge-1");
  assert.equal(j?.body.temperature, 0);
  assert.deepEqual(j?.body.response_format, { type: "json_object" });
  assert.equal(
    (ctx.db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get() as { n: number }).n,
    0,
  );
  const page = await approvalsPage(ctx, { m: [], q: new URLSearchParams() });
  assert.match(page, /allowed by judge: fake says allow/);
  assert.match(page, new RegExp(`#${id}</a> <b>enable slack</b>`));
  assert.doesNotMatch(await approvalsPage(ctx, { m: [], q: new URLSearchParams("judge=hide") }), /allowed by judge/);
});

test("consequential: chat.delete asks per request and never reaches the judge, even one that would allow", async () => {
  mode = "allow";
  const before = llmSeen.length;
  const id = pendingId(await send({ path: "/api/chat.delete" }));
  const r = row(id);
  assert.deepEqual([r.kind, r.status], ["request", "pending"]);
  assert.equal(JSON.parse(r.payload ?? "{}").consequential, true);
  assert.equal(llmSeen.length, before, "no judge call");
  await approve(id);
  assert.equal((await send({ path: "/api/chat.delete", body: JSON.parse(r.summary).bodyPreview })).status, 200);
});

test("a streamed body (outside the hash and the judge's view) asks the owner per request", async () => {
  mode = "allow";
  const before = llmSeen.length;
  const seen: unknown[] = [];
  const on = (p: unknown) => seen.push(p);
  bus.on("approvals", on);
  const id = pendingId(await send({ type: "application/octet-stream", body: "anything at all" }));
  bus.off("approvals", on);
  assert.ok(seen.length >= 1, "open pages hear of the new entry (SSE)");
  const r = row(id);
  assert.deepEqual([r.kind, r.status], ["request", "pending"]);
  assert.equal(JSON.parse(r.payload ?? "{}").consequential, true);
  assert.equal(llmSeen.length, before, "no judge call");
});

test("forced-human categories never reach the judge, whatever the policy says", async () => {
  setConfig({
    policy: { "*": "auto", merge: "auto", transforms: "auto", login: "auto", "origin:example.com": "auto" },
  });
  const before = llmSeen.length;
  for (const category of ["merge", "transforms", "login", "origin:example.com"]) {
    const g = await gate.request({
      caller: { role: "worker", task: "T" },
      category,
      hash: `h-${category}`,
      consequential: false,
      summary: { method: "POST", host: "example.com", path: "/" },
    });
    assert.notEqual(g, "pass", category);
    assert.equal(row((g as { pending: number }).pending).kind, "request", category);
  }
  assert.equal(llmSeen.length, before);
  setConfig({});
});

test("judge failures escalate: timeout, 500, non-JSON, bad verdict → a normal 403 {approval}", async () => {
  judge.deps.timeoutMs = 300;
  for (const m of ["hang", "500", "nonjson", "badverdict", "escalate"] as const) {
    mode = m;
    const before = llmSeen.length;
    const r = await send({});
    const id = pendingId(r);
    assert.match(JSON.parse(r.body).url, new RegExp(`/approvals/${id}$`));
    const a = row(id);
    assert.deepEqual([a.kind, a.status], ["request", "pending"], m);
    assert.equal(llmSeen.length, before + 1, `${m}: the judge was asked`);
    const reason = JSON.parse(a.payload ?? "{}").judge as string;
    assert.match(
      reason,
      m === "hang" ? /timeout/ : m === "500" ? /HTTP 500/ : m === "escalate" ? /fake says/ : /judge/,
    );
    assert.match(a.prompt_hash ?? "", /^[0-9a-f]{64}$/);
    // the owner's approval of an escalation is used without a second judge call
    await approve(id);
    assert.equal((await send({ body: JSON.parse(a.summary).bodyPreview })).status, 200);
    assert.equal(llmSeen.length, before + 1);
  }
  judge.deps.timeoutMs = 20_000;
  mode = "allow";
});

test("task scope: a credential outside scope asks a task grant; it does not cover another task", async () => {
  // T2 lacks github: a task-scoped grant, whatever the policy
  const id = pendingId(
    await send({ host: "api.gh.test", path: "/repos/o/r/issues", cred: "github", from: "127.0.0.4" }),
  );
  assert.deepEqual([row(id).kind, row(id).task_id, row(id).category], ["grant", "T2", "credential:github"]);
  await approve(id);
  const scope = JSON.parse(
    (ctx.db.prepare("SELECT scope FROM tasks WHERE id = 'T2'").get() as { scope: string }).scope,
  ) as { credentials: string[] };
  assert.ok(scope.credentials.includes("github"), "approval adds the name to the task row");
  assert.equal(inbox.at(-1)?.[0], "T2");
  // the task grant is also the auto grant for T2: judged, no more clicks
  const before = llmSeen.length;
  assert.equal(
    (await send({ host: "api.gh.test", path: "/repos/o/r/issues", cred: "github", from: "127.0.0.4" })).status,
    200,
  );
  assert.equal(llmSeen.length, before + 1);
  // T4 (also lacking github) still asks its own task grant
  const other = pendingId(await send({ host: "api.gh.test", path: "/repos/o/r", cred: "github", from: "127.0.0.7" }));
  assert.deepEqual([row(other).kind, row(other).task_id], ["grant", "T4"]);
  // T3 has github in scope but no durable grant exists: T2's task grant does not cover it
  const durable = pendingId(await send({ host: "api.gh.test", path: "/repos/o/r", cred: "github", from: "127.0.0.5" }));
  assert.deepEqual([row(durable).kind, row(durable).task_id], ["grant", null]);
  await approve(durable);
  // closing T2 leaves its grant row
  ctx.db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'T2'").run();
  assert.equal(row(id).status, "approved");
});

test("durable grant covers a new task", async () => {
  ctx.db
    .prepare("INSERT INTO tasks(id, kind, status, scope, origins) VALUES ('T5', 'unattended', 'running', ?, '\"*\"')")
    .run(JSON.stringify({ credentials: ["slack"], repos: [] }));
  links.register("127.0.0.8", "worker", "T5", "session");
  assert.equal((await send({ from: "127.0.0.8" })).status, 200);
  assert.equal(lastRow().decided_by, "judge");
});

test("judge_notes come after the fixed prompt and before the summary; prompt_hash is the hash of what was sent", async () => {
  setConfig({
    judge_notes: { "credential:github": "anything touching main is dangerous", "*": "a DELETE is dangerous" },
  });
  const r = await send({ host: "api.gh.test", path: "/repos/o/r/git/refs/heads/main", cred: "github" });
  assert.equal(r.status, 200, r.body);
  const sent = llmSeen.at(-1)?.body.messages ?? [];
  const system = sent[0]?.content ?? "";
  const user = sent[1]?.content ?? "";
  assert.ok(system.startsWith(judge.FIXED), "starts with the fixed prefix");
  assert.equal(
    system.slice(judge.FIXED.length),
    "\n\n## Owner notes\n\nanything touching main is dangerous\na DELETE is dangerous",
  );
  const a = lastRow();
  assert.ok(user.startsWith("## Task\n\nTitle: Reply in #general\nBrief: Post a short reply"), user);
  assert.ok(user.endsWith(JSON.stringify(JSON.parse(a.summary), null, 2)), "ends with the summary");
  assert.match(user, /"authorization": "Bearer \{secret:github\}"/);
  assert.doesNotMatch(user, /ghp-real/);
  assert.equal(a.prompt_hash, sha(`${system}\n\n${user}`));

  setConfig({ judge_notes: { "credential:github": "pushes to hortus/** are routine" } });
  await send({ host: "api.gh.test", path: "/repos/o/r/git/refs/heads/main", cred: "github" });
  const b = lastRow();
  assert.notEqual(b.prompt_hash, a.prompt_hash, "new notes, new hash");
  setConfig({});
});

test("planner.daily_tokens exhausted → escalate without a call", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const used = (ctx.db.prepare("SELECT tokens FROM planner_usage WHERE day = ?").get(day) as { tokens: number }).tokens;
  assert.ok(used >= 100, "the judge's tokens are counted");
  setConfig({ planner: { provider: "llm", model: "judge-1", daily_tokens: used } });
  const before = llmSeen.length;
  const id = pendingId(await send({}));
  assert.equal(llmSeen.length, before);
  assert.match(JSON.parse(row(id).payload ?? "{}").judge, /daily_tokens/);
  setConfig({});
});

test("a policy edit applies to the next request without a restart", async () => {
  setConfig({ policy: { "credential:slack": "human" } });
  const before = llmSeen.length;
  const id = pendingId(await send({}));
  assert.equal(row(id).kind, "request");
  assert.equal(llmSeen.length, before);
  setConfig({});
  assert.equal((await send({})).status, 200);
  assert.equal(llmSeen.length, before + 1);
});

test("chat tasks: every configured name in scope; a credential added later only for new chats", async () => {
  const a = (await call("task.open", { text: "hi" }, owner)) as { id: string };
  const scopeOf = (id: string) =>
    (JSON.parse(tasks.get(id).scope ?? "{}") as { credentials: string[] }).credentials.sort();
  assert.deepEqual(scopeOf(a.id), ["github", "llm", "slack"]);
  writeVault({ ...readVault(), gh2: { type: "token", value: "ghp-two", transform: "ghfake" } });
  const b = (await call("task.open", { text: "hi again" }, owner)) as { id: string };
  assert.deepEqual(scopeOf(b.id), ["gh2", "github", "llm", "slack"]);
  links.register("127.0.0.9", "worker", a.id, "session");
  const id = pendingId(await send({ host: "api.gh.test", path: "/user", cred: "gh2", from: "127.0.0.9" }));
  assert.deepEqual([row(id).kind, row(id).task_id], ["grant", a.id]);
});

test("Credentials page marks durable grants as enabled", async () => {
  const { credentials } = await import("../console/pages/credentials.ts");
  const html = await credentials(ctx, { m: [], q: new URLSearchParams() });
  assert.match(html, /<td>slack<\/td>(<td>[^<]*<\/td>){3}<td>enabled<\/td>/);
  assert.match(html, /<td>llm<\/td>(<td>[^<]*<\/td>){3}<td><\/td>/);
});

test("coalesce (owner.notify): a burst of pending approvals is one DM, then one 'N more' when the minute is up", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const sent: string[] = [];
  const notify = gate.coalesce((t) => void sent.push(t));
  try {
    for (let i = 1; i <= 200; i++) notify(`approval ${i} pending (credential:x)`);
    assert.deepEqual(sent, ["approval 1 pending (credential:x)"]);
    mock.timers.tick(gate.NOTIFY_MS);
    assert.deepEqual(sent.slice(1), ["199 more approvals pending"]);
    mock.timers.tick(gate.NOTIFY_MS);
    notify("approval 201 pending (credential:x)");
    assert.equal(sent.at(-1), "approval 201 pending (credential:x)");
  } finally {
    mock.timers.reset();
  }
});
