/**
 * The gateway assertions of 02 (insert → commit → wake, dedupe, trust, bot guard, reconnect, membership) against the
 * Discord and Telegram fakes, through the real connectors. One adapter per messenger; nothing here names a service
 * outside its adapter.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Config } from "../config.ts";
import { create as discord } from "../connectors/discord.ts";
import { create as telegram, timing as tgTiming } from "../connectors/telegram.ts";
import { openDb } from "../db.ts";
import { directSocket, FakeDiscord } from "../test/fakes/discord.ts";
import { directPathFetch, FakeTelegram } from "../test/fakes/telegram.ts";
import { memLog, until } from "../test/until.ts";
import type { Change, ConnectorFactory } from "../types.ts";
import { directFetch } from "../test/direct.ts";
import { createGateway } from "./gateway.ts";

const home = mkdtempSync(join(tmpdir(), "hortus-messengers-"));
process.env.HORTUS_HOME = home;
const db = openDb(join(home, "db.sqlite"));
tgTiming.pollS = 1;

interface Adapter {
  dof: string;
  config: Record<string, unknown>;
  factory: ConnectorFactory;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  vault: Record<string, unknown>;
  /** a message by `who`; returns the mirror path it lands at */
  post(who: "owner" | "stranger" | "bot", text: string): string;
  replay(): void;
  disconnect(): void;
  /** a new channel/chat the bot is in; returns its scope id */
  join(): string;
  close(): Promise<void>;
}

const dc = await FakeDiscord.start();
dc.user("200", "owner");
dc.user("202", "stranger", { member: false });
dc.user("203", "otherbot", { bot: true });
dc.channel("300", { name: "general" });
const tg = await FakeTelegram.start();
tg.user(500, "owner");
tg.user(502, "stranger");
tg.user(503, "otherbot", { is_bot: true });
tg.chat(-100, { title: "team", members: { 500: "creator" } });

const discordAdapter: Adapter = {
  dof: "dc",
  config: { type: "discord", owner: "200", api: dc.api },
  factory: (d) => discord({ ...d, ws: directSocket(["dc"]) } as Parameters<typeof discord>[0]),
  fetch: directFetch(["dc"]),
  vault: dc.vault("dc"),
  post(who, text) {
    const m = dc.post("300", { user: { owner: "200", stranger: "202", bot: "203" }[who], text });
    return `300/${m.id}/${m.id}.md`;
  },
  replay: () => dc.replay(),
  disconnect: () => dc.disconnect(),
  join() {
    const c = dc.channel("301", { name: "new", quiet: false });
    dc.post("301", { user: "200", text: "old news", quiet: true });
    return c.id;
  },
  close: () => dc.close(),
};

const telegramAdapter: Adapter = {
  dof: "tg",
  config: { type: "telegram", owner: "500", api: tg.api },
  factory: telegram,
  fetch: directPathFetch(["tg"]),
  vault: tg.vault("tg"),
  post(who, text) {
    const m = tg.post(-100, { user: { owner: 500, stranger: 502, bot: 503 }[who], text });
    return `-100/${m.message_id}/${m.message_id}.md`;
  },
  replay: () => tg.replay(),
  disconnect: () => tg.disconnect(),
  join() {
    tg.join(-200, tg.bot.id);
    return "-200";
  },
  close: () => tg.close(),
};

const adapters = [discordAdapter, telegramAdapter];
writeFileSync(join(home, "vault.json"), JSON.stringify(Object.assign({}, ...adapters.map((a) => a.vault))));

const rows = (dof: string) =>
  db.prepare("SELECT key, author, member, trusted, bot FROM events WHERE dof = ? ORDER BY id").all(dof) as {
    key: string;
    author: string | null;
    member: number | null;
    trusted: number;
    bot: number;
  }[];

for (const a of adapters) {
  const commits: { changes: Change[]; message: string }[] = [];
  let wakes = 0;
  const cfg = Config.parse({ dofs: { [a.dof]: a.config } });
  const gw = createGateway({
    db,
    config: () => cfg,
    log: memLog(),
    connectors: { [String(a.config.type)]: a.factory },
    fetch: () => a.fetch,
    commit: async (_dof, changes, message) => {
      commits.push({ changes, message });
      return {};
    },
    wake: () => {
      wakes++;
    },
    hasRef: () => false,
  });
  const committed = (path: string) => commits.find((c) => c.changes.some((x) => x.path === path));
  after(async () => {
    await gw.stop();
    await a.close();
  });

  test(`${a.dof}: an owner's message is inserted trusted, committed, and wakes the Planner`, async () => {
    gw.start();
    await until(() => gw.list()[0]?.connected, 3000, "connected");
    const path = a.post("owner", "please do x");
    const c = await until(() => committed(path), 3000, "commit");
    assert.match(c.message, new RegExp(`^sync\\(${a.dof}\\): .*please do x$`));
    assert.deepEqual(
      { ...rows(a.dof).at(-1), key: undefined },
      {
        key: undefined,
        author: { dc: "200", tg: "500" }[a.dof],
        member: 1,
        trusted: 1,
        bot: 0,
      },
    );
    assert.equal(wakes, 1);
  });

  test(`${a.dof}: dedupe — a replayed event inserts no row and commits nothing`, async () => {
    const n = rows(a.dof).length;
    const c = commits.length;
    a.replay();
    await sleep(300);
    assert.equal(rows(a.dof).length, n);
    assert.equal(commits.length, c);
  });

  test(`${a.dof}: a stranger is untrusted; a bot is mirrored, untrusted, and does not wake`, async () => {
    const w = wakes;
    const p1 = a.post("stranger", "hello");
    await until(() => committed(p1));
    assert.deepEqual(
      { trusted: rows(a.dof).at(-1)?.trusted, member: rows(a.dof).at(-1)?.member },
      { trusted: 0, member: 0 },
    );
    const p2 = a.post("bot", "beep");
    await until(() => committed(p2));
    assert.deepEqual({ trusted: rows(a.dof).at(-1)?.trusted, bot: rows(a.dof).at(-1)?.bot }, { trusted: 0, bot: 1 });
    await sleep(50);
    assert.equal(wakes, w + 1); // the stranger's message wakes (the Planner ignores untrusted), the bot's does not
  });

  test(`${a.dof}: reconnect — a dropped connection comes back and later events arrive`, async () => {
    a.disconnect();
    await sleep(100);
    const path = a.post("owner", "after reconnect");
    await until(() => committed(path), 5000, "commit after reconnect");
  });

  test(`${a.dof}: membership — a new channel/chat is mirrored and joins the scopes`, async () => {
    const scope = a.join();
    await until(() => committed(`${scope}/channel.md`), 3000, "channel.md");
    await gw.reconcile(a.dof);
    if (a.dof === "dc") {
      assert.ok(
        commits.some((c) =>
          c.changes.some(
            (x) => x.path.startsWith(`${scope}/`) && x.path.endsWith(".md") && !x.path.endsWith("channel.md"),
          ),
        ),
      );
      assert.ok(db.prepare("SELECT 1 FROM syncs WHERE dof = ? AND scope = ?").get(a.dof, scope));
    } else {
      // no history: nothing to reconcile, the chat is a scope from the update alone
      assert.ok(gw.list()[0]?.notes?.includes("known chats: 2"));
    }
  });
}

test("tg: the ack is the next offset — sent only after the insert", async () => {
  const before = rows("tg").length;
  const path = telegramAdapter.post("owner", "offset check");
  const id = tg.sent.at(-1)?.update_id ?? 0;
  await until(() => tg.calls.some((c) => c.method === "getUpdates" && c.params.offset === id + 1), 3000, "offset");
  assert.ok(rows("tg").length > before);
  assert.ok(rows("tg").some((r) => r.key === String(id)));
  assert.ok(path);
});
