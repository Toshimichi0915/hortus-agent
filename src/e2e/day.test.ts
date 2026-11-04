/**
 * Round 8: the owner's day on a real daemon (HORTUS_NO_NET=1, delegated user scope, fake provider, fake Slack and
 * GitHub, a fake judge endpoint behind `dev.upstreams`). Round 7 counted it in-process (gate.test "a day"); here every
 * step is the real one: the owner's DMs wake the Planner, whose scripted task_create picks `scope.dofs` from the
 * text (25 tasks read the slack DOF, where a stranger wrote; 10 read the owner-only github DOF, 5 none: both judged), each
 * Worker's curl goes through the proxy from its loopback alias (2 posts, 1 consequential delete under `auto`), taint
 * is what `taintOf` computes, and the owner decides through the console and the CLI as the entries appear (a tainted
 * task's first post with "Approve, and allow … for this task"). 10 chats do the same. Prints `# day …`.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openDb, taintOf } from "../db.ts";
import * as paths from "../paths.ts";
import { FakeGitHub } from "../test/fakes/github.ts";
import { FakeSlack } from "../test/fakes/slack.ts";
import { freePort, tempDir, until } from "../test/until.ts";

const hasScope = spawnSync("systemd-run", ["--user", "--scope", "-q", "--", "true"]).status === 0;
const bin = (name: string) => new URL(`../bin/${name}.js`, import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// as step6's fake: the Planner scripted by planner.mjs, a Worker acting on `!bash`, `done` on a `!done` tool output;
// it also stands in for the `openai` type, so planner.provider can be an openai credential the judge calls for real
const FAKE = (dir: string) => `
const DIR = ${JSON.stringify(dir)};
const EVENT = /^- \\[(e\\d+)\\] (\\S+) \\(([^)]*)\\) at \\S+\\n(<<<quoted[^\\n]*\\n[\\s\\S]*?\\n>>>\\S*|[^\\n]*)/gm;
let n = 0;
const complete = async (req, onText) => {
  n++;
  if (!req.tools.length) return { role: "assistant", text: "notes from fake", toolCalls: [] };
  const usage = { input: 10, output: 5, cached: 0 };
  const last = req.messages.at(-1);
  const id = (process.env.HORTUS_TASK ?? "").split("/").at(-3);
  if (id.startsWith("planner-")) {
    if (last.role === "tool") return { role: "assistant", text: "ok", toolCalls: [], usage };
    const events = [...req.messages[0].content.matchAll(EVENT)].map((m) => ({ id: m[1], tags: m[3], text: m[4] }));
    const script = (await import("file://" + DIR + "/planner.mjs?" + Date.now() + Math.random())).default;
    const calls = script(events);
    return { role: "assistant", text: "", toolCalls: calls.map((c, i) => ({ id: "p" + n + "_" + i, ...c })), usage };
  }
  // approval notices drained after the tool result follow it: the turn's tool result is after the last assistant turn
  const turn = req.messages.slice(req.messages.findLastIndex((m) => m.role === "assistant") + 1);
  const tool = turn.find((m) => m.role === "tool");
  if (tool) {
    const out = tool.results.map((r) => r.output).join("\\n");
    const done = /^!done (.*)$/m.exec(out);
    onText("tool said: " + out.slice(0, 200));
    return { role: "assistant", text: "", toolCalls: done ? [{ id: "d" + n, name: "done", input: { summary: done[1] } }] : [], usage };
  }
  // the brief runs the script once; a later wake (an approval notice after done) is answered with nothing
  const m = turn.length === req.messages.length && /^!bash (.*)$/m.exec(last.content ?? "");
  return { role: "assistant", text: "", toolCalls: m ? [{ id: "c" + n, name: "bash", input: { command: m[1] } }] : [], usage };
};
const p = { create: () => ({ complete, listModels: async () => ["m"] }) };
export default { providers: { fake: p, openai: p } };
`;

/** day <k> thread|issue|plain → one task; scope.dofs from the kind (the narrow choice the Planner prompt asks for) */
const PLANNER = (worker: string) => `export default (events) => events.map((e) => {
  const m = /day (\\d+) (thread|issue|plain)/.exec(e.text);
  if (!m || !/trusted/.test(e.tags) || /untrusted/.test(e.tags))
    return { name: "event_ignore", input: { event_ids: [e.id], reason: "not a day task" } };
  const dofs = m[2] === "thread" ? ["slack"] : m[2] === "issue" ? ["github"] : [];
  return { name: "task_create", input: { title: "day " + m[1], brief: "!bash sh ${worker}", event_ids: [e.id],
    scope: { credentials: ["day"], dofs } } };
});`;

/** Two posts and a delete through the proxy, each retried while its approval is pending (403), then `!done`. */
const WORKER = `ID=$(basename "$(dirname "$(dirname "$HORTUS_TASK")")")
call() { curl -sf --interface "$HORTUS_RPC_LOCAL" -H "Host: slack.com" -H "Authorization: Bearer hortus-secret-day" -H "Content-Type: application/json" -X POST "$HORTUS_RPC/api/$1" -d "$2"; }
retry() { i=0; until out=$(call "$@"); do i=$((i+1)); [ $i -ge 1500 ] && { echo "!done gave up on $1"; exit 1; }; sleep 0.1; done; }
retry chat.postMessage "{\\"channel\\":\\"C2\\",\\"text\\":\\"$ID one\\"}"
retry chat.postMessage "{\\"channel\\":\\"C2\\",\\"text\\":\\"$ID two\\"}"
ts=$(printf %s "$out" | sed -n 's/.*"ts":"\\([^"]*\\)".*/\\1/p')
retry chat.delete "{\\"channel\\":\\"C2\\",\\"ts\\":\\"$ts\\"}"
echo "!done day $ID"
`;

let home: string;
let fake: string;
let slack: FakeSlack;
let gh: FakeGitHub;
let judge: Server;
let judged = 0;
let port: number;
let proxyHttp: number;
let daemon: ChildProcess | undefined;
const unit = `hortusd-day-${process.pid}`;
/** ends the owner's loop (also when the test fails: it would recreate db.sqlite after the cleanup) */
let stop = false;

const api = async <T = Record<string, unknown>>(method: string, body: unknown = {}): Promise<T> => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
    method: "POST",
    headers: { "X-Hortus": "1", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
};
const db = <T>(f: (d: ReturnType<typeof openDb>) => T): T => {
  const d = openDb(paths.db());
  try {
    return f(d);
  } finally {
    d.close();
  }
};
const hortus = (...args: string[]) =>
  spawnSync(process.execPath, ["--no-warnings", bin("hortus"), ...args], {
    env: { ...process.env, HORTUS_HOME: home },
    encoding: "utf8",
  });
interface Entry {
  id: number;
  kind: string;
  task_id: string | null;
  payload: string;
}
const pending = () =>
  db((d) =>
    d.prepare("SELECT id, kind, task_id, payload FROM approvals WHERE status = 'pending' ORDER BY id").all(),
  ) as unknown as Entry[];
const grantable = (e: Entry) => {
  const p = JSON.parse(e.payload) as { consequential?: boolean; judge?: string };
  return e.kind === "request" && !!e.task_id && !p.consequential && !!p.judge?.startsWith("tainted:");
};
const dms = () =>
  slack.calls.filter(
    (c) => c.method === "chat.postMessage" && c.params.channel === "D1" && /approval/.test(c.params.text ?? ""),
  );

before(async () => {
  if (!hasScope) return;
  home = tempDir("hortus-day-");
  fake = tempDir("hortus-dayfake-");
  process.env.HORTUS_HOME = home;
  mkdirSync(join(fake, "plugins", "fake"), { recursive: true });
  writeFileSync(
    join(fake, "plugins", "fake", "hortus.json"),
    JSON.stringify({ name: "fake", version: "1.0.0", entrypoint: "fake.mjs" }),
  );
  writeFileSync(join(fake, "plugins", "fake", "fake.mjs"), FAKE(fake));
  writeFileSync(join(fake, "worker.sh"), WORKER);
  writeFileSync(join(fake, "planner.mjs"), PLANNER(join(fake, "worker.sh")));
  slack = await FakeSlack.start();
  slack.user("U1", "alice");
  slack.user("U2", "bob");
  slack.channel("C1", { name: "general", members: ["U1", "U2", slack.botUser] });
  slack.channel("C2", { name: "work", members: ["U1", slack.botUser] });
  slack.channel("D1", { is_im: true, user: "U1", members: [slack.botUser, "U1"], name: "" });
  gh = await FakeGitHub.start();
  gh.associations.set("toshi", "OWNER");
  await gh.repo("o/r", "the repo");
  judge = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      judged++;
      const content = JSON.stringify({ verdict: "allow", reason: "routine" });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => judge.listen(0, "127.0.0.1", r));
  const judgeUrl = `http://127.0.0.1:${(judge.address() as { port: number }).port}`;
  port = await freePort();
  proxyHttp = await freePort();
  const webhookPort = await freePort();
  gh.hook = `http://127.0.0.1:${webhookPort}/github/webhook`;
  writeFileSync(
    join(home, "hortusd.json"),
    JSON.stringify({
      owner: { tz: "UTC", notify: "slack" },
      dofs: {
        slack: { type: "slack", owner: "U1" },
        github: { type: "github", owner: "toshi", repos: ["o/r"] },
      },
      dev: {
        upstreams: {
          "slack.com": slack.url,
          "api.github.com": gh.url,
          "github.com": gh.url,
          "api.openai.com": judgeUrl,
        },
      },
      planner: { provider: "judge", model: "m" },
      worker: { provider: "fake", model: "m", plugins: [join(fake, "plugins", "fake")] },
      policy: { "credential:day": "auto", "*": "human" },
      proxy: { https: await freePort(), http: proxyHttp, dns: 0 },
    }),
  );
  writeFileSync(
    join(home, "vault.json"),
    JSON.stringify({
      ...slack.vault("slack"),
      ...gh.vault("github"),
      day: { type: "token", value: slack.botToken, transform: "slack" },
      judge: { type: "token", value: "k", transform: "openai" },
      fake: { type: "token", value: "x", transform: "fake" },
    }),
    { mode: 0o600 },
  );
  daemon = spawn(
    "systemd-run",
    [
      "--user",
      "--scope",
      "-q",
      "--unit",
      unit,
      "-p",
      "Delegate=yes",
      "--",
      process.execPath,
      "--no-warnings",
      bin("hortusd"),
    ],
    {
      env: {
        ...process.env,
        HORTUS_HOME: home,
        HORTUS_CONSOLE_PORT: String(port),
        HORTUS_WEBHOOK_PORT: String(webhookPort),
        HORTUS_NO_NET: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  daemon.stderr?.pipe(createWriteStream(join(fake, "hortusd.log"), { flags: "a" }));
  await until(
    () =>
      fetch(`http://127.0.0.1:${port}/`).then(
        (r) => r.ok,
        () => false,
      ),
    15_000,
    "the console",
  );
});

after(async () => {
  if (!hasScope) return;
  stop = true;
  await sleep(500);
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise((r) => daemon?.once("exit", r));
  }
  spawnSync("systemctl", ["--user", "stop", `${unit}.scope`], { stdio: "ignore" });
  await slack.close();
  await gh.close();
  await new Promise((r) => judge.close(r));
  if (!process.env.KEEP) rmSync(home, { recursive: true, force: true });
  if (!process.env.KEEP) rmSync(fake, { recursive: true, force: true });
});

test("a day: 40 Planner-routed tasks and 10 chats; scope.dofs [] keeps 5 auto-judged; a task grant per tainted task", {
  skip: !hasScope && "no systemd-run --user (delegated cgroups)",
  timeout: 240_000,
}, async () => {
  // the owner-only github DOF and a stranger in the slack one (its batch ignored before the day starts)
  gh.openIssue("o/r", { user: "toshi", title: "Broken" });
  slack.post("C1", { user: "U2", text: "hi, I am bob" });
  const meta = (dof: string) =>
    db((d) => d.prepare("SELECT DISTINCT author FROM search_meta WHERE dof = ?").all(dof)) as { author: string }[];
  await until(() => meta("github").length && meta("slack").some((m) => m.author === "U2"), 20_000, "both mirrors");
  await until(
    () => db((d) => !d.prepare("SELECT 1 FROM events WHERE consumed = 0 AND bot = 0").get()),
    20_000,
    "the stranger's batch",
  );
  await until(() => db((d) => !d.prepare("SELECT 1 FROM tasks WHERE kind = 'planner'").get()), 20_000, "no batch");

  // the owner decides as entries appear: a durable grant, a tainted task's post with the task grant (the first one
  // through the CLI), every delete; the Approvals entry offers the task grant exactly when it may
  let decisions = 0;
  let grants = 0;
  const wrongButton: number[] = [];
  const errors: string[] = [];
  const seen = new Set<number>();
  let maxPage = 0;
  const owner = (async () => {
    while (!stop) {
      for (const e of pending()) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        decisions++;
        const want = grantable(e);
        const page = await (await fetch(`http://127.0.0.1:${port}/approvals/${e.id}`)).text();
        if (page.includes("&quot;grant&quot;:true") !== want) wrongButton.push(e.id);
        if (want) grants++;
        if (want && grants === 1) {
          const r = hortus("approvals", "approve", "--grant", String(e.id));
          if (r.status !== 0 || !/and allowed for its task/.test(r.stdout)) errors.push(`cli: ${r.stdout}${r.stderr}`);
        } else
          await api("approval.decide", { id: e.id, decision: "approve", ...(want ? { grant: true } : {}) }).catch(
            (x: Error) => errors.push(x.message),
          );
      }
      const list = await (await fetch(`http://127.0.0.1:${port}/approvals`)).text();
      maxPage = Math.max(maxPage, list.length);
      await sleep(100);
    }
  })().catch((e: Error) => void (stop || errors.push(`owner loop: ${e.message}`)));

  const t0 = Date.now();
  const kinds = [...Array(40)].map((_, k) => (k < 25 ? "thread" : k < 35 ? "issue" : "plain"));
  for (const [k, kind] of kinds.entries()) {
    slack.post("D1", { user: "U1", text: `day ${k} ${kind}` });
    if (k % 10 === 9) await sleep(1500);
  }
  const chats: string[] = [];
  for (let i = 0; i < 10; i++)
    chats.push((await api<{ id: string }>("task.open", { text: `!bash sh ${join(fake, "worker.sh")}` })).id);

  const rows = () =>
    db((d) =>
      d
        .prepare(
          `SELECT id, kind, status, scope, (SELECT COUNT(*) FROM outbox o WHERE o.task_id = t.id AND json_extract(o.body, '$.type') = 'result' AND json_extract(o.body, '$.text') LIKE 'day %') AS done FROM tasks t WHERE kind != 'planner'`,
        )
        .all(),
    ) as {
      id: string;
      kind: string;
      status: string;
      done: number;
      scope: string;
    }[];
  await until(
    () => rows().length === 50 && rows().every((t) => t.status === "waiting" && t.done > 0),
    Number(process.env.DAY_MS ?? 180_000),
    "every task done",
  ).catch((e: Error) => {
    const left = rows().filter((t) => !(t.status === "waiting" && t.done > 0));
    throw new Error(
      `${e.message}: ${rows().length} tasks, left ${JSON.stringify(left.slice(0, 5))}, outbox ${JSON.stringify(db((d) => d.prepare("SELECT * FROM outbox WHERE task_id = ?").all(left[0]?.id ?? "")))}, pending ${JSON.stringify(pending())}, errors ${errors}`,
    );
  });
  const dayS = (Date.now() - t0) / 1000;
  // owner.notify coalesces: the first entry's DM at once, the rest as "N more" when the minute closes
  await until(() => dms().some((c) => /more approvals? pending/.test(c.params.text ?? "")), 70_000, "the coalesced DM");
  stop = true;
  await owner;

  const cfg = {
    dofs: { slack: { type: "slack" as const, owner: "U1" }, github: { type: "github" as const, owner: "toshi" } },
  } as Parameters<typeof taintOf>[2];
  const tasks = rows();
  const tainted = tasks.filter((t) => db((d) => taintOf(d, t.id, cfg)).length);
  const scopes = tasks
    .filter((t) => t.kind !== "chat")
    .map((t) => JSON.stringify((JSON.parse(t.scope) as { dofs?: string[] }).dofs ?? null));
  const perScope = Object.fromEntries([...new Set(scopes)].map((s) => [s, scopes.filter((x) => x === s).length]));
  const entries = db((d) =>
    d.prepare("SELECT task_id, decided_by, kind FROM approvals WHERE kind = 'request'").all(),
  ) as { task_id: string; decided_by: string }[];
  const byOwner = (id: string) => entries.filter((e) => e.task_id === id && e.decided_by === "owner").length;
  const page = await (await fetch(`http://127.0.0.1:${port}/approvals`)).text();
  console.log(
    `# day (real daemon): ${decisions} decisions (${grants} task grants), ${dms().length} DMs, ${judged} judge calls, ` +
      `${tainted.length} tainted, scope.dofs ${JSON.stringify(perScope)}, Approvals page ${page.length} B ` +
      `(max ${maxPage} B), ${dayS.toFixed(0)} s`,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(wrongButton, []);
  assert.deepEqual(perScope, { '["slack"]': 25, '["github"]': 10, "[]": 5 });
  // tainted: the 25 slack readers (a stranger), the 10 chats (every DOF); the 10 github readers (owner-only: its
  // channel.md does not count) and the 5 that read no DOF stay auto-judged, also when a batch brought tainted results
  assert.equal(tainted.length, 35);
  assert.ok(
    db((d) =>
      d
        .prepare(
          "SELECT 1 FROM outbox o WHERE consumed > 0 AND NOT EXISTS (SELECT 1 FROM events e WHERE e.consumed = o.consumed)",
        )
        .get(),
    ),
    "tainted results had a batch of their own",
  );
  for (const t of tasks) {
    const scoped = (JSON.parse(t.scope) as { dofs?: string[] }).dofs;
    assert.equal(
      tainted.includes(t),
      t.kind === "chat" || !!scoped?.includes("slack"),
      `${t.id} ${t.scope} ${db((d) => taintOf(d, t.id, cfg))}`,
    );
    // a tainted task: its first post (with the task grant) and its delete; its second post passed on the grant
    assert.equal(byOwner(t.id), tainted.includes(t) ? 2 : 1, t.id);
  }
  assert.equal(decisions, 1 + 35 + 50);
  assert.equal(grants, 35);
  assert.equal(judged, 15 * 2);
  // every call reached Slack: 2 posts and a delete per task, the placeholder swapped
  const work = slack.calls.filter((c) => c.params.channel === "C2");
  assert.equal(work.filter((c) => c.method === "chat.postMessage").length, 100);
  assert.equal(work.filter((c) => c.method === "chat.delete").length, 50);
  assert.ok(dms().length <= 3, `${dms().length} DMs`);

  // "already decided": two tabs and the CLI on one entry; a task grant still never covers a consequential request
  const t = tainted[0]?.id ?? "";
  await api("dev.link", { address: "127.0.0.250", role: "worker", task: t });
  // (not spawnSync: the fake Slack the proxy forwards to runs in this process)
  const send = (path: string) =>
    new Promise<number>((resolve, reject) => {
      const headers = {
        host: "slack.com",
        authorization: "Bearer hortus-secret-day",
        "content-type": "application/json",
      };
      const req = request(
        `http://127.0.0.1:${proxyHttp}/api/${path}`,
        { method: "POST", localAddress: "127.0.0.250", headers },
        (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ channel: "C2", text: "late", ts: "1" }));
    });
  assert.equal(await send("chat.postMessage"), 200, "the task grant covers a later post");
  assert.equal(await send("chat.delete"), 403, "a delete still asks");
  const del = pending().at(-1);
  assert.ok(del && !grantable(del));
  const tabA = await (await fetch(`http://127.0.0.1:${port}/approvals`)).text();
  const tabB = await (await fetch(`http://127.0.0.1:${port}/approvals`)).text();
  for (const tab of [tabA, tabB]) assert.match(tab, new RegExp(`id="a${del.id}"`));
  await api("approval.decide", { id: del.id, decision: "approve" });
  await assert.rejects(api("approval.decide", { id: del.id, decision: "reject" }), /already decided/);
  const cli = hortus("approvals", "approve", String(del.id));
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /already decided/);
  const cliGrant = hortus("approvals", "reject", "--grant", String(del.id));
  assert.equal(cliGrant.status, 64, "--grant only with approve");
});
