import assert from "node:assert/strict";
import { test } from "node:test";
import { loginHref, safeNext } from "./next.ts";

test("safeNext: a path of this origin goes on; another host, a scheme or the sign-in pages go to /", () => {
  for (const ok of [
    "/approvals/7",
    "/tasks/abc",
    "/approvals/7/login",
    "/search?q=a%20b&x=1",
    "/dof/s/C1/a%23b.md",
    "/",
  ])
    assert.equal(safeNext(ok), ok, ok);
  for (const bad of [
    undefined,
    null,
    7,
    "",
    "tasks",
    "//evil.test",
    "//evil.test/tasks",
    "/\\evil.test",
    "\\\\evil.test",
    "/x//y",
    "/\t/evil.test",
    "/\n/evil.test",
    "/ /evil.test",
    "/é",
    "https://evil.test/",
    "javascript:alert(1)",
    " /tasks",
    "/login",
    "/login?next=/tasks",
    "/enroll?code=x",
    "/x/../login",
    `/${"a".repeat(2048)}`,
  ])
    assert.equal(safeNext(bad), "/", JSON.stringify(bad));
});

test("loginHref: the next path encoded, or bare /login", () => {
  assert.equal(loginHref("/approvals/7?x=1&y=2"), "/login?next=%2Fapprovals%2F7%3Fx%3D1%26y%3D2");
  assert.equal(loginHref("/"), "/login");
  assert.equal(loginHref("//evil.test"), "/login");
  assert.equal(safeNext(new URLSearchParams(loginHref("/tasks/a?b=c").split("?")[1]).get("next")), "/tasks/a?b=c");
});
