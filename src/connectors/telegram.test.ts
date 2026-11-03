import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { directPathFetch, FakeTelegram } from "../test/fakes/telegram.ts";
import { memLog, tempDir, until } from "../test/until.ts";
import type { Connector, ConnectorDeps, Incoming } from "../types.ts";
import { create, timing } from "./telegram.ts";

process.env.HORTUS_HOME = tempDir("hortus-telegram-");
timing.pollS = 1;

let fake: FakeTelegram;
let conn: Connector;
let it: AsyncIterator<Incoming>;
let ac = new AbortController();
const log = memLog();
const OWNER = 500;
const ALICE = 501;
const GROUP = -100;

const deps = (): ConnectorDeps => ({
  name: "telegram",
  config: { type: "telegram", owner: String(OWNER), api: fake.api },
  log,
  fetch: directPathFetch(["telegram"]),
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

const iso = (s: number) => `${new Date(s * 1000).toISOString().slice(0, 19)}Z`;
const offsets = () => fake.calls.filter((c) => c.method === "getUpdates").map((c) => c.params.offset);

before(async () => {
  fake = await FakeTelegram.start();
  writeFileSync(join(process.env.HORTUS_HOME ?? "", "vault.json"), JSON.stringify(fake.vault("telegram")));
  fake.user(OWNER, "owner");
  fake.user(ALICE, "alice");
  fake.user(502, "stranger");
  fake.user(503, "otherbot", { is_bot: true });
  fake.chat(GROUP, { title: "team", members: { [OWNER]: "creator", [ALICE]: "member" } });
  fake.chat(OWNER);
  conn = await create(deps());
  it = conn.events(ac.signal)[Symbol.asyncIterator]();
});

after(async () => {
  ac.abort();
  await it.return?.();
  await fake.close();
});

test("a wrong token is Unauthorized", async () => {
  await assert.rejects(create({ ...deps(), fetch: (u, i) => fetch(u, i) }), /Unauthorized/);
});

test("before the owner's first message: no DM scope, dm() fails, the Sources hint shows", async () => {
  assert.deepEqual(await conn.scopes(), []);
  await assert.rejects(conn.dm?.(String(OWNER), "hello?") ?? Promise.reject(), /can't initiate/);
  assert.ok(conn.status().notes?.includes("message the bot once to open your DM"));
});

test("message: key update_id, member via getChatMember, refs, v6 frontmatter, wake; long poll with timeout", async () => {
  const m = fake.post(GROUP, { user: ALICE, text: "hello world" });
  const r = await mirrored();
  assert.equal(r.event.key, String(fake.sent.at(-1)?.update_id));
  assert.deepEqual(r.event.author, { user: String(ALICE), member: true });
  assert.equal(r.event.bot, false);
  assert.deepEqual(r.event.refs, [`telegram:${GROUP}:${m.message_id}`]);
  assert.match(r.event.summary, /message in -100 by alice: hello world/);
  assert.equal(r.wake, true);
  assert.deepEqual(r.changes, [
    {
      op: "put",
      path: `${GROUP}/${m.message_id}/${m.message_id}.md`,
      frontmatter: { id: m.message_id, thread: m.message_id, ts: iso(m.date), user: `${ALICE} (alice)` },
      body: "hello world",
    },
  ]);
  const poll = fake.calls.find((c) => c.method === "getUpdates")?.params;
  assert.equal(poll?.timeout, 1);
  assert.deepEqual(poll?.allowed_updates, [
    "message",
    "edited_message",
    "message_reaction",
    "chat_member",
    "my_chat_member",
  ]);
});

test("getChatMember is cached: a second message by the same user asks nothing", async () => {
  const n = fake.calls.filter((c) => c.method === "getChatMember").length;
  fake.post(GROUP, { user: ALICE, text: "again" });
  await mirrored();
  assert.equal(fake.calls.filter((c) => c.method === "getChatMember").length, n);
  fake.post(GROUP, { user: 502, text: "who am i" });
  assert.deepEqual((await mirrored()).event.author, { user: "502", member: false });
});

test("the offset advances only after the ack; an unacked update is delivered again with the same key", async () => {
  const u = fake.post(GROUP, { user: ALICE, text: "crash before insert" });
  const first = await next(); // not acked: the gateway crashed before its insert
  await until(() => fake.polls > 0);
  // a new connector (the restarted hortusd) starts without an offset: the update comes again
  ac.abort();
  await it.return?.();
  ac = new AbortController();
  conn = await create(deps());
  it = conn.events(ac.signal)[Symbol.asyncIterator]();
  const again = await mirrored();
  assert.equal(again.event.key, first.event.key);
  assert.equal(again.changes[0]?.path, `${GROUP}/${u.message_id}/${u.message_id}.md`);
  const n = offsets().length;
  fake.post(GROUP, { user: ALICE, text: "next" });
  await mirrored();
  assert.ok(
    offsets()
      .slice(n)
      .includes(Number(again.event.key) + 1),
  );
});

test("a reply chain of three files under the root", async () => {
  const a = fake.post(GROUP, { user: OWNER, text: "root" });
  await mirrored();
  const b = fake.post(GROUP, { user: ALICE, text: "re root", reply: a.message_id });
  const rb = await mirrored();
  const c = fake.post(GROUP, { user: OWNER, text: "re re root", reply: b.message_id });
  const rc = await mirrored();
  assert.equal(rb.changes[0]?.path, `${GROUP}/${a.message_id}/${b.message_id}.md`);
  assert.equal(rc.changes[0]?.path, `${GROUP}/${a.message_id}/${c.message_id}.md`);
  assert.deepEqual(rc.event.refs, [`telegram:${GROUP}:${a.message_id}`]);
  assert.equal(rc.changes[0]?.frontmatter?.reply_to, b.message_id);
});

test("a forum topic uses message_thread_id", async () => {
  const m = fake.post(GROUP, { user: ALICE, text: "in topic", topic: 77 });
  const r = await mirrored();
  assert.equal(r.changes[0]?.path, `${GROUP}/77/${m.message_id}.md`);
  assert.deepEqual(r.event.refs, [`telegram:${GROUP}:77`]);
});

test("edit puts the same path with edited and wakes", async () => {
  const m = fake.post(GROUP, { user: ALICE, text: "v1" });
  await mirrored();
  fake.edit(GROUP, m.message_id, "v2");
  const e = await mirrored();
  assert.equal(e.wake, true);
  assert.equal(e.changes[0]?.path, `${GROUP}/${m.message_id}/${m.message_id}.md`);
  assert.equal(e.changes[0]?.body, "v2");
  assert.ok(e.changes[0]?.frontmatter?.edited);
});

test("reactions patch `reactions` by emoji and never wake", async () => {
  const m = fake.post(GROUP, { user: OWNER, text: "react", quiet: true });
  fake.react(GROUP, m.message_id, ALICE, "👍");
  const a = await mirrored();
  assert.equal(a.wake, false);
  assert.deepEqual(a.changes, [
    {
      op: "patch",
      path: `${GROUP}/${m.message_id}/${m.message_id}.md`,
      frontmatter: { reactions: { "👍": ["alice"] } },
    },
  ]);
  fake.react(GROUP, m.message_id, ALICE, "👍", true);
  assert.deepEqual((await mirrored()).changes[0]?.frontmatter, { reactions: null });
});

test("files: a 1 KB document lands via getFile, 25 MB is metadata only", async () => {
  const small = Buffer.alloc(1024, 3);
  const m = fake.post(GROUP, { user: ALICE, text: "doc", file: { name: "a/b.txt", bytes: small } });
  const r = await mirrored();
  const id = m.document?.file_unique_id;
  assert.equal(r.changes[0]?.body, "doc");
  assert.deepEqual(r.changes[0]?.frontmatter?.files, [`files/${id}-a_b.txt`]);
  assert.equal(r.changes[1]?.path, `${GROUP}/${m.message_id}/files/${id}-a_b.txt`);
  assert.deepEqual(r.changes[1]?.bytes, small);
  const big = fake.post(GROUP, { user: ALICE, file: { name: "big.bin", size: 25 * 1024 * 1024 } });
  const n = fake.calls.filter((c) => c.method === "getFile").length;
  const rb = await mirrored();
  assert.equal(rb.changes.length, 1);
  assert.deepEqual(rb.changes[0]?.frontmatter?.files, [
    { name: `${big.document?.file_unique_id}-big.bin`, size: 25 * 1024 * 1024 },
  ]);
  assert.equal(fake.calls.filter((c) => c.method === "getFile").length, n);
});

test("membership puts channel.md; a bot's message is bot, no wake", async () => {
  fake.join(GROUP, 502);
  const j = await mirrored();
  assert.deepEqual(j.changes, [
    { op: "put", path: `${GROUP}/channel.md`, frontmatter: { id: GROUP, name: "team", type: "supergroup" }, body: "" },
  ]);
  fake.post(GROUP, { user: 503, text: "beep" });
  const b = await mirrored();
  assert.equal(b.event.bot, true);
  assert.equal(b.wake, false);
});

test("the owner's first message creates the DM scope and dm() works after it", async () => {
  fake.post(OWNER, { user: OWNER, text: "hi bot" });
  const r = await mirrored();
  assert.deepEqual(r.event.author, { user: String(OWNER), member: true });
  assert.ok((await conn.scopes()).includes(String(OWNER)));
  await conn.dm?.(String(OWNER), "note to owner");
  const send = fake.calls.filter((c) => c.method === "sendMessage").at(-1);
  assert.deepEqual(send?.params, { chat_id: String(OWNER), text: "note to owner" });
  assert.ok(!conn.status().notes?.includes("message the bot once to open your DM"));
  assert.equal(conn.history, undefined);
});

test("reconnect: a dropped long poll is retried and later updates arrive; a 429 waits retry_after", async () => {
  const pending = mirrored();
  fake.disconnect();
  fake.rateLimit("getUpdates", 1);
  await until(() => log.errors.some((e) => e.includes("getUpdates failed")), 2000, "poll failure");
  fake.post(GROUP, { user: ALICE, text: "after reconnect" });
  assert.equal((await pending).changes[0]?.body, "after reconnect");
  const notes = conn.status().notes ?? [];
  assert.match(notes[0] ?? "", /^last update \d+$/);
  assert.match(notes[1] ?? "", /^known chats: 2$/);
});

test("the shipped transform passes its tests", async () => {
  const transforms = await import("../vault/transforms.ts");
  await transforms.load();
  const r = transforms.runTests("telegram");
  assert.equal(r.length, 3);
  for (const x of r) assert.ok(x.ok, `${x.file}: ${x.diff}`);
});
