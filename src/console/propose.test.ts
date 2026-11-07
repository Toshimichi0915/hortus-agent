/** settings.propose → a `settings` entry; approval.decide applies it unless the settings moved; Settings' save approves it as edited. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { load } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { call } from "../rpc.ts";
import { tempDir } from "../test/until.ts";
import type { InboxMsg } from "../types.ts";
import { gate } from "../vault/index.ts";
import { bind } from "../vault/vault.ts";
import { consoleModule } from "./index.ts";

process.env.HORTUS_HOME = tempDir("hortus-propose-");
process.env.HORTUS_CONSOLE_PORT = "0";
const ctx: Ctx = {
  config: load(),
  db: openDb(paths.db()),
  paths,
  log: logger,
  async reload() {
    ctx.config = load();
  },
};
const owner = { role: "owner" as const };
const worker = { role: "worker" as const, task: "t1" };
const inbox: Omit<InboxMsg, "seq" | "ts">[] = [];

before(async () => {
  bind(ctx);
  gate.deps.inboxWrite = (_task, msg) => inbox.push(msg);
  await consoleModule.start(ctx);
});
after(() => consoleModule.stop());

interface Row {
  status: string;
  reason: string | null;
  summary: { diff: string; widens: string[]; paths: string[] };
}
const row = (id: number) => call("approval.get", { id }, owner) as Promise<Row>;
const propose = (patch: unknown) =>
  call("settings.propose", { patch, reason: "the owner asked" }, worker) as Promise<{ approval: number }>;
const onDisk = () => JSON.parse(readFileSync(paths.config(), "utf8"));

test("an invalid patch is refused at once, naming the key; a worker cannot save settings itself", async () => {
  await assert.rejects(propose({ vm: { cpus: "x" } }), /vm\.cpus/);
  await assert.rejects(propose({ vm: { cpus: ctx.config.vm.cpus } }), /changes nothing/);
  await assert.rejects(call("settings.set", { config: ctx.config }, worker), /forbidden|not allowed|role/i);
});

test("a directory it adds must exist, be absolute and lie outside hortus's state", async () => {
  const project = (path: string) => propose({ projects: { p: { path } } });
  await assert.rejects(project("~/x"), /projects\.p\.path: ~\/x is not an absolute path/);
  await assert.rejects(project("/nonexistent/hortus-x"), /not an existing directory: you cannot create it/);
  const work = join(paths.home(), "tasks", "t1", "out", "work", "repo");
  mkdirSync(work, { recursive: true });
  await assert.rejects(project(work), /inside hortus's own state/);
  await assert.rejects(propose({ worker: { plugins: [work] } }), /worker\.plugins: .* inside hortus's own state/);
  const outside = tempDir("hortus-propose-project-");
  assert.equal(typeof (await project(outside)).approval, "number");
});

test("approve applies the proposal; the diff and the warning say what it changes", async () => {
  const { approval } = await propose({ vm: { cpus: 8 }, policy: { "*": "auto" } });
  const r = await row(approval);
  assert.equal(r.status, "pending");
  assert.deepEqual(r.summary.paths.sort(), ["policy.*", "vm.cpus"]);
  assert.deepEqual(r.summary.widens, ["policy.*"]);
  assert.match(r.summary.diff, /^\+ {4}"cpus": 8,?$/m);
  await call("approval.decide", { id: approval, decision: "approve" }, owner);
  assert.equal(onDisk().vm.cpus, 8);
  assert.equal(ctx.config.policy["*"], "auto");
  assert.equal((await row(approval)).status, "approved");
  assert.match(inbox.at(-1)?.text ?? "", /approved \(settings\)/);
  assert.match(inbox.at(-1)?.text ?? "", /applied, do not propose it again/);
});

test("settings changed since: approve refuses; saving it from Settings approves it as edited", async () => {
  const { approval } = await propose({ vm: { cpus: 6 } });
  await call("settings.set", { config: { ...ctx.config, owner: { tz: "UTC" } } }, owner);
  await assert.rejects(call("approval.decide", { id: approval, decision: "approve" }, owner), /changed since/);
  assert.equal((await row(approval)).status, "pending");
  await call("settings.set", { config: { ...ctx.config, vm: { ...ctx.config.vm, cpus: 4 } }, approval }, owner);
  assert.equal(onDisk().vm.cpus, 4);
  assert.equal(onDisk().owner.tz, "UTC");
  const r = await row(approval);
  assert.equal(r.status, "approved");
  assert.equal(r.reason, "applied with the owner's edits");
});
