import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Config } from "../config.ts";
import { type EventRow, renderEvent } from "../planner/planner.ts";
import { directFetch } from "../test/direct.ts";
import { directSocket, FakeDiscord } from "../test/fakes/discord.ts";
import { memLog, tempDir, until } from "../test/until.ts";
import type { Change, Connector, ConnectorDeps, Incoming } from "../types.ts";
import { create, timing } from "./discord.ts";

process.env.HORTUS_HOME = tempDir("hortus-discord-");

let fake: FakeDiscord;
let conn: Connector;
let it: AsyncIterator<Incoming>;
const ac = new AbortController();
const log = memLog();

const deps = (): ConnectorDeps & { ws: ReturnType<typeof directSocket> } => ({
  name: "discord",
  config: { type: "discord", owner: "200", api: fake.api },
  log,
  fetch: directFetch(["discord"]),
  ws: directSocket(["discord"]),
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

async function mirrored() {
  const inc = await next();
  await inc.ack();
  return { event: inc.event, ...(await conn.mirror(inc.event)) };
}

const isoOf = (t: string) => `${new Date(t).toISOString().slice(0, 19)}Z`;

before(async () => {
  fake = await FakeDiscord.start();
  fake.heartbeatMs = 200;
  writeFileSync(join(process.env.HORTUS_HOME ?? "", "vault.json"), JSON.stringify(fake.vault("discord")));
  fake.user("200", "owner");
  fake.user("201", "alice");
  fake.user("202", "stranger", { member: false });
  fake.channel("300", { name: "general", topic: "talk" });
  conn = await create(deps());
  it = conn.events(ac.signal)[Symbol.asyncIterator]();
});

after(async () => {
  ac.abort();
  await it.return?.();
  await fake.close();
});

test("a guild the owner is not in makes nobody a member: anyone can add a public bot to theirs", async () => {
  fake.post("300", { user: "201", text: "in the owner's guild" });
  assert.deepEqual((await mirrored()).event.author, { user: "201", member: true });
  timing.memberMs = 0;
  fake.members.delete("200");
  fake.post("300", { user: "201", text: "the owner's gone" });
  assert.deepEqual((await mirrored()).event.author, { user: "201", member: false });
  fake.members.add("200");
  fake.post("300", { user: "201", text: "and back" });
  assert.deepEqual((await mirrored()).event.author, { user: "201", member: true });
  timing.memberMs = 3_600_000;
});

test("start: @me and the owner's DM opened; IDENTIFY carries the real token (swapped), with the intents", async () => {
  const calls = fake.calls.map((c) => `${c.method} ${c.path}`);
  assert.ok(calls.includes("GET /users/@me"));
  assert.ok(calls.includes("POST /users/@me/channels"));
  assert.ok(fake.channels.has("9200"));
  fake.post("300", { user: "201", text: "warm up" });
  await mirrored();
  assert.deepEqual(fake.identifies[0], { op: 2, token: fake.token });
  const identify = fake.received.find((f) => f.op === 2)?.d as { intents: number };
  assert.equal(identify.intents, 1 | 2 | 512 | 1024 | 4096 | 8192 | 32768);
});

test("a wrong token is a 401", async () => {
  await assert.rejects(create({ ...deps(), fetch: (u, i) => fetch(u, i) }), /HTTP 401/);
});

test("message: key session_id:s, author member, refs, v6 frontmatter, wake", async () => {
  const m = fake.post("300", { user: "201", text: "hello world" });
  const r = await mirrored();
  assert.match(r.event.key, /^sess-\d+:\d+$/);
  assert.deepEqual(r.event.author, { user: "201", member: true });
  assert.equal(r.event.bot, false);
  assert.deepEqual(r.event.refs, [`discord:300:${m.id}`]);
  assert.match(r.event.summary, /message_create in 300 by alice: hello world/);
  assert.equal(r.wake, true);
  assert.deepEqual(r.changes, [
    {
      op: "put",
      path: `300/${m.id}/${m.id}.md`,
      frontmatter: { id: m.id, thread: m.id, ts: isoOf(m.timestamp), user: "201 (alice)" },
      body: "hello world",
    },
  ]);
});

test("a thread message files under the parent channel; refs name the thread", async () => {
  const root = fake.post("300", { user: "200", text: "root" });
  await mirrored();
  fake.thread("300", { from: root.id });
  assert.deepEqual((await mirrored()).changes, []); // THREAD_CREATE
  const reply = fake.post(root.id, { user: "201", text: "in thread" });
  const r = await mirrored();
  assert.equal(r.changes[0]?.path, `300/${root.id}/${reply.id}.md`);
  assert.equal(r.changes[0]?.frontmatter?.thread, root.id);
  assert.deepEqual(r.event.refs, [`discord:300:${root.id}`, `discord:${root.id}:${root.id}`]);
  // a reply (message_reference) in a plain channel also refs the message it answers
  const answer = fake.post("300", { user: "200", text: "answer", reply: root.id });
  const a = await mirrored();
  assert.deepEqual(a.event.refs, [`discord:300:${answer.id}`, `discord:300:${root.id}`]);
  assert.equal(a.changes[0]?.frontmatter?.reply_to, root.id);
});

test("a forum post's first message, whose id is its thread's, also names the thread to answer in", async () => {
  const t = fake.thread("300", { name: "forum" });
  await mirrored();
  fake.post(t.id, { user: "201", text: "first", id: t.id });
  assert.deepEqual((await mirrored()).event.refs, [`discord:300:${t.id}`, `discord:${t.id}:${t.id}`]);
});

test("a brief shows every ref: a thread's `<thread>:<thread>` says where to answer", () => {
  const e = { id: 1, dof: "discord", key: "k", ts: "t", summary: "s", trusted: 1, author: "a", refs: '["discord:3:7","discord:7:7"]' };
  assert.match(renderEvent(Config.parse({}), e as unknown as EventRow), /^- \[e1\] discord:3:7 discord:7:7 \(/);
});

test("THREAD_MEMBERS_UPDATE leaves the thread a thread: its messages still file under the parent", async () => {
  const t = fake.thread("300", { name: "members" });
  await mirrored();
  fake.threadJoin(t.id, "201");
  fake.post(t.id, { user: "201", text: "after the join" });
  const r = await mirrored();
  assert.match(r.changes[0]?.path ?? "", new RegExp(`^300/${t.id}/`));
  assert.ok(r.event.refs.includes(`discord:300:${t.id}`));
});

test("a bulk delete deletes each message; removing all reactions clears them; a forward's text is the body", async () => {
  const a = fake.post("300", { user: "201", text: "a" });
  await mirrored();
  const b = fake.post("300", { user: "201", text: "b" });
  await mirrored();
  fake.react("300", b.id, "201", "ok");
  await mirrored();
  fake.clearReactions("300", b.id);
  assert.deepEqual((await mirrored()).changes, [
    { op: "patch", path: `300/${b.id}/${b.id}.md`, frontmatter: { reactions: null } },
  ]);
  fake.bulkDelete("300", [a.id, b.id]);
  assert.deepEqual((await mirrored()).changes, [
    { op: "delete", path: `300/${a.id}/${a.id}.md` },
    { op: "delete", path: `300/${b.id}/${b.id}.md` },
  ]);
  fake.post("300", { user: "201", forward: "forwarded text" });
  assert.equal((await mirrored()).changes[0]?.body, "forwarded text");
});

test("edit puts the same path with edited and wakes; delete deletes it", async () => {
  const m = fake.post("300", { user: "201", text: "v1" });
  await mirrored();
  fake.edit("300", m.id, "v2");
  const e = await mirrored();
  assert.equal(e.wake, true);
  assert.equal(e.changes[0]?.path, `300/${m.id}/${m.id}.md`);
  assert.equal(e.changes[0]?.body, "v2");
  assert.match(String(e.changes[0]?.frontmatter?.edited), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  fake.delete("300", m.id);
  const d = await mirrored();
  assert.deepEqual(d.changes, [{ op: "delete", path: `300/${m.id}/${m.id}.md` }]);
  assert.equal(d.wake, false);
});

test("a reaction patches `reactions` by name, never wakes; removing the last one nulls it", async () => {
  const m = fake.post("300", { user: "200", text: "react to me", quiet: true });
  fake.react("300", m.id, "201", "👍");
  const a = await mirrored();
  assert.equal(a.wake, false);
  assert.deepEqual(a.event.refs, [`discord:300:${m.id}`]);
  assert.deepEqual(a.changes, [
    { op: "patch", path: `300/${m.id}/${m.id}.md`, frontmatter: { reactions: { "👍": ["alice"] } } },
  ]);
  fake.react("300", m.id, "201", "👍", true);
  assert.deepEqual((await mirrored()).changes[0]?.frontmatter, { reactions: null });
});

test("an interaction is acked (type 5) within 3 s and dropped", async () => {
  const id = fake.interaction("200", "300");
  const cb = await until(() => fake.callbacks.find((c) => c.id === id), 3000, "interaction callback");
  assert.equal(cb.type, 5);
  assert.ok(cb.ms < 3000);
  fake.post("300", { user: "201", text: "after interaction" });
  assert.equal((await mirrored()).changes[0]?.body, "after interaction");
});

test("channel create puts channel.md; a member joining changes nothing", async () => {
  fake.channel("301", { name: "dev", topic: "code", quiet: false });
  const c = await mirrored();
  assert.deepEqual(c.changes, [
    {
      op: "put",
      path: "301/channel.md",
      frontmatter: { id: "301", name: "dev", topic: "code", guild: "1000" },
      body: "",
    },
  ]);
  fake.user("203", "newbie", { member: false });
  fake.join("203");
  const j = await mirrored();
  assert.deepEqual(j.changes, []);
  assert.equal(j.wake, false);
});

test("a non-member is not a member; dm() posts to the owner's DM and the bot's message is bot, no wake", async () => {
  fake.post("300", { user: "202", text: "hi" });
  assert.deepEqual((await mirrored()).event.author, { user: "202", member: false });
  const n = fake.calls.length;
  await conn.dm?.("200", "note to owner");
  assert.deepEqual(
    fake.calls
      .slice(n)
      .filter((c) => c.method === "POST")
      .map((c) => c.path),
    ["/channels/9200/messages"],
  );
  const r = await mirrored();
  assert.equal(r.event.bot, true);
  assert.equal(r.wake, false);
  assert.equal(r.changes[0]?.path.startsWith("9200/"), true);
  assert.equal(r.changes[0]?.frontmatter?.user, "100 (hortus)");
});

test("files: 1 KB lands, 25 MB is metadata only, / sanitized", async () => {
  const small = Buffer.alloc(1024, 7);
  const m = fake.post("300", {
    user: "201",
    files: [
      { name: "a/b.txt", bytes: small },
      { name: "big.bin", size: 25 * 1024 * 1024 },
    ],
  });
  const r = await mirrored();
  const [f1, f2] = m.attachments;
  assert.ok(f1 && f2);
  assert.deepEqual(r.changes[0]?.frontmatter?.files, [
    `files/${f1.id}-a_b.txt`,
    { name: `${f2.id}-big.bin`, size: 25 * 1024 * 1024, url: f2.url },
  ]);
  assert.equal(r.changes.length, 2);
  assert.equal(r.changes[1]?.path, `300/${m.id}/files/${f1.id}-a_b.txt`);
  assert.deepEqual(r.changes[1]?.bytes, small);
});

async function collect(scope: string, cursor: string | null) {
  const batches: { changes: Change[]; cursor: string }[] = [];
  for await (const b of conn.history?.(scope, cursor) ?? []) batches.push(b);
  return batches;
}

test("scopes: text channels, active and archived threads, the owner's DM", async () => {
  const p = fake.post("301", { user: "201", text: "p", quiet: true });
  fake.thread("301", { from: p.id, quiet: true }).thread_metadata = { archived: true };
  const s = await conn.scopes();
  for (const id of ["300", "301", "9200", p.id]) assert.ok(s.includes(id), id);
});

test("scopes: a channel the bot cannot read costs only itself; archived threads page; forum threads are found", async () => {
  fake.channel("310", { name: "secret", hidden: true });
  fake.channel("311", { type: 15, name: "forum" });
  const arch = (parent: string, id: string, at: string) => {
    const t = fake.channel(id, { type: 11, parent_id: parent, name: `t${id}` });
    t.thread_metadata = { archived: true, archive_timestamp: at };
  };
  arch("300", "3101", "2026-01-02T00:00:00+00:00");
  arch("300", "3102", "2026-01-01T00:00:00+00:00");
  arch("311", "3103", "2026-01-01T00:00:00+00:00");
  fake.archivedPage = 1;
  const s = await conn.scopes();
  fake.archivedPage = 100;
  for (const id of ["300", "3101", "3102", "3103"]) assert.ok(s.includes(id), id);
  assert.ok(!s.includes("310") && !s.includes("311"), "not scopes");
  fake.channels.delete("310");
  fake.channels.delete("311");
  for (const id of ["3101", "3102", "3103"]) fake.channels.delete(id);
});

test("history: after= paging ascending with cursor = last id; a thread scope files under its parent", async () => {
  fake.channel("302", { name: "hist" });
  fake.pageSize = 2;
  const ms = [1, 2, 3].map((i) => fake.post("302", { user: "201", text: `m${i}`, quiet: true }));
  const all = await collect("302", null);
  assert.deepEqual(
    all.flatMap((b) => b.changes.map((c) => c.path)),
    ["302/channel.md", ...ms.map((m) => `302/${m.id}/${m.id}.md`)],
  );
  assert.equal(all.at(-1)?.cursor, ms[2]?.id);
  const m4 = fake.post("302", { user: "201", text: "m4", quiet: true });
  const inc = await collect("302", ms[2]?.id ?? null);
  assert.deepEqual(
    inc.flatMap((b) => b.changes.map((c) => c.path)),
    ["302/channel.md", `302/${m4.id}/${m4.id}.md`],
  );
  const root = ms[0]?.id ?? "";
  fake.thread("302", { from: root, quiet: true });
  const t1 = fake.post(root, { user: "200", text: "t1", quiet: true });
  const th = await collect(root, null);
  assert.deepEqual(
    th.flatMap((b) => b.changes.map((c) => c.path)),
    [`302/${root}/${t1.id}.md`],
  );
  assert.equal(th.at(-1)?.cursor, t1.id);
  fake.pageSize = 100;
});

test("history: a 429 with Retry-After: 1 waits and succeeds", async () => {
  fake.rateLimit("GET /channels/302/messages", 1);
  const t = Date.now();
  await collect("302", null);
  assert.ok(Date.now() - t >= 900);
});

test("resume: a dropped gateway resumes, missed events are replayed with their keys, a replay keys the same", async () => {
  const n = fake.identifies.length;
  const pending = mirrored();
  fake.disconnect();
  await until(() => !conn.status().connected, 1000, "disconnected");
  const missed = fake.post("300", { user: "201", text: "while away" });
  const r = await pending;
  assert.equal(r.changes[0]?.path, `300/${missed.id}/${missed.id}.md`);
  assert.deepEqual(fake.identifies.slice(n), [{ op: 6, token: fake.token }]);
  fake.replay();
  assert.equal((await mirrored()).event.key, r.event.key);
});

test("REST carries Discord's User-Agent form", () => {
  assert.ok(fake.calls.every((c) => /^DiscordBot \(\S+, \S+\)$/.test(c.userAgent ?? "")));
});

test("the first heartbeat is at heartbeat_interval * jitter, not a full interval", async () => {
  const beats = () => fake.received.filter((f) => f.op === 1).length;
  const random = Math.random;
  Math.random = () => 0.01;
  fake.heartbeatMs = 20_000;
  const n = fake.connects;
  fake.disconnect();
  const pending = next(); // the generator reconnects only while it is pulled
  await until(() => fake.connects > n, 5000, "reconnect");
  const was = beats();
  await until(() => beats() > was, 2000, "a beat long before the 20 s interval");
  Math.random = random;
  fake.heartbeatMs = 200;
  fake.post("300", { user: "201", text: "after" });
  await (await pending).ack();
});

test("INVALID_SESSION → a fresh IDENTIFY; events continue under the new session", async () => {
  const pending = mirrored();
  const before = conn.status().notes?.[0];
  fake.invalidate();
  await until(() => fake.identifies.at(-1)?.op === 2 && conn.status().connected, 3000, "re-identify");
  fake.post("300", { user: "201", text: "new session" });
  const r = await pending;
  assert.equal(r.changes[0]?.body, "new session");
  assert.notEqual(conn.status().notes?.[0], before);
});

test("status notes: the gateway session and the heartbeat ack age", async () => {
  await until(() => conn.status().notes?.[1]?.startsWith("heartbeat ack"), 2000, "heartbeat ack");
  const notes = conn.status().notes ?? [];
  assert.match(notes[0] ?? "", /^gateway session sess-\d+$/);
  assert.match(notes[1] ?? "", /^heartbeat ack \d+ s ago$/);
});

test("the shipped transform passes its tests", async () => {
  const transforms = await import("../vault/transforms.ts");
  await transforms.load();
  for (const x of transforms.runTests("discord")) assert.ok(x.ok, `${x.file}: ${x.diff}`);
  assert.equal(transforms.runTests("discord").length, 4);
});

test("a close the docs forbid retrying: the owner reads why, and no IDENTIFY follows until the long wait", async () => {
  const ac2 = new AbortController();
  timing.fatalMs = 60_000;
  const c = await create(deps());
  fake.closeOnIdentify = 4014;
  const n = fake.identifies.length;
  const run = (async () => {
    for await (const _ of c.events(ac2.signal));
  })();
  await until(() => /disallowed intents.*\(4014\)/.test(c.status().error ?? ""), 5000, "the reason on Sources");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fake.identifies.length, n + 1, "one IDENTIFY, no 1 s retry");
  fake.closeOnIdentify = 0;
  ac2.abort();
  await run;
});

test("a resume host that stays down: back to the cached URL with a new session", { timeout: 40_000 }, async () => {
  const ac2 = new AbortController();
  const seen: string[] = [];
  const dead = "ws://127.0.0.1:9/gateway";
  fake.resumeUrl = dead;
  const c = await create({
    ...deps(),
    ws: (u) => {
      seen.push(u);
      return directSocket(["discord"])(u);
    },
  });
  const idents = () => fake.identifies.filter((x) => x.op === 2).length;
  const n = idents();
  const run = (async () => {
    for await (const _ of c.events(ac2.signal));
  })();
  await until(() => c.status().connected, 5000, "READY");
  assert.equal(idents(), n + 1);
  fake.resumeUrl = undefined;
  timing.helloMs = 300; // the dead host may never refuse: its connect ends at the HELLO timer
  fake.disconnect();
  await until(() => idents() === n + 2, 30_000, "a new IDENTIFY");
  assert.ok(
    seen.some((u) => u.startsWith(dead)),
    "tried the resume host first",
  );
  ac2.abort();
  await run;
});

test("a stop during GET /gateway/bot ends the connector: no connection opens after it", async () => {
  const ac = new AbortController();
  const direct = directFetch(["discord"]);
  const fetch: ConnectorDeps["fetch"] = async (u, i) => {
    const r = await direct(u, i);
    if (String(u).includes("/gateway/bot")) ac.abort(); // the abort lands in that await
    return r;
  };
  const c = await create({ ...deps(), fetch });
  const n = fake.identifies.length;
  const run = (async () => {
    for await (const _ of c.events(ac.signal));
    return "ended";
  })();
  const r = await Promise.race([run, sleep(3000).then(() => "still connected")]);
  assert.equal(r, "ended");
  assert.equal(fake.identifies.length, n);
});
