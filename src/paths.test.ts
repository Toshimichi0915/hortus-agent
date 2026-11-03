import assert from "node:assert/strict";
import { test } from "node:test";
import * as paths from "./paths.ts";

test("HORTUS_HOME with a trailing slash is the same home and socket", () => {
  process.env.HORTUS_HOME = "/tmp/hortus-paths-x";
  const a = { home: paths.home(), socket: paths.socket(), cfg: paths.config() };
  process.env.HORTUS_HOME = "/tmp/hortus-paths-x/";
  assert.deepEqual({ home: paths.home(), socket: paths.socket(), cfg: paths.config() }, a);
  assert.equal(a.cfg, "/tmp/hortus-paths-x/hortusd.json");
  assert.match(a.socket, /^\0hortus-[0-9a-f]{12}$/);
  process.env.HORTUS_HOME = "/tmp/hortus-paths-y";
  assert.notEqual(paths.socket(), a.socket);
  delete process.env.HORTUS_HOME;
  assert.equal(paths.socket(), `\0hortus-${process.getuid?.()}`);
});
