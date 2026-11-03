/** The dispatcher's VM routing without an image: a task without a project is a VM task; `vm.fallback_host: false`
 * keeps it queued with the image error on the card (the fallback-to-host path needs Landlock and a provider). */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Config } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { tempDir, until } from "../test/until.ts";
import { dispatcherModule, readOutbox } from "./dispatcher.ts";
import * as tasks from "./tasks.ts";

process.env.HORTUS_HOME = tempDir("hortus-dispatch-");
process.env.HORTUS_NO_NET = "1";

test("a VM task with the image missing and vm.fallback_host false stays queued with the reason", async () => {
  const ctx: Ctx = {
    config: Config.parse({ vm: { fallback_host: false }, worker: { provider: "fake", model: "m" } }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  await dispatcherModule.start(ctx);
  try {
    const t = tasks.create({ kind: "unattended", title: "t", brief: "b", scope: { credentials: [] } });
    assert.equal(tasks.get(t.id).runtime, "vm");
    const row = await until(() => tasks.get(t.id).error, 3000, "error on the card");
    assert.match(row, /agent\.ext4 missing: run `hortus image build`/);
    assert.equal(tasks.get(t.id).status, "queued");
  } finally {
    await dispatcherModule.stop();
  }
});

test("readOutbox: new seqs only, never through a linked outbox (another task's results)", () => {
  const box = (id: string) => join(paths.out(id), "outbox");
  const msg = (seq: number) => JSON.stringify({ seq, type: "reply", text: `m${seq}`, ts: "t" });
  mkdirSync(box("a"), { recursive: true });
  for (const s of [1, 2, 3]) writeFileSync(join(box("a"), `00000${s}.json`), msg(s));
  writeFileSync(join(box("a"), "000004.json"), msg(5));
  assert.deepEqual(
    readOutbox("a", 1).map((m) => m.text),
    ["m2", "m3"],
    "a seq that is not its name is dropped",
  );
  mkdirSync(paths.out("b"), { recursive: true });
  symlinkSync(box("a"), box("b"));
  assert.deepEqual(readOutbox("b", 0), []);
});

test("inbox seq: a file left by a crash before its row is never reused", () => {
  const ctx: Ctx = {
    config: Config.parse({ worker: { provider: "fake", model: "m" } }),
    db: openDb(paths.db()),
    paths,
    log: logger,
    reload: async () => {},
  };
  tasks.bind(ctx);
  const t = tasks.create({ kind: "unattended", title: "t", brief: "b", scope: { credentials: [] } });
  writeFileSync(join(paths.ctl(t.id), "inbox", "000001.json"), "{}"); // renamed, then the daemon died
  assert.equal(tasks.inboxWrite(t.id, { from: "owner", trusted: true, text: "x" }), 2);
});
