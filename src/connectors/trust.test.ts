import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "../types.ts";
import { trusted } from "./trust.ts";

const ev = (user: string | null, member = true, bot = false): Event => ({
  dof: "slack",
  key: "k",
  ts: "2026-01-01T00:00:00Z",
  payload: {},
  author: user === null ? null : { user, member },
  bot,
  summary: "",
  refs: [],
});
const owner = "U_OWNER";

test("trust matrix", () => {
  assert.equal(trusted(ev(owner), { owner }), true);
  assert.equal(trusted(ev("U_MEM"), { owner }), false, "member under the default owner");
  assert.equal(trusted(ev("U_MEM"), { owner, trust: "owner" }), false);
  assert.equal(trusted(ev("U_MEM"), { owner, trust: "members" }), true);
  assert.equal(trusted(ev("U_GUEST", false), { owner, trust: "members" }), false, "guest under members");
  assert.equal(trusted(ev("U_ANY", false), { owner, trust: "anyone" }), true);
  assert.equal(trusted(ev("U_BOT", true, true), { owner, trust: "anyone" }), false, "anyone still refuses bots");
  assert.equal(trusted(ev(owner, true, true), { owner }), false, "a bot is never trusted");
  assert.equal(trusted(ev("U_A"), { owner, trust: ["U_A"] }), true);
  assert.equal(trusted(ev("U_B"), { owner, trust: ["U_A"] }), false, "a list refuses ids not in it");
  assert.equal(trusted(ev(null), { owner, trust: "anyone" }), false, "no author");
});
