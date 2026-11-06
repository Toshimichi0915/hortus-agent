/**
 * A pretend hortusd: seed data and one handler per RPC, so every page can be designed and clicked through without the
 * daemon. Chats get a scripted Worker that thinks, runs tools, streams Markdown and waits on approvals.
 * `pnpm web` runs on it (`VITE_MOCK=1`); CONNECT.md's step 9 deletes it.
 */
import {
  ApiError,
  type Approval,
  type Captured,
  type Config,
  type Credential,
  type Line,
  type LoginEvent,
  type Msg,
  type Passkey,
  type RemoteSession,
  type Row,
  type Schedule,
  type SearchHit,
  type Source,
  type Task,
  type TaskDetail,
  bus,
} from "./api.ts";
import { KNOWN_KEYS, validateConfig } from "./schema.ts";

const emit = (...topics: string[]) => {
  for (const t of topics) bus.dispatchEvent(new Event(t));
};

const NOW = Date.now();
const MIN = 60_000;
const HR = 60 * MIN;
const DAY = 24 * HR;
const at = (ms: number) => new Date(NOW + ms).toISOString();
const now = () => new Date().toISOString();
/** hortusd's ids: base-36 milliseconds, then 8 hex */
const tid = (ago: number, hex: string) => (NOW - ago).toString(36) + hex;

// ---------------------------------------------------------------------------------------------------------------------
// Seed

let config: Config = {
  owner: { tz: "Asia/Tokyo", notify: "slack" },
  dofs: {
    slack: { type: "slack", owner: "U0123ABCD" },
    github: { type: "github", owner: "you", repos: ["you/hortus-agent", "you/website"] },
    discord: { type: "discord", owner: "402938475610293847", trust: "members" },
    telegram: { type: "telegram", owner: "51234987" },
  },
  planner: {
    provider: "ollama-cloud",
    model: "deepseek-v4.1-flash:1017",
    effort: "low",
    batch_max: 50,
    daily_tokens: 5e6,
  },
  worker: {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    budget: { tokens: 2e6, hours: 4 },
    credentials: [],
    context_window: 131072,
    plugins: [],
  },
  origins: "*",
  vm: { cpus: 2, mem_mb: 4096, max_concurrent: 4, boot_timeout_s: 120, fallback_host: true },
  chat: { allow: [] },
  proxy: { https: 8443, http: 8080, dns: 8053 },
  console: { listen: "0.0.0.0:7443", host: "hortus.home.arpa" },
  projects: {
    "hortus-agent": { path: "/home/you/projects/hortus-agent", main: "main", runtime: "host" },
    website: { path: "/home/you/projects/website", main: "main", runtime: "vm", origins: ["registry.npmjs.org"] },
    notes: { path: "/home/you/notes", main: "main", runtime: "host", exclude: ["*.pdf", "drafts/**"] },
  },
  // zod's catchall type cannot hold `read` next to the modes; the parsed config does
  policy: {
    "*": "human",
    "credential:github": "auto",
    "credential:aws": "auto",
    read: ["/home/you/tools"],
  } as unknown as Config["policy"],
  judge_notes: {
    "*": "Reading issues and pull requests in my own repositories is routine. Posting anywhere public is not.",
  },
};

const T = {
  flaky: tid(50 * MIN, "7f3a9c21"),
  release: tid(5 * HR, "1c8e44b0"),
  linear: tid(80 * MIN, "2e9b5c71"),
  mika: tid(25 * MIN, "93d0e5aa"),
  review: tid(2 * HR, "4be2f017"),
  digest: tid(30 * HR, "d4410c6e"),
  digestRun: tid(14 * HR, "e5a0b2c9"),
  ci: tid(9 * HR, "0aa3f9d2"),
  notes: tid(3 * DAY, "5d2c7e18"),
  triage: tid(2 * DAY, "c19f6a3b"),
  deps: tid(4 * MIN, "b7e1d0f4"),
};

const task = (t: Partial<Task> & Pick<Task, "id" | "kind" | "title" | "status">): Task => ({
  project: null,
  budget: { tokens: 2e6, hours: 4 },
  usage: { tokens: 0 },
  metered: 0,
  hours: 0,
  summary: null,
  outcome: null,
  created: now(),
  updated: now(),
  closed: null,
  cwd: null,
  error: null,
  runtime: "host",
  started: null,
  brief: null,
  scope: { credentials: [], repos: [] },
  ...t,
});

const tasks: Task[] = [
  task({
    id: T.flaky,
    kind: "chat",
    title: "The schedules test fails about 1 in 10 runs on CI. Can you find out why and fix it?",
    status: "waiting",
    project: "hortus-agent",
    cwd: "/home/you/projects/hortus-agent",
    usage: { tokens: 184_000 },
    metered: 212_400,
    hours: 0.4,
    created: at(-50 * MIN),
    updated: at(-6 * MIN),
    summary: "Fixed the flaky `every` schedule test; the merge into `main` waits for the owner.",
  }),
  task({
    id: T.linear,
    kind: "chat",
    title: "Connect to Linear and list my open issues",
    status: "waiting",
    usage: { tokens: 61_000 },
    metered: 64_200,
    hours: 0.1,
    created: at(-80 * MIN),
    updated: at(-71 * MIN),
  }),
  task({
    id: T.release,
    kind: "chat",
    title: "Draft the release notes for v0.2",
    status: "waiting",
    project: "hortus-agent",
    cwd: "/home/you/projects/hortus-agent",
    usage: { tokens: 96_500 },
    metered: 96_500,
    hours: 0.2,
    created: at(-5 * HR),
    updated: at(-4.6 * HR),
  }),
  task({
    id: T.mika,
    kind: "unattended",
    title: "Answer Mika in #dev about the moved deploy window",
    status: "waiting",
    usage: { tokens: 22_000 },
    metered: 24_800,
    hours: 0.05,
    created: at(-25 * MIN),
    updated: at(-21 * MIN),
    brief:
      "Mika (not a workspace owner) asked in #dev to pass on that tomorrow's deploy window moved to 15:00 JST. Acknowledge in the thread and tell the owner.",
    summary: "Drafted a reply in the #dev thread; posting it waits for the owner's approval.",
    scope: { credentials: ["slack"], repos: [], dofs: ["slack"] },
  }),
  task({
    id: T.review,
    kind: "unattended",
    title: "Review PR #142: Add Bitbucket webhooks",
    status: "running",
    project: "hortus-agent",
    runtime: "vm",
    started: at(-38 * MIN),
    usage: { tokens: 310_000 },
    metered: 455_000,
    hours: 0.9,
    created: at(-2 * HR),
    updated: at(-1 * MIN),
    brief: "A review was requested on you/hortus-agent#142. Read the diff and CI, then leave a review.",
    summary:
      "Reading the diff of #142 (6 files).\n\n- The webhook handler verifies the HMAC **after** parsing the body: worth a comment.\n- CI's build log sits behind a login on ci.example.com; asked to sign in.",
    scope: { credentials: ["github"], repos: ["github:you/hortus-agent"], dofs: ["github"] },
  }),
  task({
    id: T.digest,
    kind: "unattended",
    title: "Morning digest",
    status: "waiting",
    usage: { tokens: 41_000, runs: 388_000 },
    metered: 41_000,
    hours: 0.1,
    created: at(-30 * HR),
    updated: at(-14 * HR),
    summary: "Set a weekday 09:00 schedule that posts a digest of GitHub activity and unanswered Slack threads.",
  }),
  task({
    id: T.digestRun,
    kind: "run",
    title: "Morning digest · run",
    status: "done",
    outcome: "done",
    usage: { tokens: 97_000 },
    hours: 0.05,
    created: at(-14 * HR),
    updated: at(-13.9 * HR),
    closed: at(-13.9 * HR),
    summary: "Posted the digest: 3 PRs merged, 2 issues opened, 1 unanswered thread in #dev.",
  }),
  task({
    id: T.ci,
    kind: "unattended",
    title: "Investigate the CI failure on main",
    status: "waiting",
    project: "website",
    runtime: "vm",
    usage: { tokens: 2_000_000 },
    metered: 2_031_000,
    hours: 2.6,
    created: at(-9 * HR),
    updated: at(-2 * HR),
    error: "budget_exceeded: budget exceeded (2.0M of 2.0M tokens)",
    summary:
      "`e2e/vm.test.ts` times out on main since `a41c9e2`. The guest boots, but the image was built in another home, so every model call fails with `Connection error.`\n\nNext: rebuild the image in CI's home.",
  }),
  task({
    id: T.deps,
    kind: "unattended",
    title: "Update dependencies in website",
    status: "queued",
    project: "website",
    runtime: "vm",
    created: at(-4 * MIN),
    updated: at(-4 * MIN),
  }),
  task({
    id: T.notes,
    kind: "chat",
    title: "Clean up the notes folder: merge duplicates, fix the broken links",
    status: "done",
    outcome: "done",
    project: "notes",
    usage: { tokens: 240_000 },
    hours: 0.7,
    created: at(-3 * DAY),
    updated: at(-3 * DAY + 50 * MIN),
    closed: at(-3 * DAY + 50 * MIN),
    summary: "Merged 4 duplicate notes, fixed 11 broken links. A snapshot was taken before the change.",
  }),
  task({
    id: T.triage,
    kind: "unattended",
    title: "Triage new GitHub issues",
    status: "failed",
    outcome: "failed",
    usage: { tokens: 38_000 },
    hours: 0.1,
    created: at(-2 * DAY),
    updated: at(-2 * DAY + 9 * MIN),
    closed: at(-2 * DAY + 9 * MIN),
    error:
      "boot timeout: the guest's hortus-agent did not write out/booted within 120 s\n[    2.113] virtiofs: mount failed\n[  120.002] killed",
  }),
];

const r = (seq: number, body: Line, ago: number): Row => ({ seq, body, created: at(-ago) });
const rows = (start: number, ...lines: [Line, number][]) => lines.map(([b, ago], i) => r(start + i, b, ago));

const FLAKY_PATCH = `diff --git a/src/schedules/schedules.ts b/src/schedules/schedules.ts
index 9c1e2f0..3b7d5a1 100644
--- a/src/schedules/schedules.ts
+++ b/src/schedules/schedules.ts
@@ -141,7 +141,9 @@ function next(row: ScheduleRow): string | null {
   if (row.cron) return cronNext(row.cron, row.tz);
   if (!row.every_sec) return null;
-  return iso(Date.now() + row.every_sec * 1000);
+  // from the previous fire, not from now: a late tick otherwise lands the next fire inside the same window
+  const prev = Date.parse(row.fire_at ?? "") || Date.now();
+  return iso(Math.max(prev + row.every_sec * 1000, Date.now()));
 }
diff --git a/src/schedules/schedules.test.ts b/src/schedules/schedules.test.ts
index 4a0b1c2..8e2f3d4 100644
--- a/src/schedules/schedules.test.ts
+++ b/src/schedules/schedules.test.ts
@@ -88,6 +88,8 @@ test("an every-15m schedule fires once per tick", async () => {
   await tick();
   assert.equal(fired.length, 1);
+  await tick({ late: 40_000 });
+  assert.equal(fired.length, 2);
 });`;

const replies = new Map<string, Row[]>([
  [
    T.flaky,
    rows(
      1,
      [
        { type: "owner", text: "The schedules test fails about 1 in 10 runs on CI. Can you find out why and fix it?" },
        50 * MIN,
      ],
      [
        {
          type: "thinking",
          text: "A flaky timing test. I'll run the schedules suite a few times, then read how `every` schedules compute their next fire.",
        },
        49.8 * MIN,
      ],
      [
        {
          type: "tool_call",
          id: "c1",
          name: "bash",
          input: { command: "pnpm build && node --test dist/schedules/schedules.test.js" },
        },
        49.7 * MIN,
      ],
      [
        {
          type: "tool_result",
          id: "c1",
          output:
            "✔ fires a cron schedule at its time (3.2ms)\n✔ an at schedule fires once (1.1ms)\n✖ an every-15m schedule fires once per tick (4.1ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n  2 !== 1\n\nℹ tests 12\nℹ pass 11\nℹ fail 1",
          isError: true,
        },
        49 * MIN,
      ],
      [
        {
          type: "tool_call",
          id: "c2",
          name: "read",
          input: { path: "src/schedules/schedules.ts", offset: 130, limit: 30 },
        },
        48.8 * MIN,
      ],
      [
        {
          type: "tool_result",
          id: "c2",
          output:
            "141   if (row.cron) return cronNext(row.cron, row.tz);\n142   if (!row.every_sec) return null;\n143   return iso(Date.now() + row.every_sec * 1000);\n144 }",
        },
        48.7 * MIN,
      ],
      [
        {
          type: "text",
          text: 'Found it. An `every` schedule computes its next fire from **now** instead of from its previous `fire_at`. When a tick runs late (CI machines are slow), the next fire lands inside the same tick window, and the schedule fires twice:\n\n```ts\n// before\nreturn iso(Date.now() + row.every_sec * 1000);\n// after\nconst prev = Date.parse(row.fire_at ?? "") || Date.now();\nreturn iso(Math.max(prev + row.every_sec * 1000, Date.now()));\n```\n\nI\'ll make the change, add a test for a late tick, and run the suite 50 times.',
        },
        48 * MIN,
      ],
      [{ type: "message", role: "assistant" }, 48 * MIN],
      [{ type: "tool_call", id: "c3", name: "edit", input: { path: "src/schedules/schedules.ts" } }, 47.5 * MIN],
      [{ type: "tool_result", id: "c3", output: "edited src/schedules/schedules.ts (+3 −1)" }, 47.4 * MIN],
      [{ type: "tool_call", id: "c4", name: "edit", input: { path: "src/schedules/schedules.test.ts" } }, 47.2 * MIN],
      [{ type: "tool_result", id: "c4", output: "edited src/schedules/schedules.test.ts (+2)" }, 47.1 * MIN],
      [
        {
          type: "tool_call",
          id: "c5",
          name: "bash",
          input: {
            command:
              "for i in $(seq 50); do node --test dist/schedules/schedules.test.js >/dev/null || echo FAIL; done; echo done",
          },
        },
        47 * MIN,
      ],
      [{ type: "tool_result", id: "c5", output: "done" }, 44 * MIN],
      [
        {
          type: "text",
          text: "All 50 runs pass now.\n\n| | Before | After |\n|---|---:|---:|\n| Runs | 50 | 50 |\n| Failures | 5 | **0** |\n\n- **Cause:** the next fire was counted from *now*, so a late tick fired twice.\n- **Fix:** count from the previous fire (`src/schedules/schedules.ts`, 3 lines).\n- **Test:** a late tick in `schedules.test.ts` now fails on the old code.\n\nShall I push the branch and ask to merge it into `main`?",
        },
        43.5 * MIN,
      ],
      [{ type: "owner", text: "Yes, push it." }, 8 * MIN],
      [
        { type: "tool_call", id: "c6", name: "bash", input: { command: `git push origin hortus/${T.flaky}` } },
        7.8 * MIN,
      ],
      [
        {
          type: "tool_result",
          id: "c6",
          output: `To https://hortusd.internal/projects/hortus-agent.git\n * [new branch]      hortus/${T.flaky} -> hortus/${T.flaky}`,
        },
        7.6 * MIN,
      ],
      [{ type: "tool_call", id: "c7", name: "merge", input: {} }, 7.5 * MIN],
      [{ type: "tool_result", id: "c7", output: "merge requested (#312): waiting for the owner" }, 7.4 * MIN],
      [
        {
          type: "text",
          text: `Pushed \`hortus/${T.flaky}\` and asked to merge it into \`main\`. It's waiting for your approval below.`,
        },
        7.3 * MIN,
      ],
    ),
  ],
  [
    T.release,
    rows(
      1,
      [{ type: "owner", text: "Draft the release notes for v0.2 from the commits since v0.1." }, 5 * HR],
      [
        {
          type: "tool_call",
          id: "r1",
          name: "bash",
          input: { command: "git log --oneline v0.1..HEAD | wc -l && git log --format='%s' v0.1..HEAD | head -40" },
        },
        4.95 * HR,
      ],
      [
        {
          type: "tool_result",
          id: "r1",
          output:
            "214\nr24: a Planner batch's row is written with the consumption of its events\nName e2e tests by feature\n…",
        },
        4.94 * HR,
      ],
      [
        {
          type: "text",
          text: "Here's a draft from the 214 commits since v0.1:\n\n## hortus v0.2\n\n### New\n- **Remote console**: sign in from your phone with a passkey.\n- **Schedules**: Workers can set recurring and scripted runs.\n- **Bitbucket** and **GitLab** sources, next to GitHub.\n\n### Better\n- The Planner never loses a batch when hortusd is killed mid-run.\n- Tasks that read untrusted text always ask you, never the judge.\n\n### Fixed\n- A late scheduler tick no longer fires an `every` schedule twice.\n\nWant it shorter, or grouped by area instead?",
        },
        4.6 * HR,
      ],
    ),
  ],
  [
    T.linear,
    rows(
      1,
      [{ type: "owner", text: "Connect to Linear and list my open issues" }, 80 * MIN],
      [
        { type: "thinking", text: "There's no Linear transform yet. I'll write one, test it, and submit it." },
        79 * MIN,
      ],
      [{ type: "tool_call", id: "l1", name: "write", input: { path: "transforms/linear/transform.js" } }, 78 * MIN],
      [{ type: "tool_result", id: "l1", output: "wrote transforms/linear/transform.js (41 lines)" }, 77.9 * MIN],
      [
        {
          type: "tool_call",
          id: "l2",
          name: "bash",
          input: { command: "hortus-agent transforms test linear && git -C /dof/transforms push" },
        },
        77 * MIN,
      ],
      [
        {
          type: "tool_result",
          id: "l2",
          output: "3 tests passed\nsubmitted transform linear (#315): waiting for the owner",
        },
        72 * MIN,
      ],
      [
        {
          type: "text",
          text: "Linear has no transform yet, so I wrote one (3 tests pass) and submitted it. Once you approve it and enter your Linear API key in the approval, I'll list your open issues.",
        },
        71 * MIN,
      ],
    ),
  ],
  [
    T.mika,
    rows(
      1,
      [
        {
          type: "thinking",
          text: "Mika is not a workspace owner, so this text is untrusted. I'll only acknowledge and pass it on.",
        },
        24 * MIN,
      ],
      [
        {
          type: "tool_call",
          id: "m1",
          name: "read",
          input: { path: "/dof/slack/dev/1730962811.004200/1730962811.004200.md" },
        },
        23.5 * MIN,
      ],
      [
        {
          type: "tool_result",
          id: "m1",
          output: "Heads up: tomorrow's deploy window moved to 15:00 JST (DB maintenance). Can you pass it on?",
        },
        23.4 * MIN,
      ],
      [
        {
          type: "tool_call",
          id: "m2",
          name: "send",
          input: { to: "slack:C0DEV:1730962811.004200", text: "Thanks Mika, noted: 15:00 JST. I've passed it on." },
        },
        22 * MIN,
      ],
      [{ type: "tool_result", id: "m2", output: "waiting for approval #313" }, 21 * MIN],
    ),
  ],
  [
    T.review,
    rows(
      1,
      [{ type: "tool_call", id: "v1", name: "bash", input: { command: "gh pr diff 142 --stat" } }, 37 * MIN],
      [
        {
          type: "tool_result",
          id: "v1",
          output:
            " src/connectors/bitbucket.ts   | 88 +++++++--\n src/gateway/webhooks.ts       | 41 ++++\n 6 files changed, 172 insertions(+), 19 deletions(-)",
        },
        36.9 * MIN,
      ],
      [
        { type: "tool_call", id: "v2", name: "browser_navigate", input: { url: "https://ci.example.com/builds/8812" } },
        20 * MIN,
      ],
      [
        { type: "tool_result", id: "v2", output: "302 → https://ci.example.com/login (sign-in requested: #314)" },
        19.9 * MIN,
      ],
      [{ type: "status", text: "reading src/gateway/webhooks.ts" }, 1 * MIN],
    ),
  ],
  [
    T.notes,
    rows(
      1,
      [{ type: "owner", text: "Clean up the notes folder: merge duplicates, fix the broken links" }, 3 * DAY],
      [{ type: "tool_call", id: "n1", name: "bash", input: { command: "grep -rl '](' . | wc -l" } }, 3 * DAY - MIN],
      [{ type: "tool_result", id: "n1", output: "312" }, 3 * DAY - MIN],
      [
        {
          type: "text",
          text: "Done: merged 4 duplicates and fixed 11 links. A snapshot from before the change is in **Settings › Projects › notes**.",
        },
        3 * DAY - 50 * MIN,
      ],
    ),
  ],
]);

const approvals: Approval[] = [
  {
    id: 316,
    kind: "grant",
    category: "credential:aws",
    task_id: null,
    summary: {
      grant: "aws",
      task: T.deps,
      method: "GET",
      host: "s3.amazonaws.com",
      path: "/website-assets?list-type=2",
    },
    status: "pending",
    requested_at: at(-3 * MIN),
    decided_at: null,
    decided_by: null,
    reason: null,
    payload: null,
    grantable: false,
  },
  {
    id: 315,
    kind: "request",
    category: "transforms",
    task_id: T.linear,
    summary: {
      name: "linear",
      new: true,
      manifest: JSON.stringify(
        {
          name: "linear",
          credentials: { linear: { type: "token", hosts: ["api.linear.app"], locations: ["header:Authorization"] } },
          consequential: ["POST api.linear.app/graphql"],
        },
        null,
        2,
      ),
      credentials: { linear: { type: "token", hosts: ["api.linear.app"], locations: ["header:Authorization"] } },
      missing: [{ name: "linear", type: "token" }],
      configured: [],
      tests: 3,
    },
    status: "pending",
    requested_at: at(-72 * MIN),
    decided_at: null,
    decided_by: null,
    reason: null,
    payload: null,
    grantable: false,
  },
  {
    id: 314,
    kind: "login",
    category: "origin:https://ci.example.com",
    task_id: T.review,
    summary: {
      origin: "https://ci.example.com",
      url: "https://ci.example.com/login?next=/builds/8812",
      why: "The CI dashboard needs a sign-in to read the build log of PR #142.",
    },
    status: "pending",
    requested_at: at(-20 * MIN),
    decided_at: null,
    decided_by: null,
    reason: null,
    payload: null,
    grantable: false,
  },
  {
    id: 313,
    kind: "request",
    category: "credential:slack",
    task_id: T.mika,
    summary: {
      method: "POST",
      host: "slack.com",
      path: "/api/chat.postMessage",
      headers: { authorization: "Bearer hortus-secret-slack", "content-type": "application/json; charset=utf-8" },
      bodyPreview: JSON.stringify(
        { channel: "C0DEV", thread_ts: "1730962811.004200", text: "Thanks Mika, noted: 15:00 JST. I've passed it on." },
        null,
        2,
      ),
    },
    status: "pending",
    requested_at: at(-21 * MIN),
    decided_at: null,
    decided_by: null,
    reason: null,
    payload: { judge: "tainted: read a message from U07MIKA", untrusted: ["a message from U07MIKA in #dev"] },
    grantable: true,
  },
  {
    id: 312,
    kind: "request",
    category: "merge",
    task_id: T.flaky,
    summary: {
      project: "hortus-agent",
      branch: `hortus/${T.flaky}`,
      main_sha: "9c1e2f0a7d3b4c5e6f708192a3b4c5d6e7f80912",
      sha: "3b7d5a1c2e4f6a8b0c1d2e3f4a5b6c7d8e9f0a1b",
      added: 5,
      removed: 1,
      files: 2,
      patch: FLAKY_PATCH,
      stat: " src/schedules/schedules.ts      | 4 +++-\n src/schedules/schedules.test.ts | 2 ++\n 2 files changed, 5 insertions(+), 1 deletion(-)",
    },
    status: "pending",
    requested_at: at(-7.4 * MIN),
    decided_at: null,
    decided_by: null,
    reason: null,
    payload: { consequential: true },
    grantable: false,
  },
  {
    id: 311,
    kind: "request",
    category: "credential:github",
    task_id: T.review,
    summary: {
      method: "POST",
      host: "api.github.com",
      path: "/repos/you/hortus-agent/pulls/142/reviews",
      headers: {
        authorization: "Bearer hortus-secret-github",
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      bodyPreview: JSON.stringify(
        {
          event: "COMMENT",
          body: "Two notes on the webhook handler:\n\n1. The HMAC is checked after JSON.parse; check it on the raw body first.\n2. A redelivery with the same id is inserted twice.",
        },
        null,
        2,
      ),
    },
    status: "pending",
    requested_at: at(-2 * MIN),
    decided_at: null,
    decided_by: null,
    reason: null,
    payload: { judge: "posts a review on a public pull request; the owner should read the text first" },
    grantable: false,
  },
  {
    id: 317,
    kind: "request",
    category: "credential:github",
    task_id: T.review,
    summary: { method: "GET", host: "api.github.com", path: "/repos/you/hortus-agent/pulls/142/files" },
    status: "approved",
    requested_at: at(-36 * MIN),
    decided_at: at(-36 * MIN),
    decided_by: "judge",
    reason: "Reading a pull request's files is routine for a review task scoped to this repository.",
    payload: null,
    grantable: false,
  },
  {
    id: 310,
    kind: "request",
    category: "merge",
    task_id: T.notes,
    summary: {
      project: "notes",
      branch: `hortus/${T.notes}`,
      main_sha: "77aa01b",
      sha: "c0ffee1",
      added: 31,
      removed: 58,
      files: 15,
      patch: "",
      stat: "",
    },
    status: "approved",
    requested_at: at(-3 * DAY + 40 * MIN),
    decided_at: at(-3 * DAY + 45 * MIN),
    decided_by: "owner",
    reason: "the checkout has uncommitted changes in index.md",
    payload: null,
    grantable: false,
  },
  {
    id: 308,
    kind: "request",
    category: "merge",
    task_id: T.ci,
    summary: {
      project: "website",
      branch: `hortus/${T.ci}`,
      main_sha: "5e1f0c2",
      sha: "a41c9e2",
      added: 12,
      removed: 3,
      files: 2,
      patch: "",
      stat: "",
    },
    status: "landed",
    requested_at: at(-26 * HR),
    decided_at: at(-25 * HR),
    decided_by: "owner",
    reason: null,
    payload: null,
    grantable: false,
  },
  {
    id: 307,
    kind: "request",
    category: "credential:github",
    task_id: T.triage,
    summary: { method: "GET", host: "api.github.com", path: "/repos/you/hortus-agent/issues?state=open" },
    status: "approved",
    requested_at: at(-2 * DAY),
    decided_at: at(-2 * DAY),
    decided_by: "judge",
    reason: "Routine read of open issues in a repository in the task's scope.",
    payload: null,
    grantable: false,
  },
  {
    id: 306,
    kind: "request",
    category: "credential:slack",
    task_id: T.digestRun,
    summary: {
      method: "POST",
      host: "slack.com",
      path: "/api/chat.postMessage",
      bodyPreview: '{"channel":"C0RANDOM","text":"Morning digest…"}',
    },
    status: "rejected",
    requested_at: at(-14 * HR),
    decided_at: at(-14 * HR + 2 * MIN),
    decided_by: "owner",
    reason: "Wrong channel: send the digest to my DM",
    payload: null,
    grantable: false,
  },
  {
    id: 305,
    kind: "request",
    category: "credential:github",
    task_id: T.ci,
    summary: { method: "GET", host: "api.github.com", path: "/repos/you/website/actions/runs?branch=main" },
    status: "approved",
    requested_at: at(-8 * HR),
    decided_at: at(-8 * HR + MIN),
    decided_by: "owner",
    reason: null,
    payload: null,
    grantable: false,
  },
  {
    id: 309,
    kind: "request",
    category: "credential:telegram",
    task_id: T.triage,
    summary: { method: "POST", host: "api.telegram.org", path: "/bot{telegram}/sendMessage" },
    status: "expired",
    requested_at: at(-5 * DAY),
    decided_at: at(-2 * DAY),
    decided_by: null,
    reason: "no decision in 72 h",
    payload: null,
    grantable: false,
  },
];

const credentials: Credential[] = [
  { name: "anthropic", type: "token", transform: "anthropic", hosts: null, last_use: at(-1 * MIN) },
  { name: "ollama-cloud", type: "token", transform: "openai", hosts: ["ollama.com"], last_use: at(-4 * MIN) },
  { name: "slack", type: "token", transform: "slack", hosts: null, last_use: at(-21 * MIN) },
  { name: "slack-app", type: "token", transform: "slack", hosts: null, last_use: at(-1 * MIN) },
  { name: "github", type: "github-app", transform: "github", hosts: null, last_use: at(-2 * MIN), enabled: true },
  { name: "github-webhook", type: "webhook-secret", transform: "github", hosts: null, last_use: at(-6 * MIN) },
  { name: "discord", type: "token", transform: "discord", hosts: null, last_use: at(-26 * HR) },
  { name: "telegram", type: "token", transform: "telegram", hosts: null, last_use: at(-3 * HR) },
  { name: "aws", type: "aws", transform: "aws", hosts: null, last_use: null },
];

let captured: Captured[] = [
  { origin: "https://app.example.com", cookies: 6, tokens: 1, last_use: at(-90 * MIN) },
  { origin: "https://dashboard.example.org", cookies: 3, tokens: 0, last_use: at(-3 * DAY) },
];

const status: Record<string, Omit<Source, "dof" | "type">> = {
  slack: {
    connected: true,
    lastEvent: at(-1 * MIN),
    size: "48 MB",
    scopes: [
      { scope: "#general", last_sync: at(-6 * MIN) },
      { scope: "#dev", last_sync: at(-6 * MIN) },
      { scope: "#random", last_sync: at(-6 * MIN) },
      { scope: "DM with you", last_sync: at(-6 * MIN) },
    ],
  },
  github: {
    connected: true,
    lastEvent: at(-6 * MIN),
    size: "212 MB",
    deliveries_today: 37,
    last_delivery: at(-6 * MIN),
    webhook: "/github/webhook",
    installation: "App 1234567, installation 89012345",
    last_redelivery: at(-40 * MIN),
    delivery_warning: "2 deliveries arrived only through the redelivery check: check the tunnel",
    scopes: [
      { scope: "you/hortus-agent", last_sync: at(-8 * MIN) },
      { scope: "you/website", last_sync: at(-8 * MIN) },
    ],
  },
  discord: {
    connected: false,
    error:
      "The gateway closed with 4014: the bot's Server Members and Message Content intents are off. Turn them on in the Developer Portal › Bot › Privileged Gateway Intents.",
    size: "3 MB",
    scopes: [],
  },
  telegram: {
    connected: true,
    lastEvent: at(-3 * HR),
    size: "6 MB",
    notes: ["Privacy mode is off: the bot hears every message in its groups."],
    scopes: [
      { scope: "DM with you", last_sync: null },
      { scope: "Family", last_sync: null },
    ],
  },
};

const schedules: Schedule[] = [
  {
    id: 1,
    task_id: T.digest,
    title: "Morning digest",
    fire_at: at(11 * HR),
    every_sec: null,
    cron: "0 9 * * 1-5",
    tz: "Asia/Tokyo",
    text: "Post a digest of yesterday's GitHub activity and unanswered Slack threads to my DM",
    last_run: at(-14 * HR),
    expires_at: null,
    summary:
      "**Yesterday:** 3 PRs merged, 2 issues opened.\n\n**Unanswered:** 1 thread in #dev (Mika, about the deploy window).",
  },
  {
    id: 2,
    task_id: T.ci,
    title: "Investigate the CI failure on main",
    fire_at: at(9 * MIN),
    every_sec: 900,
    cron: null,
    tz: null,
    text: "Check whether CI on main is green again; tell me when it is",
    last_run: at(-6 * MIN),
    expires_at: at(2 * DAY),
    summary: "Still red: `e2e/vm.test.ts` times out.",
  },
  {
    id: 3,
    task_id: T.release,
    title: "Draft the release notes for v0.2",
    fire_at: at(13 * DAY),
    every_sec: null,
    cron: null,
    tz: null,
    text: "Remind me to publish the v0.2 release notes",
    last_run: null,
    expires_at: null,
    summary: null,
  },
];

const snapshots: Record<string, { sha: string; ts: string; message: string }[]> = {
  notes: [
    { sha: "3f2a1b0c4d5e6f708192a3b4c5d6e7f809123456", ts: at(-3 * DAY), message: `before task ${T.notes}` },
    { sha: "8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b", ts: at(-12 * DAY), message: "before task m2k1x0p3a1b2c3d4" },
  ],
};

let sessions: RemoteSession[] = [
  { id: 2, device: "Pixel 9", created: at(-20 * DAY), last_seen: at(-2 * HR), address: "192.168.1.23", current: false },
  {
    id: 3,
    device: "iPad (kitchen)",
    created: at(-6 * DAY),
    last_seen: at(-2 * DAY),
    address: "192.168.1.41",
    current: false,
  },
];
let passkeys: Passkey[] = [
  { id: 1, device: "Pixel 9", created: at(-20 * DAY), last_use: at(-2 * HR) },
  { id: 2, device: "iPad (kitchen)", created: at(-6 * DAY), last_use: at(-2 * DAY) },
];
let paused = false;
let enroll: { url: string; expires_at: string } | null = null;

const inbox = new Map<string, Msg[]>([
  [
    T.mika,
    [
      {
        seq: 1,
        body: {
          from: "slack:C0DEV:1730962811.004200",
          author: "U07MIKA",
          trusted: false,
          text: "@hortus heads up: tomorrow's deploy window moved to 15:00 JST (DB maintenance). Can you pass it on?",
        },
        created: at(-25 * MIN),
      },
      {
        seq: 2,
        body: { from: "planner", trusted: true, text: "Acknowledge in the thread and tell the owner." },
        created: at(-25 * MIN),
      },
    ],
  ],
  [
    T.review,
    [
      {
        seq: 1,
        body: {
          from: "github:you/hortus-agent:pr-142",
          author: "octo-dev",
          trusted: true,
          text: "Review requested on #142",
        },
        created: at(-2 * HR),
      },
    ],
  ],
]);

const outbox = new Map<string, Msg[]>([
  [
    T.digestRun,
    [{ seq: 1, body: { type: "result", text: "Posted the digest to your Slack DM." }, created: at(-13.9 * HR) }],
  ],
  [
    T.ci,
    [{ seq: 1, body: { type: "budget_exceeded", text: "Stopped at the token budget (2.0M)." }, created: at(-2 * HR) }],
  ],
]);

const corpus: (SearchHit & { text: string })[] = [
  {
    dof: "slack",
    path: "dev/1730962811.004200/1730962811.004200.md",
    author: "U07MIKA",
    ts: at(-25 * MIN),
    title: "#dev · deploy window",
    snippet: "",
    text: "Heads up: tomorrow's deploy window moved to 15:00 JST because of the database maintenance. Can you pass it on?",
  },
  {
    dof: "slack",
    path: "general/1730876400.001100/1730876400.001100.md",
    author: "U0123ABCD",
    ts: at(-1 * DAY),
    title: "#general · Friday",
    snippet: "",
    text: "Lunch on Friday after the deploy? The new place next to the station opens at 11:30.",
  },
  {
    dof: "github",
    path: "you/hortus-agent/pulls/142/pr.md",
    author: "octo-dev",
    ts: at(-2 * HR),
    title: "PR #142: Add Bitbucket webhooks",
    snippet: "",
    text: "Adds the Bitbucket webhook listener, HMAC verification and redelivery handling, so a deploy no longer waits for the 10-minute reconcile.",
  },
  {
    dof: "github",
    path: "you/hortus-agent/issues/138/issue.md",
    author: "you",
    ts: at(-4 * DAY),
    title: "Issue #138: Flaky schedules test",
    snippet: "",
    text: "The every-15m schedule test fails about 1 in 10 runs on CI: it fires twice when a tick runs late.",
  },
  {
    dof: "logs",
    path: `${T.flaky}/session.md`,
    author: "hortus",
    ts: at(-44 * MIN),
    title: "Fix the flaky schedules test",
    snippet: "",
    text: "All 50 runs pass now. The next fire was counted from now, so a late tick fired twice; the deploy can go ahead.",
  },
  {
    dof: "telegram",
    path: "family/2026-11-05.md",
    author: "51234987",
    ts: at(-2 * DAY),
    title: "Family · Nov 5",
    snippet: "",
    text: "Don't forget the dentist on Tuesday at 10. I moved the deploy of the new garden shelves to the weekend.",
  },
];

// `?fresh`: a first start with nothing set up, to see what a newcomer sees
if (new URLSearchParams(location.search).has("fresh")) {
  config = {
    owner: { tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
    dofs: {},
    planner: { effort: "low", batch_max: 50, daily_tokens: 5e6 },
    worker: { budget: { tokens: 2e6, hours: 4 }, credentials: [], context_window: 131072, plugins: [] },
    origins: "*",
    vm: { cpus: 2, mem_mb: 4096, max_concurrent: 4, boot_timeout_s: 120, fallback_host: true },
    chat: { allow: [] },
    proxy: { https: 8443, http: 8080, dns: 8053 },
    projects: {},
    policy: { "*": "human" },
  };
  for (const list of [tasks, approvals, credentials, schedules] as unknown[][]) list.length = 0;
  for (const k of Object.keys(status)) delete status[k];
  replies.clear();
  captured = [];
  sessions = [];
  passkeys = [];
}

// ---------------------------------------------------------------------------------------------------------------------
// The scripted Worker

interface Step {
  wait: number;
  line?: Line;
  /** "pause": the Worker waits (an approval); the script resumes from the decision */
  run?: () => undefined | "pause";
}

const timers = new Map<string, number>();
const resumers = new Map<number, (ok: boolean) => void>();

const get = (id: string): Task => {
  const t = tasks.find((x) => x.id === id);
  if (!t) throw new ApiError("not_found", `no task ${id}`);
  return t;
};

function addRow(id: string, body: Line): number {
  const list = replies.get(id) ?? [];
  const seq = (list.at(-1)?.seq ?? 0) + 1;
  const row = { seq, body, created: now() };
  list.push(row);
  replies.set(id, list);
  const t = get(id);
  t.metered = (t.metered ?? 0) + (body.type === "text" ? 400 : 2500);
  t.updated = now();
  bus.dispatchEvent(new CustomEvent(`chat:${id}`, { detail: row }));
  return seq;
}

function setStatus(id: string, s: Task["status"]) {
  const t = get(id);
  t.status = s;
  t.updated = now();
  if (s === "running") t.started = now();
  emit("tasks");
}

function halt(id: string) {
  clearTimeout(timers.get(id));
  timers.delete(id);
}

function play(id: string, steps: Step[]) {
  halt(id);
  setStatus(id, "running");
  let i = 0;
  const next = () => {
    const step = steps[i++];
    if (!step) {
      timers.delete(id);
      setStatus(id, "waiting");
      return;
    }
    timers.set(
      id,
      window.setTimeout(() => {
        if (step.line) addRow(id, step.line);
        if (step.run?.() === "pause") {
          timers.delete(id);
          setStatus(id, "waiting");
        } else next();
      }, step.wait),
    );
  };
  next();
}

/** A reply streamed a few words a row, as a Worker's text deltas arrive. */
function say(text: string): Step[] {
  const words = text.split(/(?<=\s)(?=\S)/);
  const out: Step[] = [];
  for (let i = 0; i < words.length; i += 3)
    out.push({ wait: 28 + Math.random() * 40, line: { type: "text", text: words.slice(i, i + 3).join("") } });
  out.push({ wait: 10, line: { type: "message", role: "assistant" } });
  return out;
}

const think = (text: string): Step => ({ wait: 900, line: { type: "thinking", text } });
let callSeq = 0;
function tool(name: string, input: unknown, output: string, ms = 900, isError = false): Step[] {
  const id = `s${++callSeq}`;
  return [
    { wait: 400, line: { type: "tool_call", id, name, input } },
    { wait: ms, line: { type: "tool_result", id, output, ...(isError ? { isError } : {}) } },
  ];
}

let approvalSeq = 320;

function respond(id: string, text: string) {
  const t = text.toLowerCase();
  const topic = text.replace(/\s+/g, " ").trim().slice(0, 60);
  if (/\b(push|merge|deploy|pr|ship|release|publish|post)\b/.test(t)) {
    const branch = `hortus/${id}`;
    play(id, [
      think("This needs a change landed on main, so it goes through the merge gate."),
      ...tool(
        "bash",
        { command: `git push origin ${branch}` },
        `To https://hortusd.internal/projects/hortus-agent.git\n * [new branch]      ${branch} -> ${branch}`,
      ),
      { wait: 400, line: { type: "tool_call", id: `s${++callSeq}`, name: "merge", input: {} } },
      {
        wait: 500,
        run: () => {
          const aid = ++approvalSeq;
          approvals.unshift({
            id: aid,
            kind: "request",
            category: "merge",
            task_id: id,
            task_title: get(id).title,
            summary: {
              project: get(id).project ?? "hortus-agent",
              branch,
              main_sha: "3b7d5a1c2e4f6a8b0c1d2e3f4a5b6c7d8e9f0a1b",
              sha: "5e1f0c2a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e",
              added: 2,
              removed: 2,
              files: 1,
              patch:
                "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,4 +1,4 @@\n-# hortus-agent\n+# hortus-agent (v0.2)\n \n-hortus-agent is an always-on daemon\n+hortus-agent is an always-on daemon, `hortusd`,",
              stat: " README.md | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)",
            },
            status: "pending",
            requested_at: now(),
            decided_at: null,
            decided_by: null,
            reason: null,
            payload: { consequential: true },
            grantable: false,
          });
          addRow(id, {
            type: "tool_result",
            id: `s${callSeq}`,
            output: `merge requested (#${aid}): waiting for the owner`,
          });
          addRow(id, {
            type: "text",
            text: `Pushed \`${branch}\` and asked to merge it into \`main\`. It's waiting for your approval below.`,
          });
          addRow(id, { type: "message", role: "assistant" });
          resumers.set(aid, (ok) =>
            play(
              id,
              ok
                ? say("Merged into `main`. The origin and your checkout are both at `5e1f0c2`.")
                : say("Okay, I won't merge it. The branch stays on the origin if you change your mind."),
            ),
          );
          emit("approvals");
          return "pause";
        },
      },
    ]);
  } else if (/\b(test|fix|bug|fail|error|debug|crash|broken)\b/.test(t)) {
    play(id, [
      think("Reproduce it first, then read the code it points to."),
      ...tool(
        "bash",
        { command: "pnpm build && node --test dist/" },
        "ℹ tests 1284\nℹ pass 1283\nℹ fail 1\n✖ src/e2e/stop.test.ts › a stop's grace ends the connector's waits",
        1600,
        true,
      ),
      ...tool(
        "read",
        { path: "src/gateway/gateway.ts", offset: 210, limit: 20 },
        "214   await Promise.race([r.chain, sleep(graceMs)]);\n215   r.calls.abort();",
      ),
      ...say(
        "The failing test is `a stop's grace ends the connector's waits`. The gateway waits for the connector's chain **or** the grace period, but it aborts the calls only *after* that race, so a connector stuck in a fetch holds the stop for the whole grace:\n\n```ts\n// abort first, then wait for the chain to notice\nr.calls.abort();\nawait Promise.race([r.chain, sleep(graceMs)]);\n```\n\nWant me to make that change and run the suite?",
      ),
    ]);
  } else {
    play(id, [
      think(`The owner asks: "${topic}". Check what the mirrors already say before answering.`),
      ...tool(
        "bash",
        { command: `dof search "${topic.split(" ").slice(0, 3).join(" ")}" --since 2026-11-01` },
        "3 hits: slack (2), github (1)",
      ),
      ...say(
        `Here's what I found about **${topic}**:\n\n1. **Slack**: two threads in #dev mention it, the latest from today.\n2. **GitHub**: issue #138 tracks the related work.\n\nI can:\n\n- summarize both threads,\n- draft a reply for you to review, or\n- open a task that follows up when something changes.\n\nWhich would help most?`,
      ),
    ]);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Handlers

const open = (s: Task["status"]) => s === "queued" || s === "running" || s === "waiting";
const pendingOf = (id: string) => approvals.filter((a) => a.status === "pending" && a.task_id === id);
const withTitle = (a: Approval): Approval => ({
  ...a,
  task_title: a.task_id ? (tasks.find((t) => t.id === a.task_id)?.title ?? a.task_id) : undefined,
});
const ok = (message?: string) => (message ? { ok: true, message } : { ok: true });

type LoginField = "email" | "password";
interface LoginPage {
  email: string;
  password: string;
  focus: LoginField | null;
  signedIn: boolean;
}
const pages = new Map<number, LoginPage>();
const page = (id: number): LoginPage => {
  const p = pages.get(id) ?? { email: "", password: "", focus: null, signedIn: false };
  pages.set(id, p);
  return p;
};
const submit = (p: LoginPage) => {
  if (p.email && p.password) Object.assign(p, { signedIn: true, focus: null });
};

/** ponytail: the mock's remote page, drawn as the screencast's JPEG would be; clicks hit-test these boxes. */
const SITE = { w: 800, h: 500 };
const BOXES: [LoginField | "submit", number, number, number, number][] = [
  ["email", 250, 180, 300, 36],
  ["password", 250, 230, 300, 36],
  ["submit", 250, 286, 300, 36],
];
function frame(p: LoginPage): string {
  const c = document.createElement("canvas");
  [c.width, c.height] = [SITE.w, SITE.h];
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, SITE.w, SITE.h);
  g.font = "600 22px sans-serif";
  g.fillStyle = "#222";
  g.fillText(p.signedIn ? "You're signed in" : "Sign in", 250, 160);
  if (!p.signedIn)
    for (const [f, x, y, w, h] of BOXES) {
      g.fillStyle = f === "submit" ? "#222" : "#fff";
      g.fillRect(x, y, w, h);
      g.strokeStyle = p.focus === f ? "#222" : "#bbb";
      g.strokeRect(x + 0.5, y + 0.5, w, h);
      g.font = "14px sans-serif";
      g.fillStyle = f === "submit" ? "#fff" : "#555";
      const text = f === "submit" ? "Continue" : f === "password" ? "•".repeat(p.password.length) : p.email;
      g.fillText(text || (f === "email" ? "Email" : "Password"), x + 12, y + 23);
    }
  return c.toDataURL("image/jpeg", 0.8).slice("data:image/jpeg;base64,".length);
}

/** The mock's `/events/login`: a frame now and after each input, `closed` once the entry is decided. */
export function loginStream(id: number, on: (e: LoginEvent) => void): () => void {
  const send = () => {
    const a = approvals.find((x) => x.id === id);
    if (a?.status !== "pending") return on({ closed: a?.status === "approved" ? "done" : "rejected" });
    on({ frame: frame(page(id)), ...SITE, until: Date.now() + 15 * MIN });
  };
  const t = `login:${id}`;
  bus.addEventListener(t, send);
  send();
  return () => bus.removeEventListener(t, send);
}

type Handler = (input: never) => unknown;

export const handlers: Record<string, Handler> = {
  "pause.get": () => ({ paused }),
  "pause.set": ({ paused: p }: { paused: boolean }) => {
    paused = p;
    emit("tasks");
    return { paused };
  },

  // as hortusd pages (src/console/index.ts): the newest `limit` open (by updated), then closed (by closed), from `skip`
  "task.list": ({ limit = 50, skip = 0 }: { limit?: number; skip?: number } = {}) => {
    const by = (k: "updated" | "closed") => (a: Task, b: Task) => (b[k] ?? "").localeCompare(a[k] ?? "");
    const page = (l: Task[]) => l.slice(skip, skip + limit);
    return [
      ...page(tasks.filter((t) => open(t.status)).sort(by("updated"))),
      ...page(tasks.filter((t) => !open(t.status)).sort(by("closed"))),
    ].map((t) => ({ ...t, pending: pendingOf(t.id).length }));
  },
  "task.get": ({ id }: { id: string }): TaskDetail => {
    const t = get(id);
    return {
      task: { ...t, pending: pendingOf(id).length },
      replies: replies.get(id) ?? [],
      approvals: pendingOf(id).map(withTitle),
      inbox: inbox.get(id) ?? [],
      outbox: outbox.get(id) ?? [],
      schedules: schedules.filter((s) => s.task_id === id),
      tainted: id === T.mika ? ["read a message from U07MIKA in #dev (not a trusted author)"] : [],
      ...(id === T.mika
        ? {
            origin: {
              dof: "slack",
              channel: "#dev",
              author: "U07MIKA",
              summary: "heads up: tomorrow's deploy window moved to 15:00 JST",
            },
          }
        : id === T.review
          ? {
              origin: {
                dof: "github",
                channel: "you/hortus-agent",
                author: "octo-dev",
                summary: "review requested on #142",
              },
            }
          : {}),
      ...(t.runtime === "vm"
        ? {
            console_log:
              "[    0.000] Linux version 6.18.2-arch1 (hortus image)\n[    1.402] virtiofs: mounted /dof\n[    2.117] hortus-agent: booted\n[    2.118] hortus-agent: task loaded, 3 tools",
          }
        : {}),
    };
  },
  "task.open": ({ text, cwd }: { text: string; cwd?: string }) => {
    const project = Object.entries(config.projects).find(([, p]) => p.path === cwd)?.[0] ?? null;
    const id = Date.now().toString(36) + Math.random().toString(16).slice(2, 10);
    tasks.unshift(
      task({
        id,
        kind: "chat",
        title: text.replace(/\s+/g, " ").trim().slice(0, 80),
        status: "queued",
        project,
        cwd: cwd ?? null,
      }),
    );
    replies.set(id, []);
    addRow(id, { type: "owner", text });
    emit("tasks");
    setTimeout(() => respond(id, text), 300);
    return { id };
  },
  "task.send": ({ id, text }: { id: string; text: string }) => {
    const seq = addRow(id, { type: "owner", text });
    respond(id, text);
    return { seq };
  },
  "task.message": ({ id, text }: { id: string; text: string }) => {
    const list = inbox.get(id) ?? [];
    list.push({ seq: list.length + 1, body: { from: "console", trusted: true, text }, created: now() });
    inbox.set(id, list);
    emit("tasks");
    return { seq: list.length };
  },
  "task.stop": ({ id }: { id: string }) => {
    halt(id);
    addRow(id, { type: "status", text: "stopped by you" });
    setStatus(id, "waiting");
    return ok("Stopping: the task halts after its current tool (killed after 30 s)");
  },
  "task.close": ({ id, outcome }: { id: string; outcome: "done" | "failed" }) => {
    halt(id);
    const t = get(id);
    Object.assign(t, { status: outcome, outcome, closed: now(), updated: now() });
    emit("tasks");
    return ok();
  },
  "task.budget": ({ id, tokens, hours }: { id: string; tokens?: number; hours?: number }) => {
    const t = get(id);
    if (!open(t.status)) throw new ApiError("invalid", `task ${id} is ${t.status}`);
    t.budget = { tokens: tokens ?? t.budget.tokens, hours: hours ?? t.budget.hours };
    if (t.error?.startsWith("budget_exceeded")) {
      t.error = null;
      if (t.kind === "chat") play(id, say("Thanks, going on."));
    }
    emit("tasks");
    return ok("Budget saved");
  },
  "task.log": ({ id }: { id: string }) => {
    const t = get(id);
    const lines = [`# ${t.title}`, ""];
    for (const row of replies.get(id) ?? []) {
      const b = row.body;
      if (b.type === "owner") lines.push(`**You**\n\n${b.text}\n`);
      else if (b.type === "text") lines.push(b.text);
      else if (b.type === "tool_call") lines.push(`\n\`${b.name}\` ${JSON.stringify(b.input)}\n`);
      else if (b.type === "tool_result") lines.push(`\`\`\`\n${b.output}\n\`\`\`\n`);
    }
    return lines.join("\n");
  },

  // as hortusd pages (src/vault/index.ts): newest id first, pending then decided, each `limit` from `skip`
  "approval.list": ({ limit = 50, skip = 0 }: { limit?: number; skip?: number } = {}) => {
    const page = (l: Approval[]) =>
      [...l]
        .sort((a, b) => b.id - a.id)
        .slice(skip, skip + limit)
        .map(withTitle);
    return [
      ...page(approvals.filter((a) => a.status === "pending")),
      ...page(approvals.filter((a) => a.status !== "pending")),
    ];
  },
  "approval.count": () => approvals.filter((a) => a.status === "pending").length,
  "approval.get": ({ id }: { id: number }) => {
    const a = approvals.find((x) => x.id === id);
    if (!a) throw new ApiError("not_found", `no approval ${id}`);
    return withTitle(a);
  },
  "approval.decide": ({
    id,
    decision,
    credentials: creds,
    reason,
  }: {
    id: number;
    decision: "approve" | "reject";
    credentials?: Record<string, Record<string, unknown>>;
    reason?: string;
    grant?: boolean;
  }) => {
    const a = approvals.find((x) => x.id === id);
    if (!a) throw new ApiError("not_found", `no approval ${id}`);
    if (a.status !== "pending") throw new ApiError("invalid", "already decided");
    if (a.kind === "login" && decision === "approve")
      throw new ApiError("invalid", "a login is finished in the login view");
    Object.assign(a, {
      status: decision === "reject" ? "rejected" : a.category === "merge" ? "landed" : "approved",
      decided_at: now(),
      decided_by: "owner",
      reason: reason || null,
    });
    for (const [name, v] of Object.entries(creds ?? {}))
      if (Object.values(v).some(Boolean))
        credentials.push({ name, type: "token", transform: String(a.summary.name), hosts: null, last_use: null });
    if (a.kind === "grant" && decision === "approve" && !a.task_id) {
      const c = credentials.find((x) => `credential:${x.name}` === a.category);
      if (c) c.enabled = true;
    }
    resumers.get(id)?.(decision === "approve");
    resumers.delete(id);
    emit("approvals", "tasks");
    return a.category === "merge" && decision === "approve" ? ok("Approved and merged into main") : ok();
  },
  "merge.retry": ({ id }: { id: number }) => {
    const a = approvals.find((x) => x.id === id);
    if (a) Object.assign(a, { status: "landed", reason: null });
    emit("approvals");
    return { landed: true, reason: null };
  },
  "merge.diff": ({ id }: { id: number }) => String(approvals.find((x) => x.id === id)?.summary.patch ?? ""),
  "login.input": (i: {
    id: number;
    type: "mouse" | "key" | "text";
    event?: string;
    key?: string;
    text?: string;
    x?: number;
    y?: number;
    modifiers?: number;
  }) => {
    const p = page(i.id);
    const edit = (f: (v: string) => string) => {
      if (p.focus) p[p.focus] = f(p[p.focus]);
    };
    if (i.type === "mouse" && i.event === "mousePressed") {
      const [field] =
        BOXES.find(
          ([, x, y, w, h]) => (i.x ?? -1) >= x && (i.x ?? -1) <= x + w && (i.y ?? -1) >= y && (i.y ?? -1) <= y + h,
        ) ?? [];
      if (field === "submit") submit(p);
      else p.focus = field ?? null;
    } else if (i.type === "text") edit((v) => v + (i.text ?? ""));
    else if (i.type === "key" && i.event === "keyDown") {
      if (i.key?.length === 1 && !((i.modifiers ?? 0) & 7)) edit((v) => v + i.key);
      else if (i.key === "Backspace") edit((v) => v.slice(0, -1));
      else if (i.key === "Enter") submit(p);
      else if (i.key === "Tab") p.focus = p.focus === "email" ? "password" : "email";
      else if (i.key === "Escape") p.focus = null;
    }
    emit(`login:${i.id}`);
    return { until: Date.now() + 15 * MIN };
  },
  "login.done": ({ id }: { id: number }) => {
    const a = approvals.find((x) => x.id === id);
    if (a?.status !== "pending") throw new ApiError("invalid", "already decided");
    Object.assign(a, { status: "approved", decided_at: now(), decided_by: "owner" });
    emit(`login:${id}`);
    captured = [{ origin: String(a?.summary.origin), cookies: 4, tokens: 0, last_use: now() }, ...captured];
    emit("approvals", "tasks");
    return ok("Signed in: the task gets placeholders for the cookies the site set");
  },
  "login.reject": ({ id }: { id: number }) => {
    const a = approvals.find((x) => x.id === id);
    if (a?.status !== "pending") throw new ApiError("invalid", "already decided");
    Object.assign(a, { status: "rejected", decided_at: now(), decided_by: "owner" });
    emit(`login:${id}`, "approvals", "tasks");
    return ok();
  },

  "credential.list": () => credentials,
  "credential.set": ({ name, ...entry }: Credential & Record<string, unknown>) => {
    const i = credentials.findIndex((c) => c.name === name);
    const next: Credential = {
      name,
      type: entry.type,
      transform: (entry.transform as string | undefined) ?? credentials[i]?.transform ?? null,
      hosts: (entry.hosts as string[] | undefined) ?? credentials[i]?.hosts ?? null,
      last_use: credentials[i]?.last_use ?? null,
    };
    if (i >= 0) credentials[i] = next;
    else credentials.push(next);
    emit("settings");
    return ok();
  },
  "credential.delete": ({ name }: { name: string }) => {
    // as hortusd answers (src/vault/index.ts)
    if (!credentials.some((c) => c.name === name)) throw new ApiError("not_found", `no credential ${name}`);
    const users = [
      config.worker.provider === name && "worker.provider",
      config.planner.provider === name && "planner.provider",
      name in config.dofs && `dofs.${name}`,
    ].filter(Boolean);
    if (users.length)
      throw new ApiError("invalid", `${name} is in use by ${users.join(", ")}: change that in Settings first`);
    credentials.splice(
      credentials.findIndex((c) => c.name === name),
      1,
    );
    emit("settings");
    return ok();
  },
  "captured.list": () => captured,
  "captured.forget": ({ origin }: { origin: string }) => {
    captured = captured.filter((c) => c.origin !== origin);
    emit("settings");
    return ok();
  },

  "settings.get": () => ({ config }),
  "settings.set": ({ config: next }: { config: Config }) => {
    // as hortusd answers (src/console/index.ts): zod's issues, each `{ code, path, message }`, and its one-line message
    const e = validateConfig(next);
    const issues = Object.entries(e).map(([path, message]) => ({ code: "custom", path: path.split("."), message }));
    if (issues.length)
      throw new ApiError("invalid", issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), issues);
    config = next;
    emit("settings");
    const unknown = Object.keys(next).filter((k) => !KNOWN_KEYS.includes(k));
    return ok(unknown.length ? `saved; not settings hortusd knows: ${unknown.join(", ")}` : undefined);
  },

  "source.list": (): Source[] =>
    Object.entries(config.dofs).map(([dof, c]) => {
      const missing = (
        {
          slack: [dof, `${dof}-app`],
          discord: [dof],
          telegram: [dof],
          github: [dof, `${dof}-webhook`],
          gitlab: [dof, `${dof}-webhook`],
          bitbucket: [dof, `${dof}-webhook`],
        }[c.type] ?? []
      ).filter((n) => !credentials.some((x) => x.name === n));
      const s = status[dof] ?? {
        connected: false,
        error: missing.length ? "waiting for its credentials" : "connecting…",
        scopes: [],
        ...(c.type === "github" || c.type === "gitlab" || c.type === "bitbucket"
          ? { webhook: `/${dof}/webhook`, deliveries_today: 0, last_delivery: null }
          : {}),
      };
      return { dof, type: c.type, ...s, missing };
    }),
  "source.resync": ({ dof, scope }: { dof: string; scope?: string }) =>
    ok(`Resyncing ${scope ?? dof}: it backfills in the background`),
  "planner.status": () => ({ last: at(-4 * MIN), routed: 23, tokens: 1_240_000, cap: config.planner.daily_tokens }),
  "transforms.status": () => ({ notes: [] }),

  "project.set": ({
    name,
    ...p
  }: {
    name: string;
    path: string;
    main?: string;
    runtime?: "host" | "vm";
    exclude?: string[];
    origins?: string[];
  }) => {
    if (!p.path.startsWith("/")) throw new ApiError("invalid", "path must be absolute");
    config = { ...config, projects: { ...config.projects, [name]: { main: "main", runtime: "host", ...p } } };
    emit("settings");
    return { main: "0".repeat(40), moved: true };
  },
  "project.delete": ({ name }: { name: string }) => {
    const { [name]: _, ...rest } = config.projects;
    config = { ...config, projects: rest };
    emit("settings");
    return ok();
  },
  // as hortusd answers (src/projects/origin.ts): the origin's main, and whether it moved
  "project.sync": () => ({ main: "0".repeat(40), moved: false }),
  "project.status": () => Object.fromEntries(Object.keys(config.projects).map((n) => [n, { git: !(n in snapshots) }])),
  "project.snapshots": ({ name }: { name: string }) => snapshots[name] ?? [],
  "project.restore": ({ sha }: { sha: string }) => ({ sha, main: "0".repeat(40), moved: true }),

  "schedule.list": () => schedules,
  "schedule.unset": ({ id }: { id: number }) => {
    schedules.splice(
      schedules.findIndex((s) => s.id === id),
      1,
    );
    emit("tasks");
    return ok();
  },

  "dof.search": ({
    q,
    in: dof,
    author,
    since,
    until,
  }: {
    q: string;
    in?: string;
    author?: string;
    since?: string;
    until?: string;
  }) => {
    const needle = q.toLowerCase();
    return corpus
      .filter(
        (c) =>
          c.text.toLowerCase().includes(needle) &&
          (!dof || c.dof === dof) &&
          (!author || c.author.includes(author)) &&
          (!since || c.ts >= since) &&
          (!until || c.ts.slice(0, 10) <= until),
      )
      .map(({ text, ...c }) => {
        const i = text.toLowerCase().indexOf(needle);
        const from = Math.max(0, i - 60);
        const snippet = `${from ? "…" : ""}${text.slice(from, i)}[${text.slice(i, i + q.length)}]${text.slice(i + q.length, i + q.length + 80)}${i + q.length + 80 < text.length ? "…" : ""}`;
        return { ...c, snippet };
      });
  },
  "dof.file": ({ dof, path }: { dof: string; path: string }) => {
    const c = corpus.find((x) => x.dof === dof && x.path === path);
    if (!c) throw new ApiError("not_found", `no file ${path} in ${dof}`);
    const text = `---\nauthor: ${c.author}\nts: ${c.ts}\ntitle: "${c.title}"\n---\n${c.text}\n`;
    const dir = path.split("/").slice(0, -1).join("/");
    const name = path.split("/").at(-1) ?? "";
    return { text, size: text.length, siblings: [name, ...(dir ? ["files/screenshot.png"] : [])] };
  },

  "remote.status": () =>
    config.console
      ? {
          listening: true,
          url: `https://${config.console.host ?? "localhost"}:${config.console.listen.split(":").at(-1)}`,
          cert: config.console.tls ? "your certificate" : "the hortus CA",
          remote: false,
        }
      : { listening: false, remote: false },
  "session.list": () => sessions,
  "session.revoke": ({ id }: { id: number }) => {
    sessions = sessions.filter((s) => s.id !== id);
    emit("settings");
    return ok();
  },
  "passkey.list": () => passkeys,
  "passkey.delete": ({ id }: { id: number }) => {
    const p = passkeys.find((x) => x.id === id);
    passkeys = passkeys.filter((x) => x.id !== id);
    sessions = sessions.filter((s) => s.device !== p?.device);
    emit("settings");
    return ok();
  },
  "enroll.code": () => {
    const code = Array.from(
      { length: 8 },
      () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)],
    ).join("");
    enroll = {
      url: `https://${config.console?.host ?? "localhost"}:${config.console?.listen.split(":").at(-1) ?? "7443"}/enroll?code=${code}`,
      expires_at: new Date(Date.now() + 10 * MIN).toISOString(),
    };
    return enroll;
  },
  "vm.image": () => ({ present: true, built: at(-8 * DAY), dir: "~/.hortus/images" }),
};
