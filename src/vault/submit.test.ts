/**
 * 3f at the RPC/gate level: a Worker submits transforms, the owner decides with credentials, requests go through the
 * pipeline (`handle`, in-process) to one fake upstream reached through dev.upstreams.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Config } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import { mirrorModule } from "../mirror/index.ts";
import * as paths from "../paths.ts";
import { proxyModule } from "../proxy/index.ts";
import { handle, type IncomingRequest } from "../proxy/pipeline.ts";
import { call } from "../rpc.ts";
import { tempDir } from "../test/until.ts";
import type { InboxMsg, VaultEntry } from "../types.ts";
import * as dof from "./dof.ts";
import { gate, transforms, transformsDofModule, vaultModule } from "./index.ts";
import { sigv4 } from "./sigv4.ts";
import { diff, MAX_TESTS, TESTS } from "./submit.ts";
import { read as readVault, write as writeVault } from "./vault.ts";

process.env.HORTUS_HOME = tempDir("hortus-submit-");
const owner = { role: "owner" as const };
const worker = { role: "worker" as const, task: "T" };

const seen: { path?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    seen.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
});

let ctx: Ctx;
type Msg = Omit<InboxMsg, "seq" | "ts" | "data"> & { data?: { approval?: number; decision?: string } };
const inbox: [string, Msg][] = [];

before(async () => {
  // the proxy listens on loopback with ephemeral ports: no capabilities, no clash with a running daemon
  process.env.HORTUS_NO_NET = "1";
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const hosts = ["api.notion.com", "api.linear.app", "s3.us-east-1.amazonaws.com", "slack2.test", "api.reffy.com"];
  ctx = {
    config: Config.parse({
      dev: { upstreams: Object.fromEntries(hosts.map((h) => [h, url])) },
      proxy: { https: 0, http: 0, dns: 0 },
    }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  writeVault({
    slack: { type: "token", value: "xoxb-real", transform: "slack" },
    aws: { type: "aws", keyId: "AKIDREAL", secret: "SECRETREAL", transform: "aws" },
  });
  const task = ctx.db.prepare(
    "INSERT INTO tasks(id, kind, status, scope, origins) VALUES (?, 'chat', 'running', ?, ?)",
  );
  task.run("T", JSON.stringify({ credentials: ["aws"], repos: [] }), JSON.stringify("*"));
  await mirrorModule.start(ctx);
  await vaultModule.start(ctx);
  await proxyModule.start(ctx);
  await transformsDofModule.start(ctx);
  gate.deps.inboxWrite = (t, m) => inbox.push([t, m as Msg]);
});

after(async () => {
  await proxyModule.stop();
  await vaultModule.stop();
  fake.close();
  fake.closeAllConnections();
});

// ---------------------------------------------------------------------------------------------------------------------
// helpers

const bearer = `export function request(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers))
    headers[k] = k === "authorization" ? v.replace(/^Bearer hortus-secret-([a-z0-9_-]+)$/, "Bearer {secret:$1}") : v;
  return { ...req, headers };
}
export function response(res) { return { res }; }
`;

function files(
  name: string,
  o: { host?: string; cred?: string; code?: string; extra?: object; tests?: Record<string, string> } = {},
) {
  const host = o.host ?? `api.${name}.com`;
  const cred = o.cred ?? name;
  const manifest = {
    name,
    credentials: { [cred]: { type: "token", hosts: [host], locations: ["header:Authorization"] } },
    ...o.extra,
  };
  const req = (auth: string) => ({
    method: "GET",
    url: `https://${host}/v1/me`,
    headers: { authorization: auth },
    body: null,
    stream: false,
  });
  const test = { request: req(`Bearer hortus-secret-${cred}`), template: req(`Bearer {secret:${cred}}`) };
  return {
    "manifest.json": JSON.stringify(manifest, null, 2),
    "transform.js": o.code ?? bearer,
    ...(o.tests ?? { "tests/me.json": JSON.stringify(test) }),
  };
}

const submit = (
  name: string,
  f: Record<string, string>,
  caller: { role: "worker" | "owner" | "planner"; task?: string } = worker,
) => call("transforms.submit", { name, files: f }, caller) as Promise<{ approval: number | null; url?: string }>;

const decide = (id: number, decision: "approve" | "reject", credentials?: Record<string, unknown>, reason?: string) =>
  call(
    "approval.decide",
    { id, decision, ...(credentials ? { credentials } : {}), ...(reason ? { reason } : {}) },
    owner,
  );

const entry = (id: number) =>
  call("approval.get", { id }, owner) as Promise<{
    summary: Record<string, unknown>;
    task_id: string;
    status: string;
    payload: { files: Record<string, string> };
  }>;

async function body(out: { body: Readable | Buffer | string }): Promise<string> {
  if (!(out.body instanceof Readable)) return out.body.toString();
  const chunks: Buffer[] = [];
  for await (const c of out.body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString();
}

function req(host: string, auth: string, o: Partial<IncomingRequest> = {}): IncomingRequest {
  return {
    method: "GET",
    path: "/v1/me",
    headers: { host, authorization: auth },
    body: null,
    tls: true,
    sni: host,
    ...o,
  };
}

/** Send; a 403 with `{approval}` → approve it and send again (fresh `mk()` each time). */
async function sendApproved(mk: () => IncomingRequest) {
  const first = await handle(worker, mk());
  const text = await body(first);
  if (first.status !== 403 || !text.startsWith("{")) return { status: first.status, text };
  const { approval } = JSON.parse(text) as { approval: number };
  await decide(approval, "approve");
  const again = await handle(worker, mk());
  return { status: again.status, text: await body(again) };
}

const approvals = () => (ctx.db.prepare("SELECT count(*) AS n FROM approvals").get() as { n: number }).n;
const git = (...args: string[]) => execFileSync("git", args, { cwd: paths.dof("transforms"), encoding: "utf8" });

const invalid = async (p: Promise<unknown>, re: RegExp) => {
  await assert.rejects(p, (e: Error & { code?: string }) => {
    assert.equal(e.code, "invalid");
    assert.match(e.message, re);
    return true;
  });
};

// ---------------------------------------------------------------------------------------------------------------------

test("first start ships the shipped transforms into the DOF in one commit and binds them", () => {
  assert.match(git("log", "--format=%s"), /^ship: .*aws.*slack/m);
  assert.ok(transforms.get("aws") && transforms.get("slack"));
  assert.ok(transforms.get("slack")?.dir.startsWith(paths.dof("transforms")));
  for (const name of ["aws", "slack"])
    for (const r of transforms.runTests(name)) assert.ok(r.ok, `${name}/${r.file}: ${r.diff}`);
});

test("notion: submit → entry (new, notion field) → approve with a value → vault, DOF commit, binding, scope, grant", async () => {
  const f = files("notion");
  const r = await submit("notion", f);
  assert.ok(r.approval);
  const e = await entry(r.approval);
  assert.equal(e.task_id, "T");
  assert.equal(e.summary.new, true);
  assert.deepEqual(e.summary.missing, [{ name: "notion", type: "token" }]);
  assert.equal(e.summary.tests, 1);
  // nobody has to open transform.js: the summary carries the manifest, not the code
  assert.ok(!JSON.stringify(e.summary).includes("Object.entries"));
  assert.deepEqual(e.payload.files, f);

  await decide(r.approval, "approve", { notion: { value: "secret_notion_real" } });
  assert.deepEqual(readVault().notion, { type: "token", value: "secret_notion_real", transform: "notion" });
  assert.match(git("log", "-1", "--format=%s").trim(), /^transform\(notion\): [0-9a-f]{8}$/);
  assert.equal(readFileSync(join(paths.dof("transforms"), "notion", "transform.js"), "utf8"), bearer);
  const row = ctx.db.prepare("SELECT hash FROM transforms WHERE name = 'notion'").get() as { hash: string };
  assert.equal(row.hash, transforms.get("notion")?.hash);
  const scope = JSON.parse((ctx.db.prepare("SELECT scope FROM tasks WHERE id = 'T'").get() as { scope: string }).scope);
  assert.ok(scope.credentials.includes("notion"));
  const grant = ctx.db
    .prepare("SELECT status, task_id FROM approvals WHERE kind = 'grant' AND hash = 'grant:notion'")
    .get() as { status: string; task_id: string };
  assert.deepEqual({ ...grant }, { status: "approved", task_id: "T" });
  assert.ok(inbox.some(([t, m]) => t === "T" && m.data?.approval === r.approval && m.data?.decision === "approved"));

  // the task's next request passes after its request approval and the upstream sees the entered value
  const res = await sendApproved(() => req("api.notion.com", "Bearer hortus-secret-notion"));
  assert.equal(res.status, 200, res.text);
  assert.equal(seen.at(-1)?.headers.authorization, "Bearer secret_notion_real");
  assert.ok(!res.text.includes("secret_notion_real"));
});

test("tests gate: template mismatch → invalid with the diff, no entry; zero tests; a test that is not an object", async () => {
  const n = approvals();
  const wrong = JSON.stringify({
    request: {
      method: "GET",
      url: "https://api.x.com/",
      headers: { authorization: "Bearer hortus-secret-xx" },
      body: null,
      stream: false,
    },
    template: {
      method: "GET",
      url: "https://api.x.com/",
      headers: { authorization: "Bearer {secret:yy}" },
      body: null,
      stream: false,
    },
  });
  await invalid(
    submit("xx", files("xx", { host: "api.x.com", tests: { "tests/a.json": wrong } })),
    /tests\/a\.json: template[\s\S]*-.*\{secret:yy\}[\s\S]*\+.*\{secret:xx\}/,
  );
  await invalid(submit("xx", files("xx", { tests: {} })), /at least one tests/);
  await invalid(submit("xx", files("xx", { tests: { "tests/a.json": "[1, 2]" } })), /tests\/a\.json: not \{ request/);
  await invalid(submit("xx", files("xx", { tests: { "tests/a.json": "42" } })), /tests\/a\.json: not \{ request/);
  assert.equal(approvals(), n);
});

test("runtime limits apply to tests: an infinite loop in request() fails within ~200 ms", async () => {
  const t0 = Date.now();
  await invalid(submit("spin", files("spin", { code: "export function request() { for (;;) {} }" })), /tests failed/);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});

test("manifest safety: body:* location, unknown credential type, a host with a path, 300 KB code, other paths", async () => {
  const m = (cred: object) => ({
    ...files("bad"),
    "manifest.json": JSON.stringify({ name: "bad", credentials: { bad: cred } }),
  });
  await invalid(submit("bad", m({ type: "token", hosts: ["api.bad.com"], locations: ["body:*"] })), /location/);
  await invalid(
    submit("bad", m({ type: "oauth", hosts: ["api.bad.com"], locations: ["header:Authorization"] })),
    /type/,
  );
  await invalid(
    submit("bad", m({ type: "token", hosts: ["api.bad.com/v1"], locations: ["header:Authorization"] })),
    /hostname/,
  );
  await invalid(
    submit("bad", { ...files("bad"), "transform.js": `${bearer}//${"x".repeat(300 * 1024)}` }),
    /over 262144/,
  );
  await invalid(submit("bad", { ...files("bad"), "lib/x.js": "" }), /unexpected files: lib\/x\.js/);
  await invalid(
    submit("bad", { ...files("bad"), "manifest.json": JSON.stringify({ name: "bad", credentials: {}, extra: 1 }) }),
    /extra|credential/,
  );
  // a README.md is accepted (and not committed)
  const ok = await submit("readme", { ...files("readme"), "README.md": "# readme\n" });
  assert.ok(ok.approval);
  await decide(ok.approval, "reject");
});

test("partial credentials: an empty field enables the transform, the name stays unconfigured until the owner adds it", async () => {
  const before = readVault();
  const r = await submit("linear", files("linear", { host: "api.linear.app" }));
  assert.ok(r.approval);
  await decide(r.approval, "approve", { linear: { value: "" } });
  assert.deepEqual(readVault(), before);
  assert.ok(transforms.get("linear"));
  const refused = await handle(worker, req("api.linear.app", "Bearer hortus-secret-linear"));
  assert.equal(refused.status, 403);
  assert.match(await body(refused), /unknown credential linear/);
  await call("credential.set", { name: "linear", type: "token", value: "lin_real", transform: "linear" }, owner);
  const res = await sendApproved(() => req("api.linear.app", "Bearer hortus-secret-linear"));
  assert.equal(res.status, 200, res.text);
  assert.equal(seen.at(-1)?.headers.authorization, "Bearer lin_real");
});

test("existing name: a manifest naming slack shows it configured, no field; approving leaves the slack entry alone", async () => {
  const r = await submit("slack2", files("slack2", { host: "slack2.test", cred: "slack" }));
  assert.ok(r.approval);
  const e = await entry(r.approval);
  assert.deepEqual(e.summary.configured, ["slack"]);
  assert.deepEqual(e.summary.missing, []);
  const prev = readVault().slack as VaultEntry;
  await decide(r.approval, "approve", { slack: { value: "xoxb-other" } });
  assert.deepEqual(readVault().slack, prev);
  // the submitting task gets no scope or grant on a name that existed before (v6: only the new names)
  const row = ctx.db.prepare("SELECT task_id FROM approvals WHERE id = ?").get(r.approval) as { task_id: string };
  const grants = ctx.db
    .prepare("SELECT 1 FROM approvals WHERE kind = 'grant' AND hash = 'grant:slack' AND task_id = ?")
    .all(row.task_id);
  assert.equal(grants.length, 0);
  const scope = ctx.db.prepare("SELECT scope FROM tasks WHERE id = ?").get(row.task_id) as { scope: string };
  assert.ok(!(JSON.parse(scope.scope).credentials ?? []).includes("slack"));
});

test("tamper: a hand-edited worktree file disables the transform and the Sources note says so", async () => {
  const file = join(paths.dof("transforms"), "notion", "transform.js");
  const orig = readFileSync(file, "utf8");
  writeFileSync(file, `${orig}\n// edited\n`);
  await dof.load();
  assert.equal(transforms.get("notion"), undefined);
  assert.ok(transforms.get("slack"));
  const s = (await call("transforms.status", {}, owner)) as { notes: string[] };
  assert.deepEqual(s.notes, ["transforms: 1 disabled (hash mismatch)"]);
  writeFileSync(file, orig);
  await dof.load();
  assert.ok(transforms.get("notion"));
  assert.deepEqual(dof.status(), []);
});

test("re-approval: a changed manifest shows the diff; rejecting keeps the old one, approving swaps the hash", async () => {
  const old = transforms.get("notion")?.hash;
  const f = files("notion", { extra: { consequential: ["DELETE api.notion.com/**"] } });
  const r1 = await submit("notion", f);
  assert.ok(r1.approval);
  const e = await entry(r1.approval);
  assert.equal(e.summary.new, false);
  assert.match(String(e.summary.manifestDiff), /^\+ {2}"consequential": \[$/m);
  assert.deepEqual(e.summary.configured, ["notion"]);
  await decide(r1.approval, "reject", undefined, "no deletes");
  assert.equal(transforms.get("notion")?.hash, old);
  assert.ok(inbox.some(([, m]) => m.data?.approval === r1.approval && m.text.includes("no deletes")));
  const ok = await sendApproved(() => req("api.notion.com", "Bearer hortus-secret-notion"));
  assert.equal(ok.status, 200);

  const r2 = await submit("notion", f);
  assert.ok(r2.approval && r2.approval !== r1.approval);
  await decide(r2.approval, "approve");
  const now = transforms.get("notion")?.hash;
  assert.notEqual(now, old);
  assert.equal(
    (ctx.db.prepare("SELECT hash FROM transforms WHERE name = 'notion'").get() as { hash: string }).hash,
    now,
  );
  assert.deepEqual(transforms.get("notion")?.manifest.consequential, ["DELETE api.notion.com/**"]);
  // the same content again: nothing to approve
  assert.deepEqual(await submit("notion", f), { approval: null });
});

test("only role worker may submit: the owner's CLI and the planner cannot", async () => {
  for (const role of ["owner", "planner"] as const)
    await assert.rejects(
      submit("notion", files("notion"), { role }),
      (e: Error & { code?: string }) => e.code === "forbidden",
    );
});

test("aws: the shipped transform re-signs with the real key; the sandbox never sees the secret; streams are UNSIGNED-PAYLOAD", async () => {
  const host = "s3.us-east-1.amazonaws.com";
  const raw = {
    method: "GET",
    url: `https://${host}/bucket/key`,
    headers: { authorization: "Bearer hortus-secret-aws" },
    body: null,
    stream: false,
  };
  const t = transforms.request("aws", raw, { now: 0, nonce: "n" });
  assert.ok(!JSON.stringify(t).includes("SECRETREAL") && !JSON.stringify(t).includes("AKIDREAL"));

  const check = (method: string, path: string, payload: "stream" | string) => {
    const h = seen.at(-1)?.headers ?? {};
    const date = String(h["x-amz-date"]);
    assert.match(date, /^\d{8}T\d{6}Z$/);
    const expected = sigv4(
      { entry: { type: "aws", keyId: "AKIDREAL", secret: "SECRETREAL" } },
      [{ region: "us-east-1", service: "s3" }],
      { method, path, query: "", headers: { host, "x-amz-date": date }, payload },
    );
    assert.equal(h.authorization, expected);
    assert.match(
      expected,
      /^AWS4-HMAC-SHA256 Credential=AKIDREAL\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-date, /,
    );
  };
  const get = await sendApproved(() => req(host, "Bearer hortus-secret-aws", { path: "/bucket/key" }));
  assert.equal(get.status, 200, get.text);
  check("GET", "/bucket/key", "");

  const put = await sendApproved(() =>
    req(host, "Bearer hortus-secret-aws", {
      method: "PUT",
      path: "/bucket/blob",
      headers: { host, authorization: "Bearer hortus-secret-aws", "content-type": "application/octet-stream" },
      body: Readable.from([Buffer.from("payload bytes")]),
    }),
  );
  assert.equal(put.status, 200, put.text);
  assert.equal(seen.at(-1)?.body, "payload bytes");
  check("PUT", "/bucket/blob", "stream");
});

test("dof transform submit <dir> posts the dir's files as the task's worker", async () => {
  const dir = join(tempDir("hortus-work-"), "todoist");
  const f = files("todoist");
  for (const [p, text] of Object.entries(f)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  // stands in for hortusd.internal: the caller comes from the link, the result is wrapped as {result}
  const rpc = http.createServer((q, s) => {
    let b = "";
    q.on("data", (c) => {
      b += c;
    });
    q.on("end", async () => {
      const result = await call(String(q.url).replace("/rpc/", ""), JSON.parse(b), worker);
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify({ result }));
    });
  });
  await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
  const taskFile = join(dirname(dir), "task.json");
  writeFileSync(taskFile, JSON.stringify({ rpc: `http://127.0.0.1:${(rpc.address() as AddressInfo).port}` }));
  const bin = fileURLToPath(new URL("../bin/dof.js", import.meta.url));
  const r = await promisify(execFile)(process.execPath, [bin, "transform", "submit", dir], {
    env: { ...process.env, HORTUS_TASK: taskFile },
  });
  rpc.close();
  const id = Number(r.stdout.match(/^approval (\d+) pending/)?.[1]);
  assert.ok(id, r.stdout);
  assert.deepEqual((await entry(id)).payload.files, f);
});

// ---------------------------------------------------------------------------------------------------------------------
// review round 2

test("a host another transform handles is refused; a transform's refs for a DOF not of its type are dropped", async () => {
  await invalid(submit("aaa", files("aaa", { host: "slack.com" })), /slack\.com is handled by transform slack/);
  const code = bearer.replace(
    "export function response(res) { return { res }; }",
    'export function response(res) { return { res, refs: ["slack:CVICTIM:123.456"] }; }',
  );
  const r = await submit("reffy", files("reffy", { code }));
  await decide(r.approval as number, "approve", { reffy: { value: "r-real" } });
  const out = await sendApproved(() => req("api.reffy.com", "Bearer hortus-secret-reffy"));
  assert.equal(out.status, 200, out.text);
  assert.equal(seen.at(-1)?.headers.authorization, "Bearer r-real");
  assert.equal(ctx.db.prepare("SELECT 1 FROM task_refs WHERE ref = 'slack:CVICTIM:123.456'").get(), undefined);
});

test("a shipped name cannot be re-submitted; another name's code change shows on the entry", async () => {
  await invalid(submit("slack", files("slack", { host: "slack.com" })), /slack ships with hortus/);
  const r = await submit("codey", files("codey"));
  await decide(r.approval as number, "approve");
  const again = await submit("codey", files("codey", { code: `${bearer}// v2\n` }));
  assert.ok(again.approval);
  const s = (await entry(again.approval)).summary;
  assert.equal(s.new, false);
  assert.equal(s.codeChanged, 1);
});

test("a configured credential bound to no transform: only its own-name transform may name it", async () => {
  writeVault({ ...readVault(), stripe: { type: "token", value: "sk-real" } });
  await invalid(submit("evil", files("evil", { cred: "stripe" })), /stripe is configured without a transform/);
  assert.ok((await submit("stripe", files("stripe"))).approval);
  // an entry bound to a transform that is not loaded follows no manifest, not the host's
  const host = transforms.get("slack")?.manifest;
  assert.equal(transforms.credentialManifest("slack", { transform: "gone" }, host), undefined);
  assert.equal(transforms.credentialManifest("slack", {}, host), host);
});

test("a name another transform declares (unconfigured) gets no task grant from this one", async () => {
  const r = await submit("zzz", files("zzz", { cred: "github" }));
  await decide(r.approval as number, "approve");
  const scope = ctx.db.prepare("SELECT scope FROM tasks WHERE id = 'T'").get() as { scope: string };
  assert.ok(!(JSON.parse(scope.scope).credentials ?? []).includes("github"));
  const grant = ctx.db.prepare("SELECT 1 FROM approvals WHERE kind = 'grant' AND hash = ? AND task_id = 'T'");
  assert.equal(grant.get("grant:github"), undefined);
});

test("going back to an earlier approved version opens a fresh entry", async () => {
  const v1 = files("rev");
  const v2 = files("rev", { extra: { consequential: ["DELETE api.rev.com/**"] } });
  await decide((await submit("rev", v1)).approval as number, "approve");
  await decide((await submit("rev", v2)).approval as number, "approve");
  const back = await submit("rev", v1);
  assert.ok(back.approval);
  assert.equal((await entry(back.approval)).status, "pending");
});

test("a submission's native call holds no loop: it is cut at the total, and one test run at a time", async () => {
  const hold = `export function request(r) { "a".repeat(1 << 22).indexOf("a".repeat(1 << 16) + "b"); return r; }`;
  let worst = 0;
  let last = performance.now();
  const beat = setInterval(() => {
    worst = Math.max(worst, performance.now() - last);
    last = performance.now();
  }, 10);
  TESTS.ms = 2000;
  try {
    const held = submit("hold", files("hold", { code: hold }));
    await invalid(submit("hold2", files("hold2")), /another submission's tests/);
    await invalid(held, /ran over 2000 ms/);
  } finally {
    TESTS.ms = 30_000;
    clearInterval(beat);
  }
  assert.ok(worst < 10_000, `the loop stalled ${Math.round(worst)} ms`); // the indexOf alone is minutes
  assert.ok((await submit("after", files("after"))).approval); // the thread is gone, the slot free
});

test("tests are capped, the first failure ends the run, and a huge diff falls back to the first difference", async () => {
  const one = { method: "", url: "", headers: {}, body: null, stream: false };
  const t = JSON.stringify({ request: one, template: one });
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`tests/t${i}.json`, t]));
  await invalid(submit("spin2", files("spin2", { tests: many(MAX_TESTS + 1) })), /over 32/);
  const t0 = Date.now();
  const loop = "export function request() { for (;;) {} }";
  await invalid(submit("spin2", files("spin2", { code: loop, tests: many(MAX_TESTS) })), /tests failed/);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  // every call just under the deadline passes: the tests' total is another thread's, so a busy machine fails nothing
  const slow = "export function request(r) { const t = Date.now(); while (Date.now() - t < 90) {} return r; }";
  assert.ok((await submit("spin3", files("spin3", { code: slow, tests: many(MAX_TESTS) }))).approval);
  const big = (k: string) => Array.from({ length: 5000 }, (_, i) => `${k}${i}`).join("\n");
  const t1 = Date.now();
  assert.match(diff(big("a"), big("b")), /^\(too large for a full diff; first difference at line 1\)\n-a0\n\+b0\n$/);
  assert.ok(Date.now() - t1 < 500);
});

test("approve and reject in parallel: one wins, and the transform is enabled exactly when approved", async () => {
  const id = (await submit("racey", files("racey"))).approval as number;
  const res = await Promise.allSettled([decide(id, "approve"), decide(id, "reject")]);
  assert.deepEqual(res.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  const st = (await entry(id)).status;
  assert.equal(st === "approved", !!transforms.get("racey"), st);
});

test("an approval that failed after its claim keeps the names it introduces: the re-approval still grants them", async () => {
  const id = (await submit("crashy", files("crashy"))).approval as number;
  const dir = paths.dof("transforms");
  chmodSync(dir, 0o500);
  try {
    await assert.rejects(decide(id, "approve", { crashy: { value: "v1" } }));
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal((await entry(id)).status, "pending");
  // what a crash after the vault write leaves: the name is configured, the entry pending, no grant yet; the Worker
  // resubmits meanwhile (same entry)
  writeVault({ ...readVault(), crashy: { type: "token", value: "v1", transform: "crashy" } });
  assert.equal((await submit("crashy", files("crashy"))).approval, id);
  await decide(id, "approve");
  const grants = ctx.db
    .prepare("SELECT count(*) AS n FROM approvals WHERE kind = 'grant' AND hash = 'grant:crashy' AND task_id = 'T'")
    .get() as { n: number };
  assert.equal(grants.n, 1);
  assert.equal((await entry(id)).status, "approved");
});

test("a resubmission while the owner's approval installs returns that entry, not a second pending one", async () => {
  const id = (await submit("busy", files("busy"))).approval as number;
  ctx.db.prepare("UPDATE approvals SET status = 'installing' WHERE id = ?").run(id);
  try {
    assert.equal((await submit("busy", files("busy"))).approval, id);
  } finally {
    ctx.db.prepare("UPDATE approvals SET status = 'pending' WHERE id = ?").run(id);
  }
  const n = ctx.db
    .prepare(
      "SELECT count(*) AS n FROM approvals WHERE category = 'transforms' AND status = 'pending' AND summary LIKE '%\"busy\"%'",
    )
    .get() as { n: number };
  assert.equal(n.n, 1);
});

test("a release's shipped transform replaces the earlier release's copy; an unchanged one is left alone", async () => {
  const root = join(paths.home(), "shipped");
  const put = (consequential: string[], extra?: string) => {
    const f = files("shipx", { extra: { consequential } });
    mkdirSync(join(root, "shipx", "tests"), { recursive: true });
    for (const [k, v] of Object.entries(f)) writeFileSync(join(root, "shipx", k), v);
    if (extra) writeFileSync(join(root, "shipx", extra), "x");
  };
  put([], "tests/old.json");
  assert.deepEqual(await dof.ship(root), ["shipx"]);
  assert.deepEqual(await dof.ship(root), []);
  assert.ok(existsSync(join(paths.dof("transforms"), "shipx", "tests/old.json")));
  put(["POST api.shipx.com/**"]);
  rmSync(join(root, "shipx", "tests/old.json"));
  assert.deepEqual(await dof.ship(root), ["shipx"]);
  await dof.load();
  assert.deepEqual(transforms.get("shipx")?.manifest.consequential, ["POST api.shipx.com/**"]);
  assert.equal(existsSync(join(paths.dof("transforms"), "shipx", "tests/old.json")), false);
});
