import assert from "node:assert/strict";
import { test } from "node:test";
import { summaryView } from "./approvals.ts";
import { transformForm } from "./transform-entry.ts";

const s = {
  name: "notion",
  new: true,
  manifest: "{}",
  credentials: { notion: { type: "token", hosts: ["api.notion.com"], locations: ["header:Authorization"] } },
  missing: [{ name: "notion", type: "token" }],
  configured: ["slack"],
  tests: 1,
};

test("transforms entry: one header line, configured names, password fields posting credentials.<name>.<field>", () => {
  const view = summaryView("request", "transforms", s).html;
  assert.match(
    view,
    /transform <code>notion<\/code> \(new\): put <code>notion<\/code> into <code>header:Authorization<\/code> on <code>api\.notion\.com<\/code>/,
  );
  assert.match(view, /<code>slack<\/code>: configured/);
  const form = transformForm(7, s).html;
  assert.match(form, /data-call="approval\.decide"/);
  assert.match(
    form,
    /<input type="password" name="credentials\.notion\.value"[^>]*placeholder="leave empty to add later">/,
  );
  assert.ok(!form.includes("credentials.slack"));
});
