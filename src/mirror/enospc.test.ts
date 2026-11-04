/**
 * ENOSPC on a mirror commit: the commit rejects, the daemon process lives on, nothing half-written is committed, and
 * the next commit after space is freed lands. HORTUS_HOME sits on a 4 MB tmpfs in an unprivileged user + mount
 * namespace (`unshare -rm`); the test re-runs this file inside it. Skipped where unprivileged namespaces are off.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "../test/until.ts";

const inner = process.env.HORTUS_ENOSPC_INNER;
const canUnshare = spawnSync("unshare", ["-rm", "true"]).status === 0;

if (inner) {
  process.env.HORTUS_HOME = inner;
  const { openDb } = await import("../db.ts");
  const paths = await import("../paths.ts");
  const repo = await import("./repo.ts");
  const db = openDb(paths.db());
  const small = (path: string, body: string) => [{ op: "put" as const, path, frontmatter: {}, body }];

  test("inner: ENOSPC rejects the commit, leaves no temp file, and the next commit lands", async () => {
    assert.ok(await repo.commit(db, "s", small("c/channel.md", "a"), "a"));
    const filler = join(inner, "filler");
    try {
      execFileSync("dd", ["if=/dev/zero", `of=${filler}`, "bs=64k", "count=1000"], { stdio: "ignore" });
    } catch {} // stops at a full disk
    await assert.rejects(repo.commit(db, "s", small("c/t/big.md", "x".repeat(2 << 20)), "big"), /ENOSPC/);
    const tree = paths.dof("s");
    assert.deepEqual(
      readdirSync(tree, { recursive: true }).filter((f) => String(f).includes(".tmp-")),
      [],
      "a half-written temp file would be committed by the next sync",
    );
    rmSync(filler);
    const r = await repo.commit(db, "s", small("c/t/b.md", "b"), "b");
    assert.ok(r);
    assert.deepEqual(
      r.diff.map((d) => d.path),
      ["c/t/b.md"],
    );
    execFileSync("git", ["-C", tree, "fsck", "--no-progress"], { stdio: "ignore" });
  });
} else {
  test("ENOSPC on a mirror commit (4 MB tmpfs, unshare -rm)", {
    skip: !canUnshare && "no unprivileged namespaces",
  }, () => {
    const home = join(tempDir("hortus-enospc-"), "home");
    mkdirSync(home);
    writeFileSync(join(home, ".keep"), "");
    const file = fileURLToPath(import.meta.url);
    const r = spawnSync(
      "unshare",
      ["-rm", "sh", "-c", 'mount -t tmpfs -o size=4m none "$H" && exec "$N" --no-warnings --test "$F"'],
      {
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          H: home,
          N: process.execPath,
          F: file,
          HORTUS_ENOSPC_INNER: home,
        },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^# pass 1$/m, r.stdout);
  });
}
