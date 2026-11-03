import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { install } from "./install.ts";

test("install writes the unit with sudo tee, refuses a different one without --force", () => {
  const unitPath = join(mkdtempSync(join(tmpdir(), "hortus-install-")), "hortusd.service");
  const calls: string[] = [];
  const out: string[] = [];
  const opts = {
    unitPath,
    user: "alice",
    home: "/home/alice",
    node: "/usr/bin/node",
    dist: "/opt/hortus/dist",
    print: (l: string) => out.push(l),
    run: (cmd: string, args: string[], input?: string) => {
      calls.push([cmd, ...args].join(" "));
      if (args[0] === "tee" && args[1] && input !== undefined) writeFileSync(args[1], input);
    },
  };
  assert.equal(install(opts), true);
  assert.deepEqual(calls, [`sudo tee ${unitPath}`, "sudo systemctl daemon-reload"]);
  const text = readFileSync(unitPath, "utf8");
  for (const line of [
    "User=alice",
    "Environment=HOME=/home/alice",
    "ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning /opt/hortus/dist/bin/hortusd.js",
    "AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE",
    "CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE",
    "SupplementaryGroups=kvm",
    "Delegate=yes",
    "KillMode=mixed",
    "Restart=on-failure",
  ]) {
    assert.ok(text.split("\n").includes(line), line);
  }
  assert.match(out.join("\n"), /systemctl enable hortusd[\s\S]*systemctl start hortusd/);

  assert.equal(install(opts), false, "same unit: nothing to do");
  assert.throws(() => install({ ...opts, user: "bob" }), /--force/);
  assert.equal(install({ ...opts, user: "bob", force: true, ca: true }), true);
  assert.match(readFileSync(unitPath, "utf8"), /User=bob/);
});
