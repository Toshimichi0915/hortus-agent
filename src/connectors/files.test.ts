import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../test/until.ts";

process.env.HORTUS_HOME = tempDir("hortus-files-");

const { Config } = await import("../config.ts");
const { openDb, readable, taintOf } = await import("../db.ts");
const { logger } = await import("../log.ts");
const paths = await import("../paths.ts");
const { commit, mirrorModule, search } = await import("../mirror/index.ts");
const { create } = await import("./files.ts");

const src = tempDir("hortus-files-src-");
mkdirSync(join(src, "a/b/c"), { recursive: true });
writeFileSync(join(src, "top.md"), "# Top\nzebra notes\n");
writeFileSync(join(src, "a/b/c/deep.md"), "deep giraffe\n");
writeFileSync(join(src, ".hidden.md"), "secret walrus\n");

const db = openDb(paths.db());
const config = Config.parse({ dofs: { notes: { type: "files", path: src } } });
await mirrorModule.start({ config, db, paths, log: logger, reload: async () => {} });

const sync = async () => {
  const conn = await create({
    name: "notes",
    config: { type: "files", path: src },
    log: logger("t"),
    fetch,
    hasRef: () => false,
  });
  for await (const b of conn.history?.(src, null) ?? []) await commit("notes", b.changes, "sync");
};

test("a files DOF copies the directory in any layout, follows deletes, and never taints", async () => {
  await sync();
  assert.ok(existsSync(join(paths.dof("notes"), "a/b/c/deep.md")));
  assert.deepEqual(
    search({ q: "giraffe" }).map((h) => h.path),
    ["a/b/c/deep.md"],
  );
  assert.equal(search({ q: "walrus" }).length, 0);
  rmSync(join(src, "top.md"));
  await sync();
  assert.ok(!existsSync(join(paths.dof("notes"), "top.md")));
  assert.equal(search({ q: "zebra" }).length, 0);

  db.prepare("INSERT INTO tasks(id, kind, title, status, scope) VALUES ('t1', 'unattended', 'w', 'running', ?)").run(
    JSON.stringify({ dofs: ["notes"] }),
  );
  assert.deepEqual(taintOf(db, "t1", config), []);
});

test("the shipped guide is a DOF every task can read, and no config can name it", async () => {
  assert.ok(search({ q: "Permission denied", in: "hortus" }).some((h) => h.path === "README.md"));
  assert.ok(readable(config, JSON.stringify({ dofs: [] })).includes("hortus"));
  assert.throws(() => Config.parse({ dofs: { hortus: { type: "files", path: src } } }));
});

test("a relative path is refused at start", async () => {
  await assert.rejects(
    create({ name: "x", config: { type: "files", path: "rel" }, log: logger("t"), fetch, hasRef: () => false }),
  );
});
