import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { FakeSlack } from "../test/fakes/slack.ts";
import { memLog, tempDir, until } from "../test/until.ts";
import type { Change, Connector, ConnectorDeps, Incoming } from "../types.ts";
import { backoff } from "./retry.ts";
import { create, timing } from "./slack.ts";

process.env.HORTUS_HOME = tempDir("hortus-slack-");

let fake: FakeSlack;
let conn: Connector;
let it: AsyncIterator<Incoming>;
const ac = new AbortController();
const log = memLog();

const deps = (): ConnectorDeps => ({
  name: "slack",
  config: { type: "slack", owner: "U_OWNER", api: fake.api },
  log,
  fetch: fake.fetch,
  hasRef: () => false,
});

async function next(): Promise<Incoming> {
  const r = await Promise.race([
    it.next(),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no event within 5 s")), 5000)),
  ]);
  assert.ok(!r.done);
  return r.value;
}

/** next event → ack → mirror */
async function mirrored() {
  const inc = await next();
  await inc.ack();
  return { event: inc.event, ...(await conn.mirror(inc.event)) };
}

const md = (changes: Change[]) => changes.filter((c) => c.path.endsWith(".md"));

before(async () => {
  fake = await FakeSlack.start();
  writeFileSync(join(process.env.HORTUS_HOME ?? "", "vault.json"), JSON.stringify(fake.vault("slack")));
  fake.user("U_OWNER", "owner");
  fake.user("U_ALICE", "alice");
  fake.user("U_GUEST", "guest", { is_restricted: true });
  fake.channel("C1", { name: "general", topic: { value: "talk" }, members: ["U_BOT", "U_OWNER", "U_ALICE"] });
  fake.channel("C2", { members: ["U_ALICE"] });
  conn = await create(deps());
  it = conn.events(ac.signal)[Symbol.asyncIterator]();
});

after(async () => {
  ac.abort();
  await it.return?.();
  await fake.close();
});

test("start: auth.test, users.list and the owner's DM opened, all with placeholders only", () => {
  const methods = fake.calls.map((c) => c.method);
  for (const m of ["auth.test", "users.list", "conversations.open"]) assert.ok(methods.includes(m), m);
  assert.ok(fake.channels.has("D_U_OWNER"));
});

test("a wrong token is invalid_auth", async () => {
  await assert.rejects(create({ ...deps(), fetch: (u, i) => fetch(u, i) }), /invalid_auth/);
});

test("message: event fields, frontmatter, wake, ack", async () => {
  const m = fake.post("C1", { user: "U_ALICE", text: "hello world" });
  const r = await mirrored();
  assert.match(r.event.key, /^Ev\d+$/);
  assert.deepEqual(r.event.author, { user: "U_ALICE", member: true });
  assert.equal(r.event.bot, false);
  assert.deepEqual(r.event.refs, [`slack:C1:${m.ts}`]);
  assert.match(r.event.summary, /message in C1 by alice: hello world/);
  assert.equal(r.wake, true);
  // the Planner, the brief and the inbox see only the summary: an instruction past the old 80 characters was lost
  fake.post("C1", { user: "U_ALICE", text: `${"x".repeat(200)} and do not touch main` });
  assert.match((await mirrored()).event.summary, /do not touch main$/);
  // pasted code keeps its lines and indent: collapsed, a Worker wrote it on one line and called that "exactly as written"
  fake.post("C1", { user: "U_ALICE", text: "add this:\n```\nif x:\n    y()\n```" });
  assert.match((await mirrored()).event.summary, /add this:\n```\nif x:\n {4}y\(\)\n```$/);
  assert.deepEqual(r.changes, [
    {
      op: "put",
      path: `C1/${m.ts}/${m.ts}.md`,
      frontmatter: {
        id: m.ts,
        thread: m.ts,
        ts: `${new Date(Number(m.ts) * 1000).toISOString().slice(0, 19)}Z`,
        user: "U_ALICE (alice)",
      },
      body: "hello world",
    },
  ]);
  await until(() => fake.acks.length > 0, 2000, "ack");
});

test("thread reply and thread_broadcast are filed under the parent", async () => {
  const parent = fake.post("C1", { user: "U_OWNER", text: "parent" });
  await mirrored();
  const reply = fake.post("C1", { user: "U_ALICE", text: "reply", thread_ts: parent.ts });
  const r1 = await mirrored();
  assert.equal(r1.changes[0]?.path, `C1/${parent.ts}/${reply.ts}.md`);
  assert.equal(r1.changes[0]?.frontmatter?.thread, parent.ts);
  assert.deepEqual(r1.event.refs, [`slack:C1:${parent.ts}`]);
  const b = fake.post("C1", { user: "U_ALICE", text: "also", thread_ts: parent.ts, subtype: "thread_broadcast" });
  const r2 = await mirrored();
  assert.equal(r2.changes[0]?.path, `C1/${parent.ts}/${b.ts}.md`);
});

test("edit puts the same path with edited; delete deletes it", async () => {
  const m = fake.post("C1", { user: "U_ALICE", text: "v1" });
  await mirrored();
  fake.edit("C1", m.ts, "v2");
  const e = await mirrored();
  assert.equal(e.wake, true);
  assert.equal(e.changes[0]?.path, `C1/${m.ts}/${m.ts}.md`);
  assert.equal(e.changes[0]?.body, "v2");
  assert.match(String(e.changes[0]?.frontmatter?.edited), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  fake.delete("C1", m.ts);
  const d = await mirrored();
  assert.deepEqual(d.changes, [{ op: "delete", path: `C1/${m.ts}/${m.ts}.md` }]);
  assert.equal(d.wake, false);
});

test("reactions patch the message's reactions by name and never wake", async () => {
  const parent = fake.post("C1", { user: "U_OWNER", text: "p", quiet: true });
  const m = fake.post("C1", { user: "U_OWNER", text: "r", thread_ts: parent.ts, quiet: true });
  fake.react("C1", m.ts, "U_ALICE", "+1");
  const a = await mirrored();
  assert.equal(a.wake, false);
  assert.deepEqual(a.changes, [
    { op: "patch", path: `C1/${parent.ts}/${m.ts}.md`, frontmatter: { reactions: { "+1": ["alice"] } } },
  ]);
  fake.react("C1", m.ts, "U_BOT", "eyes");
  assert.deepEqual((await mirrored()).changes[0]?.frontmatter, { reactions: { "+1": ["alice"], eyes: ["hortus"] } });
  fake.react("C1", m.ts, "U_ALICE", "+1", true);
  fake.react("C1", m.ts, "U_BOT", "eyes", true);
  await mirrored();
  assert.deepEqual((await mirrored()).changes[0]?.frontmatter, { reactions: null });
});

test("message_replied (no subtype, as delivered) writes nothing and wakes nothing; /me is mirrored", async () => {
  const p = fake.post("C1", { user: "U_ALICE", text: "parent" });
  await mirrored();
  fake.replied("C1", p.ts);
  const r = await mirrored();
  assert.deepEqual(r.changes, []);
  assert.equal(r.wake, false);
  fake.post("C1", { user: "U_ALICE", text: "waves", subtype: "me_message" });
  const me = await mirrored();
  assert.equal(md(me.changes)[0]?.body, "waves");
});

test("a reaction on a file (no channel, no ts) is ignored; a private channel's rename puts channel.md", async () => {
  fake.emit({ type: "reaction_added", user: "U_ALICE", reaction: "eyes", item: { type: "file", file: "F1" } });
  assert.deepEqual((await mirrored()).changes, []);
  fake.emit({
    type: "group_rename",
    channel: { id: "C1", name: "renamed", created: 1 },
    event_ts: "1730000001.000100",
  });
  assert.equal((await mirrored()).changes[0]?.path, "C1/channel.md");
});

test("membership puts channel.md; other events change nothing", async () => {
  fake.join("C1", "U_GUEST");
  const r = await mirrored();
  assert.deepEqual(r.changes, [
    {
      op: "put",
      path: "C1/channel.md",
      frontmatter: {
        id: "C1",
        name: "general",
        topic: "talk",
        members: ["U_BOT (hortus)", "U_OWNER (owner)", "U_ALICE (alice)", "U_GUEST (guest)"],
      },
      body: "",
    },
  ]);
  assert.equal(r.wake, false);
  fake.emit({ type: "user_change", user: { id: "U_ALICE" }, event_ts: "1730000000.000001" });
  assert.deepEqual((await mirrored()).changes, []);
});

test("files: 1 KB lands, 25 MB is metadata only, / sanitized, empty text kept", async () => {
  const small = Buffer.alloc(1024, 7);
  const m = fake.post("C1", {
    user: "U_ALICE",
    files: [
      { name: "a/b.txt", bytes: small },
      { name: "big.bin", size: 25 * 1024 * 1024 },
    ],
  });
  const r = await mirrored();
  const [f1, f2] = m.files ?? [];
  assert.ok(f1 && f2);
  assert.equal(r.changes[0]?.body, "");
  assert.deepEqual(r.changes[0]?.frontmatter?.files, [
    `files/${f1.id}-a_b.txt`,
    { name: `${f2.id}-big.bin`, size: 25 * 1024 * 1024, url: f2.url_private_download },
  ]);
  assert.equal(r.changes.length, 2);
  assert.equal(r.changes[1]?.path, `C1/${m.ts}/files/${f1.id}-a_b.txt`);
  assert.deepEqual(r.changes[1]?.bytes, small);
});

test("ts with trailing zeros stays a string; an unknown user renders as its id; a guest is not a member", async () => {
  fake.post("C1", { user: "U999", text: "ghost", ts: "1730099999.100000" });
  const r = await mirrored();
  assert.equal(r.changes[0]?.frontmatter?.id, "1730099999.100000");
  assert.equal(r.changes[0]?.frontmatter?.user, "U999");
  assert.deepEqual(r.event.author, { user: "U999", member: false });
  fake.post("C1", { user: "U_GUEST", text: "hi" });
  assert.deepEqual((await mirrored()).event.author, { user: "U_GUEST", member: false });
});

test("dm posts to the owner's DM only; the bot's own message is mirrored, bot: true, no wake", async () => {
  const before = fake.calls.length;
  await conn.dm?.("U_OWNER", "note to owner");
  const posts = fake.calls.slice(before).filter((c) => c.method === "chat.postMessage");
  assert.deepEqual(
    posts.map((c) => c.params.channel),
    ["D_U_OWNER"],
  );
  const r = await mirrored();
  assert.equal(r.event.bot, true);
  assert.equal(r.wake, false);
  assert.equal(md(r.changes)[0]?.path.startsWith("D_U_OWNER/"), true);
  assert.equal(md(r.changes)[0]?.frontmatter?.user, "U_BOT (hortus)");
});

test("scopes: member channels plus the owner's DM; a join adds the channel", async () => {
  assert.deepEqual((await conn.scopes()).sort(), ["C1", "D_U_OWNER"]);
  fake.join("C2", "U_BOT");
  await mirrored();
  assert.deepEqual((await conn.scopes()).sort(), ["C1", "C2", "D_U_OWNER"]);
});

async function collect(scope: string, cursor: string | null) {
  const batches: { changes: Change[]; cursor: string }[] = [];
  for await (const b of conn.history?.(scope, cursor) ?? []) batches.push(b);
  return batches;
}

test("history: paginated backfill with replies, cursor skips older, old threads skipped", async () => {
  fake.channel("C3", { members: ["U_BOT"] });
  fake.pageSize = 2;
  const p1 = fake.post("C3", { user: "U_ALICE", text: "one", quiet: true });
  const r1 = fake.post("C3", { user: "U_OWNER", text: "re one", thread_ts: p1.ts, quiet: true });
  const p2 = fake.post("C3", { user: "U_ALICE", text: "two", quiet: true });
  const p3 = fake.post("C3", { user: "U_ALICE", text: "three", quiet: true });
  const all = await collect("C3", null);
  const paths = all.flatMap((b) => b.changes.map((c) => c.path));
  assert.deepEqual(paths, [
    "C3/channel.md",
    `C3/${p1.ts}/${p1.ts}.md`,
    `C3/${p1.ts}/${r1.ts}.md`,
    `C3/${p2.ts}/${p2.ts}.md`,
    `C3/${p3.ts}/${p3.ts}.md`,
  ]);
  assert.equal(all.at(-1)?.cursor, p3.ts);

  // a new reply under an old parent: the parent is older than the cursor, so history does not see it
  fake.post("C3", { user: "U_OWNER", text: "late", thread_ts: p1.ts, quiet: true });
  const p4 = fake.post("C3", { user: "U_ALICE", text: "four", quiet: true });
  const r4 = fake.post("C3", { user: "U_OWNER", text: "re four", thread_ts: p4.ts, quiet: true });
  const inc = await collect("C3", p3.ts);
  assert.deepEqual(
    inc.flatMap((b) => b.changes.map((c) => c.path)),
    ["C3/channel.md", `C3/${p4.ts}/${p4.ts}.md`, `C3/${p4.ts}/${r4.ts}.md`],
  );
  assert.equal(inc.at(-1)?.cursor, p4.ts);
  assert.equal((await collect("C3", p4.ts)).at(-1)?.cursor, p4.ts);
  fake.pageSize = 1000;
});

test("history: a 429 with Retry-After: 1 waits and succeeds", async () => {
  fake.rateLimit("conversations.history", 1);
  const t = Date.now();
  const b = await collect("C3", null);
  assert.ok(Date.now() - t >= 900);
  assert.ok(b.length >= 1);
});

test("history: an error throws out (the gateway keeps the old cursor)", async () => {
  await assert.rejects(collect("C_NOPE", null), /channel_not_found/);
});

test("reconnect: disconnect → back within 2 s, later events arrive", async () => {
  const n = fake.connects;
  const pending = mirrored(); // the gateway always has a pull outstanding
  fake.disconnect();
  await until(() => !conn.status().connected, 500, "disconnected");
  await until(() => fake.connects > n && conn.status().connected, 2000, "reconnect");
  fake.post("C1", { user: "U_ALICE", text: "after reconnect" });
  assert.equal((await pending).changes[0]?.body, "after reconnect");
});

test("a connection past its announced life with no disconnect is replaced (a dead TCP path sends no close)", async () => {
  const n = fake.connects;
  fake.connectionTime = 0.2;
  fake.disconnect();
  const pending = next(); // the generator reconnects only while it is pulled
  await until(() => fake.connects === n + 1, 5000, "reconnect");
  fake.connectionTime = 3600;
  await until(() => fake.connects === n + 2, 5000, "replaced after 0.3 s, by nothing but the clock");
  fake.post("C1", { user: "U_ALICE", text: "still here" });
  await (await pending).ack();
});

test("a socket that never says hello is retried", async () => {
  timing.helloMs = 300;
  fake.hello = false;
  const n = fake.connects;
  const pending = mirrored();
  fake.disconnect();
  await until(() => fake.connects > n, 2500, "hello-less connect");
  fake.hello = true;
  fake.post("C1", { user: "U_ALICE", text: "after hello" });
  assert.equal((await pending).changes[0]?.body, "after hello");
  assert.ok(log.errors.some((e) => e.includes("no hello")));
  timing.helloMs = 10_000;
});

test("a stop during apps.connections.open ends the connector: no session opens after it", async () => {
  const ac = new AbortController();
  const fetch: ConnectorDeps["fetch"] = async (u, i) => {
    const r = await fake.fetch(u, i);
    if (String(u).includes("apps.connections.open")) ac.abort(); // the abort lands in that await
    return r;
  };
  const c = await create({ ...deps(), fetch });
  const n = fake.connects;
  const run = (async () => {
    for await (const _ of c.events(ac.signal));
    return "ended";
  })();
  const r = await Promise.race([run, sleep(3000).then(() => "still connected")]);
  assert.equal(r, "ended");
  assert.equal(fake.connects, n);
});

test("backoff: 1 s doubling, capped at 60 s", () => {
  assert.deepEqual([0, 1, 2, 5, 6, 30].map(backoff), [1000, 2000, 4000, 32000, 60000, 60000]);
});
