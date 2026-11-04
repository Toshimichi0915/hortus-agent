import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Config } from "../config.ts";
import { connectors } from "../connectors/index.ts";
import { openDb } from "../db.ts";
import { call } from "../rpc.ts";
import { FakeSlack } from "../test/fakes/slack.ts";
import { memLog, tempDir, until } from "../test/until.ts";
import type { Change, Connector, ConnectorFactory, Event, Incoming } from "../types.ts";
import { createGateway, type GatewayDeps, timing } from "./gateway.ts";

const home = tempDir("hortus-gateway-");
process.env.HORTUS_HOME = home;
const db = openDb(join(home, "db.sqlite"));
const owner = { role: "owner" as const };

interface Commit {
  dof: string;
  changes: Change[];
  message: string;
  /** the newest event's `consumed` when the mirror committed */
  held?: number;
}

function harness(config: () => Config, factories: Record<string, ConnectorFactory>, fetch?: typeof fake.fetch) {
  const commits: Commit[] = [];
  const order: string[] = [];
  const log = memLog();
  let wakes = 0;
  const deps: GatewayDeps = {
    db,
    config,
    log,
    connectors: factories,
    fetch: () => fetch ?? fake.fetch,
    commit: async (dof, changes, message) => {
      order.push(`commit ${changes[0]?.path}`);
      const e = db.prepare("SELECT consumed FROM events ORDER BY id DESC LIMIT 1").get() as { consumed: number };
      commits.push({ dof, changes, message, held: e?.consumed });
      return { sha: "x" };
    },
    wake: () => {
      wakes++;
    },
    hasRef: () => false,
  };
  return { gw: createGateway(deps), commits, order, log, wakes: () => wakes };
}

const rows = (dof: string) =>
  db.prepare("SELECT key, author, member, trusted, bot FROM events WHERE dof = ? ORDER BY id").all(dof) as {
    key: string;
    author: string | null;
    member: number | null;
    trusted: number;
    bot: number;
  }[];

// ---- against the fake Slack ------------------------------------------------------------------------------------

const fake = await FakeSlack.start();
writeFileSync(join(home, "vault.json"), JSON.stringify(fake.vault("slack")));
fake.user("U_OWNER", "owner");
fake.user("U_ALICE", "alice");
fake.channel("C1", { members: ["U_BOT", "U_OWNER", "U_ALICE"] });
const backfilled = fake.post("C1", { user: "U_ALICE", text: "before start", quiet: true });
const slackCfg = Config.parse({ dofs: { slack: { type: "slack", owner: "U_OWNER", api: fake.api } } });
const S = harness(() => slackCfg, connectors);
const isEvent = (c: Commit) => c.message.startsWith("sync(slack): message");
after(async () => {
  await S.gw.stop();
  await fake.close();
});

test("start backfills every member channel including the owner's DM, with cursors", async () => {
  S.gw.start();
  await until(() => db.prepare("SELECT count(*) AS n FROM syncs WHERE dof = 'slack'").get()?.n === 2, 3000, "syncs");
  const paths = S.commits.flatMap((c) => c.changes.map((x) => x.path));
  assert.ok(paths.includes(`C1/${backfilled.ts}/${backfilled.ts}.md`));
  assert.ok(paths.includes("D_U_OWNER/channel.md"));
  const cur = db.prepare("SELECT cursor FROM syncs WHERE dof = 'slack' AND scope = 'C1'").get() as { cursor: string };
  assert.equal(cur.cursor, backfilled.ts);
});

test("an event is inserted, acked, committed, and wakes the Planner", async () => {
  await until(() => S.gw.list()[0]?.connected, 3000, "connected");
  const m = fake.post("C1", { user: "U_OWNER", text: "please do x" });
  const c = await until(() => S.commits.find((x) => isEvent(x) && x.changes[0]?.body === "please do x"));
  assert.equal(c.dof, "slack");
  assert.match(c.message, /^sync\(slack\): message in C1 by owner: please do x$/);
  assert.equal(c.changes[0]?.path, `C1/${m.ts}/${m.ts}.md`);
  assert.deepEqual(
    { ...rows("slack").at(-1) },
    {
      key: [...fake.sent.values()].at(-1)?.payload.event_id,
      author: "U_OWNER",
      member: 1,
      trusted: 1,
      bot: 0,
    },
  );
  assert.equal(S.wakes(), 1);
  // held from the Planner while mirror() runs (it may not wake: a batch must not take it), released before the wake
  assert.equal(c.held, -2);
  assert.equal(
    (db.prepare("SELECT consumed FROM events ORDER BY id DESC LIMIT 1").get() as { consumed: number }).consumed,
    0,
  );
  db.prepare("INSERT INTO events(dof, key, consumed) VALUES ('crashed', 'k', -2)").run();
  harness(() => slackCfg, connectors);
  assert.equal(
    db.prepare("SELECT consumed FROM events WHERE dof = 'crashed'").get()?.consumed,
    0,
    "a restart lets it out",
  );
  db.prepare("DELETE FROM events WHERE dof = 'crashed'").run();
  // the ack crosses a socket to the fake: it can land after the commit (seen once under a loaded suite)
  await until(() => fake.acks.at(-1) === [...fake.sent.keys()].at(-1), 3000, "ack");
});

test("dedupe: a replayed envelope is acked, inserts no row and commits nothing", async () => {
  const n = rows("slack").length;
  const commits = S.commits.length;
  const acks = fake.acks.length;
  fake.replay();
  await until(() => fake.acks.length > acks, 2000, "ack of the replay");
  await sleep(100);
  assert.equal(rows("slack").length, n);
  assert.equal(S.commits.length, commits);
});

test("the bot's own message is mirrored, untrusted, and does not wake", async () => {
  const wakes = S.wakes();
  const res = await fetch(`${fake.api}/chat.postMessage`, {
    method: "POST",
    headers: { authorization: `Bearer ${fake.botToken}`, "content-type": "application/json" },
    body: JSON.stringify({ channel: "C1", text: "done: x" }),
  });
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
  await until(() => S.commits.find((x) => x.changes[0]?.body === "done: x"));
  assert.deepEqual({ trusted: rows("slack").at(-1)?.trusted, bot: rows("slack").at(-1)?.bot }, { trusted: 0, bot: 1 });
  await sleep(50);
  assert.equal(S.wakes(), wakes);
});

test("two events for one message (new, then edited) produce two commits in order", async () => {
  const m = fake.post("C1", { user: "U_ALICE", text: "first" });
  fake.edit("C1", m.ts, "second");
  await until(() => S.commits.filter((x) => x.changes[0]?.path === `C1/${m.ts}/${m.ts}.md`).length === 2);
  const [a, b] = S.commits.filter((x) => x.changes[0]?.path === `C1/${m.ts}/${m.ts}.md`);
  assert.equal(a?.changes[0]?.body, "first");
  assert.equal(a?.changes[0]?.frontmatter?.edited, undefined);
  assert.equal(b?.changes[0]?.body, "second");
  assert.ok(b?.changes[0]?.frontmatter?.edited);
});

test("membership: the bot joining a channel adds it to scopes, the next reconcile backfills it", async () => {
  fake.channel("C9", { members: [] });
  const old = fake.post("C9", { user: "U_ALICE", text: "old news", quiet: true });
  fake.join("C9", "U_BOT");
  await until(() => S.commits.find((x) => x.changes[0]?.path === "C9/channel.md"));
  await S.gw.reconcile("slack");
  assert.ok(S.commits.some((x) => x.changes.some((c) => c.path === `C9/${old.ts}/${old.ts}.md`)));
  assert.ok(db.prepare("SELECT 1 FROM syncs WHERE dof = 'slack' AND scope = 'C9'").get());
});

test("source.list and source.resync", async () => {
  const list = (await call("source.list", {}, owner)) as {
    dof: string;
    connected: boolean;
    scopes: { scope: string }[];
  }[];
  assert.equal(list[0]?.dof, "slack");
  assert.equal(list[0]?.connected, true);
  assert.deepEqual(list[0]?.scopes.map((s) => s.scope).sort(), ["C1", "C9", "D_U_OWNER"]);
  const before = S.commits.length;
  assert.deepEqual(await call("source.resync", { dof: "slack", scope: "C1" }, owner), { ok: true });
  assert.ok(
    S.commits.slice(before).some((c) => c.changes.some((x) => x.path === `C1/${backfilled.ts}/${backfilled.ts}.md`)),
  );
  await assert.rejects(call("source.resync", { dof: "nope" }, owner), /no running source/);
  await assert.rejects(call("source.list", {}, { role: "worker" }), /not allowed/);
});

// ---- against stub connectors -----------------------------------------------------------------------------------

interface Stub extends Connector {
  push(e: Partial<Event>, ack?: () => void): void;
}

const base = { ts: "t", payload: {}, author: null, bot: false, refs: [] };

function stub(name: string, over: Partial<Connector> = {}): Stub {
  const queue: Incoming[] = [];
  let n = 0;
  return {
    push(e, ack = () => {}) {
      const event: Event = {
        dof: name,
        key: `k${++n}`,
        ts: "t",
        payload: {},
        author: null,
        bot: false,
        summary: `e${n}`,
        refs: [],
        ...e,
      };
      queue.push({ event, ack: async () => ack() });
    },
    async *events(signal) {
      while (!signal.aborted) {
        const x = queue.shift();
        if (x) yield x;
        else await sleep(5);
      }
    },
    mirror: async (e) => ({ changes: [{ op: "put", path: `${e.key}.md`, body: "" }], wake: true }),
    scopes: async () => [],
    status: () => ({ connected: true }),
    ...over,
  };
}

test("ack after the insert and before the commit; a mirror that throws is logged and the loop continues", async () => {
  let s: Stub | undefined;
  let fail = true;
  const cfg = Config.parse({ dofs: { st: { type: "stub" } } });
  const H = harness(() => cfg, {
    stub: async () => {
      s = stub("st", {
        mirror: async (e) => {
          if (fail) {
            fail = false;
            throw new Error("mirror boom");
          }
          return { changes: [{ op: "put", path: `${e.key}.md`, body: "" }], wake: false };
        },
      });
      return s;
    },
  });
  H.gw.start();
  const st = await until(() => s);
  st.push({ key: "a" }, () => H.order.push(`ack a row=${rows("st").some((r) => r.key === "a")}`));
  st.push({ key: "b" }, () => H.order.push(`ack b row=${rows("st").some((r) => r.key === "b")}`));
  await until(() => H.commits.length === 1);
  assert.deepEqual(H.order, ["ack a row=true", "ack b row=true", "commit b.md"]);
  assert.ok(H.log.errors.some((e) => e.includes("mirror boom")));
  await H.gw.stop();
});

test("a mirror that fails: the event goes to the Planner now, Sources says so, the next success clears it", async () => {
  let s: Stub | undefined;
  let fail = true;
  const cfg = Config.parse({ dofs: { sf: { type: "stub" } } });
  const H = harness(() => cfg, {
    stub: async () => {
      s = stub("sf", {
        mirror: async () => {
          if (fail) throw new Error("mirror boom");
          return { changes: [], wake: false };
        },
      });
      return s;
    },
  });
  const consumed = (key: string) =>
    (
      db.prepare("SELECT consumed FROM events WHERE dof = 'sf' AND key = ?").get(key) as
        | { consumed: number }
        | undefined
    )?.consumed;
  H.gw.start();
  const st = await until(() => s);
  st.push({ key: "owners" });
  await until(() => H.log.errors.length === 1);
  await until(() => H.wakes() === 1, 1000, "a wake for the failed event");
  assert.equal(consumed("owners"), 0);
  assert.match(H.gw.list()[0]?.error ?? "", /mirror failed: mirror boom/);
  st.push({ key: "bots", bot: true });
  await until(() => H.log.errors.length === 2);
  assert.equal(H.wakes(), 1, "a bot's event never wakes");
  assert.equal(consumed("bots"), -1);
  fail = false;
  st.push({ key: "next" });
  await until(() => consumed("next") === -1);
  await until(() => !H.gw.list()[0]?.error, 1000, "the error cleared");
  await H.gw.stop();
});

test("reconcile: a scope that throws keeps its cursor; the other scopes proceed", async () => {
  const cfg = Config.parse({ dofs: { rc: { type: "stub" } } });
  db.prepare(
    "INSERT INTO syncs(dof, scope, cursor, last_sync) VALUES ('rc', 'bad', '5', 'then'), ('rc', 'good', '1', 'then')",
  ).run();
  const seen: (string | null)[] = [];
  const H = harness(() => cfg, {
    stub: async () =>
      stub("rc", {
        scopes: async () => ["bad", "good"],
        async *history(scope, cursor) {
          seen.push(cursor);
          if (scope === "bad") throw new Error("scope boom");
          yield { changes: [{ op: "put", path: `${scope}/x.md`, body: "" }], cursor: "9" };
        },
      }),
  });
  H.gw.start();
  await until(() => H.commits.length === 1);
  await sleep(20);
  const cur = (scope: string) =>
    (db.prepare("SELECT cursor FROM syncs WHERE dof = 'rc' AND scope = ?").get(scope) as { cursor: string }).cursor;
  assert.deepEqual(seen, ["5", "1"]);
  assert.equal(cur("bad"), "5");
  assert.equal(cur("good"), "9");
  assert.ok(H.log.errors.some((e) => e.includes("reconcile bad failed")));
  await H.gw.stop();
});

test("a stop during a backfill ends between its batches, the cursor at the last one", async () => {
  const cfg = Config.parse({ dofs: { long: { type: "stub" } } });
  let batches = 0;
  const H = harness(() => cfg, {
    stub: async (d) =>
      stub(d.name, {
        scopes: async () => ["s1", "s2"],
        async *history() {
          for (;;) {
            await sleep(5);
            yield { changes: [], cursor: String(++batches) };
          }
        },
      }),
  });
  H.gw.start();
  await until(() => batches > 2);
  const t = Date.now();
  await Promise.race([H.gw.stop(), sleep(2000)]);
  assert.ok(Date.now() - t < 1000, `the stop took ${Date.now() - t} ms`);
  const at = batches;
  await sleep(30);
  assert.equal(batches, at, "the backfill ended with the stop");
  const row = db.prepare("SELECT cursor FROM syncs WHERE dof = 'long' AND scope = 's1'").get() as { cursor: string };
  assert.equal(row.cursor, String(at));
  assert.deepEqual(H.log.errors, []);
});

test("a stop cuts what its grace does not finish: a stalled call, a Retry-After, the events still queued", async () => {
  const was = timing.graceMs;
  timing.graceMs = 50;
  const cfg = Config.parse({
    dofs: { stuck: { type: "stub" }, q: { type: "stub" }, limited: { type: "slack", api: fake.api } },
  });
  const stalled = (url: string, init?: RequestInit) =>
    url.includes("/api/")
      ? fake.fetch(url, init)
      : new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error(`cut ${url}`)));
        });
  let mirrors = 0;
  const q = stub("q", {
    mirror: async () => {
      mirrors++;
      await sleep(100); // past the grace, with the next event already queued
      return { changes: [], wake: false };
    },
  });
  const H = harness(
    () => cfg,
    {
      ...connectors,
      stub: async (d) =>
        d.name === "q"
          ? q
          : stub(d.name, {
              scopes: async () => ["s"],
              async *history() {
                await d.fetch("http://stalled.test/");
                yield { changes: [], cursor: "never" };
              },
            }),
    },
    stalled as typeof fake.fetch,
  );
  try {
    fake.retryAfter = 600;
    fake.rateLimit("conversations.list", 1);
    const limited = fake.calls.length;
    H.gw.start();
    await until(() => H.gw.connector("q") && fake.calls.slice(limited).some((c) => c.method === "conversations.list"));
    for (const key of ["q1", "q2", "q3"]) q.push({ key });
    await until(() => mirrors > 0);
    const t = Date.now();
    await Promise.race([H.gw.stop(), sleep(2000)]);
    assert.ok(Date.now() - t < 1000, `the stop took ${Date.now() - t} ms`);
    assert.deepEqual(
      rows("q").map((r) => r.key),
      ["q1"],
      "the queued events are left for their redelivery",
    );
  } finally {
    timing.graceMs = was;
    fake.retryAfter = 1;
  }
});

test("past the grace a queue the service will not send again still goes in, and wakes the Planner", async () => {
  const was = timing.graceMs;
  timing.graceMs = 20;
  const cfg = Config.parse({ dofs: { dq: { type: "stub" } } });
  const stalled = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      if (init?.signal?.aborted) return reject(new Error("cut"));
      init?.signal?.addEventListener("abort", () => reject(new Error("cut")));
    });
  let queued: Stub | undefined;
  let go = false;
  const H = harness(
    () => cfg,
    {
      ...connectors,
      stub: async (d) => {
        queued = stub("dq", {
          // Discord's connect(): after the signal it still yields what it received
          async *events(signal) {
            while (!go) await sleep(1);
            for (const key of ["d1", "d2", "d3"])
              yield { event: { ...base, dof: "dq", key, summary: key }, ack: async () => {} };
            if (!signal.aborted) await new Promise((r) => signal.addEventListener("abort", r));
          },
          mirror: async () => {
            await d.fetch("http://stalled.test/");
            return { changes: [], wake: true };
          },
          async *history() {},
        });
        return queued;
      },
    },
    stalled as typeof fake.fetch,
  );
  try {
    H.gw.start();
    await until(() => queued);
    go = true;
    await until(() => rows("dq").length > 0);
    await H.gw.stop();
    const left = db.prepare("SELECT key, consumed FROM events WHERE dof = 'dq' ORDER BY id").all();
    assert.deepEqual(
      left.map((r) => ({ ...r })),
      ["d1", "d2", "d3"].map((key) => ({ key, consumed: 0 })),
    );
    assert.equal(H.wakes(), 3);
  } finally {
    timing.graceMs = was;
  }
});

test("reload restarts only changed entries, starts added ones and stops removed ones", async () => {
  let cfg = Config.parse({ dofs: { a: { type: "stub" }, b: { type: "stub" }, c: { type: "stub" } } });
  const created: string[] = [];
  const H = harness(() => cfg, {
    stub: async (d) => {
      created.push(d.name);
      return stub(d.name);
    },
  });
  H.gw.start();
  await until(() => created.length === 3);
  const prev = cfg;
  cfg = Config.parse({ dofs: { a: { type: "stub" }, b: { type: "stub", owner: "U1" }, d: { type: "stub" } } });
  await H.gw.reload(prev);
  await until(() => created.length === 5);
  assert.deepEqual(created.slice(3).sort(), ["b", "d"]);
  assert.deepEqual(
    H.gw.list().map((s) => s.dof),
    ["a", "b", "d"],
  );
  await H.gw.stop();
});
