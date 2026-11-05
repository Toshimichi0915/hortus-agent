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

test("transforms entry: a github-app's private key is a textarea, or the PEM loses its newlines", () => {
  const form = transformForm(7, { ...s, missing: [{ name: "gh", type: "github-app" }] }).html;
  assert.match(form, /<textarea name="credentials\.gh\.privateKey"/);
  assert.match(form, /<input type="number" name="credentials\.gh\.appId"/);
});

test("transforms entry: a changed transform.js says so even when the manifest is the same", () => {
  const view = summaryView("request", "transforms", { ...s, new: false, manifestDiff: " {}\n", codeChanged: 3 }).html;
  assert.match(view, /\(changed\)/);
  assert.match(view, /<code>transform\.js<\/code> changed \(3 lines\)/);
  assert.ok(!summaryView("request", "transforms", s).html.includes("transform.js</code> changed"));
});
