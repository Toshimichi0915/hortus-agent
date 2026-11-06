/** The page's one stream (live.ts) against a stand-in EventSource. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { liveStream } from "./live.ts";

class Fake {
  readyState = 1;
  closed = false;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (e: { lastEventId: string; data: string }) => void;
  named = new Map<string, () => void>();
  constructor(readonly url: string) {}
  addEventListener(t: string, f: () => void) {
    this.named.set(t, f);
  }
  close() {
    this.closed = true;
  }
}

function setup() {
  const bus = new EventTarget();
  const opened: Fake[] = [];
  const downs: boolean[] = [];
  const open = (url: string) => {
    const f = new Fake(url);
    opened.push(f);
    return f as unknown as EventSource;
  };
  const watch = liveStream(bus, open, (d) => downs.push(d), 5);
  const fired: string[] = [];
  const on = (t: string) => bus.addEventListener(t, () => fired.push(t));
  const rows: { seq: number; body: unknown }[] = [];
  const onRow = (t: string) =>
    bus.addEventListener(t, (e) => rows.push((e as CustomEvent<{ seq: number; body: unknown }>).detail));
  return { opened, downs, watch, fired, on, rows, onRow };
}

const message = (seq: number, body: unknown = { type: "text", text: "w" }) => ({
  lastEventId: String(seq),
  data: JSON.stringify({ seq, html: "<div>old console</div>", body, created: "t" }),
});

const settle = () => new Promise<void>(queueMicrotask);

test("everything held in one tick shares one stream, and a chat puts itself in its URL", async () => {
  const { opened, watch } = setup();
  watch(["tasks"]);
  watch(["approvals", "tasks"]);
  watch(["chat:a/b"]);
  await settle();
  assert.deepEqual(
    opened.map((o) => o.url),
    ["/events/tasks,approvals,settings,chat?task=a%2Fb"],
  );
});

test("the stream follows the chat, and closes with its last holder", async () => {
  const { opened, watch } = setup();
  const shell = watch(["tasks"]);
  const a = watch(["chat:a"]);
  await settle();
  a();
  const b = watch(["chat:b"]);
  await settle();
  b();
  await settle();
  assert.deepEqual(
    opened.map((o) => o.url),
    [
      "/events/tasks,approvals,settings,chat?task=a",
      "/events/tasks,approvals,settings,chat?task=b",
      "/events/tasks,approvals,settings",
    ],
  );
  assert.deepEqual(
    opened.map((o) => o.closed),
    [true, true, false],
  );
  shell();
  await settle();
  assert.equal(opened[2]?.closed, true);
});

test("events fire their topics; a gap shows, then every held topic but the chat fires once", async () => {
  const { opened, downs, watch, fired, on, rows, onRow } = setup();
  for (const t of ["tasks", "approvals", "chat:a"]) on(t);
  watch(["tasks", "approvals", "chat:a"]);
  await settle();
  const s = opened[0] as Fake;
  s.onopen?.();
  assert.deepEqual(fired, []);
  s.named.get("approvals")?.();
  onRow("chat:a");
  s.onmessage?.(message(7));
  assert.deepEqual(fired, ["approvals", "chat:a"]);
  assert.deepEqual(rows, [{ seq: 7, body: { type: "text", text: "w" }, created: "t" }]);
  on("settings");
  s.named.get("settings")?.();
  assert.equal(fired.at(-1), "settings");
  fired.length = 0;
  s.readyState = 0; // the browser retries this one itself
  s.onerror?.();
  s.onopen?.();
  assert.deepEqual(downs, [false, true, false]);
  assert.deepEqual(fired.sort(), ["approvals", "tasks"]);
  assert.equal(opened.length, 1);
});

test("a stream the browser gave up on is reopened from the last seq", async () => {
  const { opened, downs, watch } = setup();
  watch(["chat:a"]);
  await settle();
  const s = opened[0] as Fake;
  s.onmessage?.(message(41));
  s.readyState = 2;
  s.onerror?.();
  await sleep(30);
  assert.equal(s.closed, true);
  assert.equal(opened[1]?.url, "/events/tasks,approvals,settings,chat?task=a&after=41");
  opened[1]?.onopen?.();
  assert.equal(downs.at(-1), false);
});

test("rows go to their chat, and a chat opened again starts over", async () => {
  const { opened, watch, rows, onRow } = setup();
  onRow("chat:a");
  const a = watch(["chat:a"]);
  await settle();
  opened[0]?.onmessage?.(message(5));
  a();
  const b = watch(["chat:b"]);
  await settle();
  opened[1]?.onmessage?.(message(9));
  assert.equal(opened[1]?.url.includes("after"), false); // b's rows do not start at a's cursor
  opened[0]?.onmessage?.(message(6)); // one a closed stream had in hand still goes to a, never to b
  assert.deepEqual(
    rows.map((r) => r.seq),
    [5, 6],
  );
  b();
  watch(["chat:a"]);
  await settle();
  assert.equal(opened[2]?.url, "/events/tasks,approvals,settings,chat?task=a");
});

test("the page that follows a chat's page in one tick (chat to task page) gets the rows again", async () => {
  const { opened, watch } = setup();
  const a = watch(["chat:a"]);
  await settle();
  opened[0]?.onmessage?.(message(5));
  a();
  watch(["chat:a"]);
  await settle();
  assert.equal(opened[0]?.closed, true);
  assert.equal(opened[1]?.url, "/events/tasks,approvals,settings,chat?task=a");
});

test("a retry waiting when the last holder leaves never fires", async () => {
  const { opened, watch } = setup();
  const off = watch(["tasks"]);
  await settle();
  (opened[0] as Fake).readyState = 2;
  opened[0]?.onerror?.();
  off();
  await sleep(30);
  assert.equal(opened.length, 1);
});
