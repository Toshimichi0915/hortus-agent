/** The dispatcher's VM routing without an image: a task without a project is a VM task; `vm.fallback_host: false`
 * keeps it queued with the image error on the card (the fallback-to-host path needs Landlock and a provider). */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Config } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { until } from "../test/until.ts";
import { dispatcherModule } from "./dispatcher.ts";
import * as tasks from "./tasks.ts";

process.env.HORTUS_HOME = mkdtempSync(join(tmpdir(), "hortus-dispatch-"));
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
