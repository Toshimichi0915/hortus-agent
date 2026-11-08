/**
 * The real `gh` and `git` through the real proxy against the fake GitHub, under `auto` with a fake judge. `gh` reaches
 * the TLS listener by CONNECT through a local forwarder (HTTPS_PROXY), so it speaks to `api.github.com` as in a session
 * and nothing can leave: the forwarder only ever dials the listener, and `dev.upstreams` sends every host to the fake.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import http from "node:http";
import { type AddressInfo, connect, createServer, type Server } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { Config } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { openDb, taint } from "../db.ts";
import { logger } from "../log.ts";
import * as paths from "../paths.ts";
import { sandboxEnv } from "../runtime/host.ts";
import { FakeGitHub } from "../test/fakes/github.ts";
import { tempDir } from "../test/until.ts";
import type { TaskJson } from "../types.ts";
import { caCert } from "../vault/ca.ts";
import { gate, vaultModule } from "../vault/index.ts";
import { write as writeVault } from "../vault/vault.ts";
import { links, listen, proxyModule } from "./index.ts";

const GH = "/usr/bin/gh";
const run = promisify(execFile);

process.env.HORTUS_HOME = tempDir("hortus-gh-");
process.env.HORTUS_NO_NET = "1";

type Mode = "allow" | "escalate";
let mode: Mode = "allow";
const seen: string[] = [];
const llm = http.createServer((req, res) => {
  const c: Buffer[] = [];
  req.on("data", (x: Buffer) => c.push(x));
  req.on("end", () => {
    seen.push(JSON.parse(Buffer.concat(c).toString()).messages[1].content);
    res.writeHead(200, { "content-type": "application/json" });
    const content = JSON.stringify({ verdict: mode, reason: `fake says ${mode}` });
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }));
  });
});

interface Row {
  id: number;
  status: string;
  decided_by: string | null;
  summary: string;
  payload: string | null;
}

describe("gh through the proxy", { skip: !existsSync(GH) }, () => {
  let fake: FakeGitHub;
  let ctx: Ctx;
  const servers: Server[] = [];
  const envs = new Map<string, Record<string, string>>();
  const home = tempDir("hortus-gh-home-");
  const rows = (sql: string, ...a: string[]) =>
    ctx.db.prepare(`SELECT * FROM approvals WHERE ${sql}`).all(...a) as unknown as Row[];
  const pending = () => rows("status = 'pending' ORDER BY id");
  const allowed = () => rows("decided_by = 'judge' ORDER BY id");

  /** gh (or git) as the session on `addr`; never throws: `code` says how it ended. */
  async function as(addr: string, cmd: string, args: string[], cwd = home) {
    try {
      const r = await run("timeout", ["30", cmd, ...args], { env: envs.get(addr), cwd, maxBuffer: 1 << 26 });
      return { code: 0, out: r.stdout + r.stderr };
    } catch (e) {
      const x = e as { code: number; stdout: string; stderr: string };
      return { code: x.code, out: x.stdout + x.stderr };
    }
  }
  const gh = (...args: string[]) => as("127.0.0.2", GH, args);

  /** Runs `args`, which must wait for the owner; the entry is consequential and no judge was asked. */
  async function asks(args: string[], cmd = GH, cwd = home, addr = "127.0.0.2") {
    const before = seen.length;
    const r = await as(addr, cmd, args, cwd);
    const p = pending().at(-1);
    assert.ok(p, `${args.join(" ")}: an entry for the owner (${r.out})`);
    assert.notEqual(r.code, 0, r.out);
    assert.equal(JSON.parse(p.payload ?? "{}").consequential, true, p.summary);
    // the client's own reads are judged on the way; this one is not
    const s = JSON.parse(p.summary) as { method: string; path: string; bodyPreview: unknown };
    const own = [`"method": "${s.method}"`, `"path": ${JSON.stringify(s.path)}`, JSON.stringify(s.bodyPreview)];
    assert.ok(!seen.slice(before).some((x) => own.every((o) => x.includes(o))), `${args.join(" ")}: judged`);
    return p;
  }
  /** The owner approves, the same command runs again and lands; gh's own reads go to the judge on the way. */
  async function approved(p: Row, args: string[], cmd = GH, cwd = home) {
    gate.decide(p.id, "approve", "owner");
    const r = await as("127.0.0.2", cmd, args, cwd);
    assert.equal(r.code, 0, r.out);
    return r;
  }

  before(async () => {
    await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
    fake = await FakeGitHub.start();
    await fake.repo("o/r", "the repo");
    await fake.repo("o/other");
    await fake.commit("o/r", "feat", "x.txt", "x\n");
    await fake.commit("o/r", "feat2", "y.txt", "y\n");
    await fake.openIssue("o/r", { user: "carol", title: "bug" }, { drop: true });
    await fake.openPR("o/r", { user: "carol", title: "a PR", head: "feat", diff: "d" }, { drop: true });
    writeVault({ ...fake.vault("github"), llm: { type: "token", value: "sk-llm", transform: "openai" } });
    const config = Config.parse({
      dofs: { github: { type: "github", owner: "toshi" } },
      dev: {
        upstreams: {
          "api.github.com": fake.url,
          "uploads.github.com": fake.url,
          "github.com": fake.url,
          "api.openai.com": `http://127.0.0.1:${(llm.address() as AddressInfo).port}`,
        },
      },
      proxy: { https: 0, http: 0, dns: 0 },
      planner: { provider: "llm", model: "judge-1" },
      policy: { "credential:github": "auto" },
    });
    ctx = { config, db: openDb(paths.db()), paths, log: logger, reload: async () => {} };
    await vaultModule.start(ctx);
    await proxyModule.start(ctx);
    gate.deps.inboxWrite = () => {};
    gate.deps.notify = () => {};
    const { https } = await listen("127.0.0.1", { https: 0, http: 0, dns: 0, proxyAddress: "127.0.0.1" });
    const task = (id: string, addr: string, repos: string[]) => {
      ctx.db
        .prepare("INSERT INTO tasks(id, kind, status, scope, brief) VALUES (?, 'unattended', 'running', ?, 'x')")
        .run(id, JSON.stringify({ credentials: ["github"], repos }));
      links.register(addr, "worker", id, "session");
      const fwd = createServer((c) => {
        c.once("data", () => {
          const s = connect({ host: "127.0.0.1", port: https, localAddress: addr }, () => {
            c.write("HTTP/1.1 200 OK\r\n\r\n");
            s.pipe(c).on("error", () => {});
            c.pipe(s);
          });
          s.on("error", () => c.destroy());
          c.on("error", () => s.destroy());
        });
      });
      servers.push(fwd);
      return new Promise<void>((r) =>
        fwd.listen(0, "127.0.0.1", () => {
          const t = { id, scope: { credentials: ["github"], repos } } as unknown as TaskJson;
          envs.set(addr, {
            ...sandboxEnv(t, ctx.config),
            HOME: home,
            GH_CONFIG_DIR: join(home, `gh-${id}`),
            GH_REPO: "o/r",
            GH_PROMPT_DISABLED: "1",
            HTTPS_PROXY: `http://127.0.0.1:${(fwd.address() as AddressInfo).port}`,
            SSL_CERT_FILE: caCert(),
            GIT_SSL_CAINFO: caCert(),
          });
          r();
        }),
      );
    };
    await task("W", "127.0.0.2", ["github:o/r"]);
    await task("T", "127.0.0.3", ["github:o/r"]);
    await task("N", "127.0.0.4", []);
    taint(ctx.db, "T", "read a web page: evil.test");
    // the first use under `auto` asks once, for the category
    const first = await gh("api", "repos/o/r");
    assert.match(first.out, /approval \d+ is waiting/);
    gate.decide((pending().at(-1) as Row).id, "approve", "owner");
  });

  after(async () => {
    for (const s of servers) s.close();
    llm.close();
    await proxyModule.stop?.();
    await vaultModule.stop?.();
    await fake.close();
  });

  test("reads: gh pr view, pr list, issue view, api, repo clone pass on the judge's allow; each shown", async () => {
    mode = "allow";
    const n = allowed().length;
    const view = await gh("pr", "view", "2");
    assert.equal(view.code, 0, view.out);
    assert.match(view.out, /a PR/);
    assert.match((await gh("pr", "list")).out, /a PR/);
    assert.match((await gh("api", "repos/o/r")).out, /"full_name":"o\/r"/);
    const clone = await gh("repo", "clone", "o/r", join(home, "c"));
    assert.equal(clone.code, 0, clone.out);
    assert.ok(existsSync(join(home, "c/README.md")));
    assert.ok(allowed().length > n, "each read is an `allowed` row");
    assert.equal(pending().length, 0, String(pending()[0]?.summary));
    // the judge read the true document
    assert.ok(seen.some((s) => s.includes("PullRequestByNumber")));
    assert.ok(fake.mints.every((m) => m.repositories?.join() !== "other"));
  });

  test("writes: gh issue comment, pr create, pr merge, release upload wait, say so, and land on approval", async () => {
    mode = "allow";
    const comment = ["issue", "comment", "1", "--body", "hi"];
    const c = await asks(comment);
    assert.match(JSON.parse(c.summary).rendered, /mutation CommentCreate.*"body":"hi"/);
    assert.match((await gh(...comment)).out, new RegExp(`approval ${c.id} is waiting for the owner`));
    await approved(c, comment);

    const create = ["pr", "create", "--head", "feat2", "--base", "main", "--title", "two", "--body", "b"];
    const p = await asks(create);
    assert.match((await approved(p, create)).out, /github.com\/o\/r\/pull\/3/);
    // a review on a PR the task opened comes back to it, by whichever client it was opened
    assert.ok(ctx.db.prepare("SELECT 1 FROM task_refs WHERE ref = 'github:o/r:!3' AND task_id = 'W'").get());

    const merges = () => fake.graphqls.filter((g) => g.query.includes("mergePullRequest(")).length;
    const merge = ["pr", "merge", "2", "--squash"];
    const m = await asks(merge);
    assert.match(JSON.parse(m.summary).rendered, /mutation .*mergePullRequest/);
    assert.equal(merges(), 0, "not before the approval");
    await approved(m, merge);
    assert.equal(merges(), 1);

    const file = join(home, "asset.bin");
    writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 7));
    const upload = ["release", "upload", "v1", file];
    const u = await asks(upload);
    assert.equal(JSON.parse(u.summary).host, "uploads.github.com");
    await approved(u, upload);
    assert.equal(fake.assets.get(1)?.get("asset.bin"), 3 * 1024 * 1024);
  });

  for (const judged of ["allow", "escalate"] as const)
    test(`consequential under a judge that would ${judged}: REST, GraphQL and git reach the owner`, async () => {
      mode = judged;
      const flows = [
        ["api", "-X", "PUT", "repos/o/r/pulls/2/merge"],
        ["api", "-X", "POST", "repos/o/r/releases", "-f", `tag_name=${judged}`],
        ["api", "-X", "PATCH", "repos/o/r/releases/1", "-F", "draft=false"],
        ["api", "-X", "POST", "user/repos", "-f", `name=${judged}`],
        ["api", "-X", "DELETE", "repos/o/r"],
        [
          "api",
          "graphql",
          "-f",
          `query=mutation{deleteRepository(input:{repositoryId:"${judged}"}){clientMutationId}}`,
        ],
        [
          "api",
          "graphql",
          "-f",
          `query=mutation M{mergePullRequest(input:{pullRequestId:"${judged}"}){clientMutationId}}`,
        ],
      ];
      for (const f of flows) {
        const p = await asks(f);
        gate.decide(p.id, "reject", "owner");
      }
      // the same from a tainted task: no grant reaches them
      for (const f of flows) {
        const p = await asks(f, GH, home, "127.0.0.3");
        assert.match(p.payload ?? "", /read a web page/);
        assert.equal(gate.grantable({ ...p, kind: "request", task_id: "T" }), false);
        gate.decide(p.id, "reject", "owner");
      }
    });

  test("a push reaches the owner with its ref line: a judge that would allow, one that escalates, a tainted task", async () => {
    mode = "allow";
    const cwd = join(home, "push");
    assert.equal((await gh("repo", "clone", "o/r", cwd)).code, 0);
    await as("127.0.0.2", "git", ["commit", "--allow-empty", "-qm", "c"], cwd);
    const p = await asks(["push", "-q", "origin", "HEAD:refs/heads/hortus/W"], "git", cwd);
    assert.match(JSON.parse(p.summary).rendered, /push o\/r: .* refs\/heads\/hortus\/W/);
    gate.decide(p.id, "reject", "owner");
    // an escalating judge and a tainted task ask for the ref advertisement first; a new commit each, as a refused hash
    // stays refused
    const pushes = async (addr: string, ref: string) => {
      await as(addr, "git", ["commit", "--allow-empty", "-qm", ref], cwd);
      for (let i = 0; i < 5; i++) {
        await as(addr, "git", ["push", "-q", "origin", `HEAD:refs/heads/hortus/${ref}`], cwd);
        const e = pending().at(-1) as Row;
        if (JSON.parse(e.summary).method !== "GET") {
          assert.equal(JSON.parse(e.payload ?? "{}").consequential, true);
          assert.match(JSON.parse(e.summary).rendered, /push o\/r: /);
          return e;
        }
        gate.decide(e.id, "approve", "owner");
      }
      assert.fail("no push entry");
    };
    mode = "escalate";
    gate.decide((await pushes("127.0.0.2", "W")).id, "reject", "owner");
    mode = "allow";
    const t = await pushes("127.0.0.3", "T");
    assert.match(t.payload ?? "", /read a web page/);
    assert.equal(gate.grantable({ ...t, kind: "request", task_id: "T" }), false);
    gate.decide(t.id, "reject", "owner");
  });

  test("a read under an escalating judge, from a tainted task and from a task with no repos asks", async () => {
    mode = "escalate";
    const n = seen.length;
    assert.match((await gh("pr", "view", "1")).out, /approval \d+ is waiting/);
    const e = pending().at(-1) as Row;
    assert.equal(seen.length, n + 1);
    assert.match(e.payload ?? "", /fake says escalate/);
    gate.decide(e.id, "reject", "owner");

    mode = "allow";
    assert.match((await as("127.0.0.3", GH, ["pr", "view", "1"])).out, /approval \d+ is waiting/);
    const t = pending().at(-1) as Row;
    assert.equal(seen.length, n + 1, "a tainted task is not judged");
    assert.equal(gate.grantable({ ...t, kind: "request", task_id: "T" }), true, "not consequential: grantable");
    gate.decide(t.id, "reject", "owner");

    const p = await asks(["api", "graphql", "-f", "query={viewer{login}}"], GH, home, "127.0.0.4");
    gate.decide(p.id, "reject", "owner");
  });

  test("GraphQL spellings that hide a write stay consequential; the judge sees the true request", async () => {
    mode = "allow";
    const file = join(home, "body.json");
    const raw = async (body: string, ...more: string[]) => {
      writeFileSync(file, body);
      const p = await asks(["api", "graphql", "--input", file, ...more]);
      gate.decide(p.id, "reject", "owner");
    };
    await raw('{"query":"\\u006dutation{x}"}');
    await raw('{"query":"\\u006dutation{x}","query":"{viewer{login}}"}');
    await raw('[{"query":"{viewer{login}}"}]');
    await raw('{"query":"{viewer{login}}"}', "-H", "content-type: application/x-www-form-urlencoded");
    await raw('{"query":"{viewer{login}}"}', "-H", "content-encoding: deflate");
    await raw('{"query":"{viewer{login}}","x":"a mutation in a variable"}');
    writeFileSync(file, '{"query":"{viewer{login}}"}');
    const q = await asks(["api", "-X", "POST", "graphql?query=mutation%7Bx%7D", "--input", file]);
    gate.decide(q.id, "reject", "owner");
    // only a POST to GraphQL is vouched for: a `query` field in a REST body or under another verb says nothing
    for (const [method, path] of [
      ["POST", "repos/o/r/merges"],
      ["PUT", "graphql"],
    ] as const) {
      const p = await asks(["api", "-X", method, path, "--input", file]);
      gate.decide(p.id, "reject", "owner");
    }
    // Enterprise's path on the web host is the same rule: a write asks, a read reaches the judge
    const enterprise = (query: string) => [
      ...["-sSf", "--cacert", caCert(), "-X", "POST", "https://github.com/api/graphql"],
      ...["-H", "authorization: Bearer hortus-secret-github", "-H", "content-type: application/json"],
      ...["-d", JSON.stringify({ query })],
    ];
    const w = await asks(enterprise("mutation{x}"), "curl");
    gate.decide(w.id, "reject", "owner");
    await as("127.0.0.2", "curl", enterprise("{viewer{login}}"));
    assert.equal(JSON.parse(allowed().at(-1)?.summary ?? "{}").path, "/api/graphql");

    // padding: a body the judge cannot read whole goes to the owner, told so
    const n = seen.length;
    const pad = await gh("api", "-X", "POST", "repos/o/r/issues", "-f", `title=${"x".repeat(9000)}`, "-f", "body=tail");
    assert.match(pad.out, /approval \d+ is waiting/);
    const entry = pending().at(-1) as Row;
    assert.equal(seen.length, n, "not judged");
    assert.match(entry.payload ?? "", /too long for the judge/);
    assert.match(JSON.parse(entry.summary).bodyPreview, /more chars not shown$/);
    gate.decide(entry.id, "reject", "owner");

    // a query string is part of what the judge and the owner read
    await gh("api", "-X", "POST", "repos/o/r/issues?title=from-the-query", "-f", "title=t");
    assert.match(seen.at(-1) ?? "", /title=from-the-query/);
    assert.ok(allowed().some((a) => JSON.parse(a.summary).path.includes("title=from-the-query")));
  });
});
