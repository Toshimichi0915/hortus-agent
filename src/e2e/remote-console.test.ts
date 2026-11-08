/**
 * The remote console: "a chat opened from the phone edits a
 * project in place like one opened at the machine". The real daemon (HORTUS_NO_NET=1, delegated user scope) with
 * `console.listen` on; the only things done at the machine are the enrolment code (socket) and reading the disk.
 * Everything else goes through the TLS listener with the phone's cookie and `Host`: the requests the web UI makes, then
 * (Chromium present) the web UI itself at 390 px. A chat neither clones, pushes nor merges: the edit is in the checkout at
 * once and "the next sync carries its commits"; a Worker's merge is what the phone approves.
 * The fake model is host-runtime.test.ts's: directive lines, `$CWD` = the directory the system prompt names, text in word deltas.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { request } from "node:https";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, type Cdp, CHROMIUM, connect, launch, page } from "../browser/cdp.ts";
import { openDb } from "../db.ts";
import * as paths from "../paths.ts";
import { rpcClient } from "../rpc.ts";
import { FakeSlack } from "../test/fakes/slack.ts";
import { freePort, stopped, tempDir, until } from "../test/until.ts";
import { SoftAuthenticator } from "../test/webauthn.ts";
import { caCert } from "../vault/ca.ts";

const hasScope = spawnSync("systemd-run", ["--user", "--scope", "-q", "--", "true"]).status === 0;
const skip = !hasScope && "no systemd-run --user (delegated cgroups)";
const noBrowser = skip || (!existsSync(CHROMIUM) && `no ${CHROMIUM}`);
const bin = (name: string) => new URL(`../bin/${name}.js`, import.meta.url).pathname;
const HOST = "console.test";

const FAKE = `
const complete = async (req, onText) => {
  if (!req.tools.length) return { role: "assistant", text: "notes from fake", toolCalls: [] };
  const usage = { input: 10, output: 5, cacheRead: 0 };
  const say = (text) => { for (const w of text.split(/(?<= )/)) onText(w); return text; };
  const last = req.messages.at(-1);
  if (last.role === "tool") {
    const text = say("tool said: " + last.results.map((r) => r.output).join("\\n").slice(0, 2000));
    return { role: "assistant", text, toolCalls: [], usage };
  }
  const cwd = /The owner's shell is in (.+?);/.exec(JSON.stringify(req))?.[1] ?? "";
  const content = last.content ?? "";
  const calls = [];
  for (const line of content.split("\\n")) {
    const m = /^!(bash|done|merge) ?(.*)$/.exec(line.trim());
    if (!m) continue;
    const command = m[2].replaceAll("$CWD", cwd);
    const input = m[1] === "bash" ? { command } : m[1] === "done" ? { summary: m[2] } : {};
    calls.push({ id: "c" + Date.now() + "_" + calls.length, name: m[1], input });
  }
  const text = say("echo: " + content.split("\\n").at(-1));
  return { role: "assistant", text, toolCalls: calls, usage };
};
export default { providers: { fake: { create: () => ({ complete, listModels: async () => ["m"] }) } } };
`;

let home: string;
let fake: string;
let slack: FakeSlack;
let repo: string;
let notes: string;
let port: number;
let rport: number;
let origin: string;
let cookie: string;
let daemon: ChildProcess | undefined;
const units: string[] = [];

interface Res {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}

function raw(path: string, o: { method: string; body?: string; headers: Record<string, string> }) {
  return request({
    host: "127.0.0.1",
    port: rport,
    servername: HOST,
    ca: readFileSync(caCert()),
    path,
    method: o.method,
    headers: {
      host: `${HOST}:${rport}`,
      "user-agent": "phone",
      ...(cookie ? { cookie: `__Host-hortus=${cookie}` } : {}),
      ...o.headers,
    },
    agent: false,
  });
}

/** One request as sent, its whole answer. */
function ask(path: string, method: string, headers: Record<string, string>, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = raw(path, { method, headers });
    r.on("response", (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

const NAV = { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" };
const FETCH = { "x-hortus": "1", "content-type": "application/json", "sec-fetch-site": "same-origin" };

/** A page load or an API call, as the phone's browser sends it. */
const phone = (path: string, body?: unknown): Promise<Res> =>
  body === undefined ? ask(path, "GET", NAV) : ask(path, "POST", { ...FETCH, origin }, JSON.stringify(body));

const dist = new URL("../web/", import.meta.url);
const index = readFileSync(new URL("index.html", dist), "utf8");
/** A page load signed in: the app's shell. */
const page200 = async (path: string) => {
  const r = await phone(path);
  assert.deepEqual([path, r.status, r.body === index], [path, 200, true], r.body.slice(0, 200));
};

const api = async <T = Record<string, unknown>>(method: string, body: unknown = {}): Promise<T> => {
  const r = await phone(`/api/${method}`, body);
  const j = JSON.parse(r.body) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  assert.equal(r.status, 200);
  return j.result as T;
};

/** A chat row as the page shows its text: a tool call as `$ command`, a result its output, the rest their text. */
const rowText = (b: Record<string, unknown>) =>
  b.type === "tool_call"
    ? `\n$ ${String((b.input as { command?: string } | undefined)?.command ?? "")}\n`
    : String(b.text ?? b.output ?? "");

/** The chat stream as EventSource reads it: resolves with its rows' text once `done` matches it. */
function chatStream(id: string, done: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = raw(`/events/chat?task=${id}&after=-1`, {
      method: "GET",
      headers: { accept: "text/event-stream", "sec-fetch-site": "same-origin" },
    });
    const timer = setTimeout(() => r.destroy(new Error("no reply on the stream")), 30_000);
    r.on("response", (res) => {
      assert.equal(res.statusCode, 200);
      let sse = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        sse += c;
        const text = [...sse.matchAll(/^data: (.+)$/gm)].map((m) => rowText(JSON.parse(m[1] as string).body)).join("");
        if (!done.test(text)) return;
        clearTimeout(timer);
        resolve(text);
        r.destroy();
      });
    });
    r.on("error", reject);
    r.end();
  });
}

interface Card {
  task: { status: string; project: string | null; runtime: string; error: string | null };
  replies: { seq: number; body: Record<string, unknown> }[];
}
const card = (id: string) => api<Card>("task.get", { id });
const idle = (id: string) =>
  until(async () => (await card(id)).task.status === "waiting", 30_000, `${id} waiting`).then(() => card(id));
const toldOf = (c: Card) => c.replies.map((r) => r.body.text ?? "").join("");
/** The turn after `send`: a new `started` row, then idle. */
const turn = async (id: string, text: string) => {
  const started = async () => (await card(id)).replies.filter((r) => r.body.text === "started").length;
  const n = await started();
  await api("task.send", { id, text });
  await until(async () => (await started()) > n, 30_000, "the Worker started");
  return idle(id);
};
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const originMain = (project: string) => git(join(home, "projects", `${project}.git`), "rev-parse", "main");

before(async () => {
  if (skip) return;
  home = tempDir("hortus-3d-");
  fake = tempDir("hortus-3dfake-");
  process.env.HORTUS_HOME = home;
  mkdirSync(join(fake, "plugins", "fake"), { recursive: true });
  writeFileSync(
    join(fake, "plugins", "fake", "hortus.json"),
    JSON.stringify({ name: "fake", version: "1.0.0", entrypoint: "fake.mjs" }),
  );
  writeFileSync(join(fake, "plugins", "fake", "fake.mjs"), FAKE);
  repo = join(fake, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "owner");
  git(repo, "config", "user.email", "owner@example.test");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first");
  notes = join(fake, "notes");
  mkdirSync(notes);
  writeFileSync(join(notes, "todo.txt"), "one\n");
  slack = await FakeSlack.start();
  port = await freePort();
  rport = await freePort();
  origin = `https://${HOST}:${rport}`;
  writeFileSync(
    join(home, "hortusd.json"),
    JSON.stringify({
      // the fake provider records its requests here, from inside the sandbox
      policy: { "*": "human", cache: [fake] },
      owner: { tz: "UTC" },
      console: { listen: `127.0.0.1:${rport}`, host: HOST },
      dev: { upstreams: { "slack.com": slack.url } },
      worker: { provider: "fake", model: "m", plugins: [join(fake, "plugins", "fake")] },
      projects: { repo: { path: repo, runtime: "host" }, notes: { path: notes, runtime: "host" } },
      proxy: { https: await freePort(), http: await freePort(), dns: 0 },
    }),
  );
  writeFileSync(
    join(home, "vault.json"),
    JSON.stringify({
      fake: { type: "token", value: "x", transform: "fake" },
      post: { type: "token", value: slack.botToken, transform: "slack" },
    }),
    { mode: 0o600 },
  );
  await boot();
});

/** hortusd in its own scope on `home`; `again`: a second boot. Resolves once the remote listener answers. */
async function boot(again = false): Promise<void> {
  const unit = `hortusd-3d-${process.pid}${again ? "-again" : ""}`;
  units.push(unit);
  daemon = spawn(
    "systemd-run",
    [
      "--user",
      "--scope",
      "-q",
      "--unit",
      unit,
      "-p",
      "Delegate=yes",
      "--",
      process.execPath,
      "--no-warnings",
      bin("hortusd"),
    ],
    {
      env: {
        ...process.env,
        HORTUS_HOME: home,
        HORTUS_CONSOLE_PORT: String(port),
        HORTUS_NO_NET: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  daemon.stderr?.pipe(createWriteStream(join(fake, "hortusd.log"), { flags: "a" }));
  await until(
    () =>
      phone("/").then(
        (r) => r.status === (cookie ? 200 : 302),
        () => false,
      ),
    15_000,
    "the remote listener",
  );
}

after(async () => {
  if (skip) return;
  if (daemon && daemon.exitCode === null) {
    await stopped(daemon);
  }
  for (const u of units) spawnSync("systemctl", ["--user", "stop", `${u}.scope`], { stdio: "ignore" });
  await slack.close();
  rmSync(home, { recursive: true, force: true });
  if (!process.env.KEEP) rmSync(fake, { recursive: true, force: true });
});

const setCookie = (r: Res) => /^__Host-hortus=([^;]+)/.exec(r.headers["set-cookie"]?.[0] ?? "")?.[1] ?? "";

test("the phone enrols at the machine's code and signs in with its passkey", { skip }, async () => {
  assert.equal((await phone("/api/task.list", {})).status, 401);
  const rpc = rpcClient(paths.socket());
  const { code } = (await rpc.call("enroll.code", {})) as { code: string };
  rpc.close();
  const passkey = new SoftAuthenticator(origin);
  const reg = JSON.parse((await phone("/webauthn/register/options", { code })).body);
  const enrolled = await phone("/webauthn/register/verify", { code, device: "phone", response: passkey.create(reg) });
  assert.equal(enrolled.status, 200, enrolled.body);
  const login = JSON.parse((await phone("/webauthn/login/options", {})).body);
  const signed = await phone("/webauthn/login/verify", { response: passkey.get(login) });
  assert.equal(signed.status, 200, signed.body);
  cookie = setCookie(signed);
  assert.ok(cookie);
  await page200("/");
});

test("a chat opened from the phone edits a git project in place; the next sync carries its commit", {
  skip,
}, async () => {
  // what the new chat's project picker offers (chat.tsx › Home): settings.get's projects, by path
  await page200("/");
  const { config } = await api<{ config: { projects: Record<string, { path: string }> } }>("settings.get");
  const cwd = config.projects.repo?.path;
  assert.equal(cwd, repo);

  const { id } = await api<{ id: string }>("task.open", {
    cwd,
    text: `add a line to the README\n!bash cd $CWD && echo 'from the phone' >> README.md && cat README.md`,
  });
  const stream = await chatStream(id, /tool said: # repo\s+from the phone/);
  assert.match(stream, /\$ cd .*repo && echo/);
  const c = await idle(id);
  assert.equal(c.task.project, "repo");
  assert.equal(c.task.runtime, "host");
  assert.equal(c.task.error, null);

  // in place: the owner's working tree, uncommitted, and no clone or branch of the task's
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# repo\nfrom the phone\n");
  assert.equal(git(repo, "status", "--porcelain"), "M README.md");
  assert.ok(!existsSync(paths.clone(id)));

  // what the chat and its task page read (task.get), and the sidebar's chats (task.list)
  await page200(`/chat/${id}`);
  await page200(`/tasks/${id}`);
  const shown = c.replies.map((r) => rowText(r.body)).join("");
  assert.match(shown, /add a line to the README/);
  assert.match(shown, /tool said: # repo\s+from the phone/);
  assert.ok((await api<{ id: string }[]>("task.list")).some((t) => t.id === id));

  // a second turn from the phone commits; a chat never pushes: the sync carries it to the origin
  await api("project.sync", { name: "repo" });
  const before = originMain("repo");
  const after = await turn(id, "!bash cd $CWD && git add -A && git commit -qm 'phone edit' && git log --oneline -1");
  assert.match(toldOf(after), /tool said: \w+ phone edit/);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(originMain("repo"), before);
  await api("project.sync", { name: "repo" });
  assert.equal(originMain("repo"), git(repo, "rev-parse", "HEAD"));

  // closing the chat from the phone keeps the work
  await api("task.close", { id, outcome: "done" });
  assert.equal((await card(id)).task.status, "done"); // "This chat is closed."
  assert.match(readFileSync(join(repo, "README.md"), "utf8"), /from the phone/);
});

test("a chat from the phone on a non-git project: the directory changes, the next sync snapshots it", {
  skip,
}, async () => {
  const { id } = await api<{ id: string }>("task.open", { cwd: notes, text: "!bash cd $CWD && echo two >> todo.txt" });
  const c = await idle(id);
  assert.equal(c.task.project, "notes");
  assert.equal(readFileSync(join(notes, "todo.txt"), "utf8"), "one\ntwo\n");
  await api("project.sync", { name: "notes" });
  assert.equal(git(join(home, "projects", "notes.git"), "show", "main:todo.txt"), "one\ntwo");
});

/** An unattended Worker on `repo` that committed `file` on hortus/<id> and pushed: its merge request is next. */
async function worker(file: string): Promise<string> {
  const id = `w${Date.now().toString(36)}`;
  const db = openDb(paths.db());
  const t = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks(id, kind, title, brief, status, scope, budget, usage, project, runtime, event_keys, created, updated, hours)
     VALUES (?, 'unattended', 'a worker', ?, 'queued', ?, ?, '{"tokens":0}', 'repo', 'host', '[]', ?, ?, 0)`,
  ).run(
    id,
    `!bash echo hi > ${file} && git add -A && git -c user.name=w -c user.email=w@example.test commit -qm ${file} && git push -q -f origin HEAD 2>&1 && echo pushed`,
    JSON.stringify({ credentials: [], repos: [], project: "repo" }),
    JSON.stringify({ usd: 1000, hours: 1 }),
    t,
    t,
  );
  db.close();
  await until(async () => (await card(id)).task.status === "waiting", 30_000, "the Worker's push");
  await api("task.send", { id, text: "!merge" });
  return id;
}

interface Entry {
  id: number;
  status: string;
  reason: string | null;
  task_id: string;
  decided_by: string | null;
  category: string;
}
const mergeOf = async (task: string) =>
  (await api<Entry[]>("approval.list", { limit: 500 })).find((a) => a.task_id === task && a.category === "merge");

test("the phone approves a Worker's merge; a chat's dirty checkout holds it until the chat cleans it", {
  skip,
}, async () => {
  const id = await worker("worker.txt");
  const entry = await until(
    async () => {
      const e = await mergeOf(id);
      return e?.status === "pending" ? e : undefined;
    },
    30_000,
    "the merge entry",
  );
  await page200("/approvals");
  await page200(`/approvals/${entry.id}`);
  const one = await api<{ summary: { added: number; removed: number; files: number } }>("approval.get", {
    id: entry.id,
  });
  assert.deepEqual([one.summary.added, one.summary.removed, one.summary.files], [1, 0, 1]); // "+1 −0 in 1 file"

  // a chat left the checkout dirty: the approval does not land, the reason and Retry are on the phone's page
  const { id: chat } = await api<{ id: string }>("task.open", {
    cwd: repo,
    text: "!bash cd $CWD && echo x >> README.md",
  });
  await idle(chat);
  await api("approval.decide", { id: entry.id, decision: "approve" });
  // "Approved, but not merged: …" and its Retry (approvals.tsx › stuck)
  const held = await mergeOf(id);
  assert.deepEqual([held?.status, held?.decided_by], ["approved", "owner"]);
  assert.match(held?.reason ?? "", /checkout is not clean/);

  await turn(chat, "!bash cd $CWD && git checkout README.md");
  await api("merge.retry", { id: entry.id });
  assert.equal((await mergeOf(id))?.status, "landed");
  assert.equal(readFileSync(join(repo, "worker.txt"), "utf8"), "hi\n");
  await api("task.close", { id: chat, outcome: "done" });
  await api("task.close", { id, outcome: "done" });
});

// ---------------------------------------------------------------------------------------------------------------------
// the same path in a browser: the web UI, the phone's width, its cookie

/** Chromium at 390 px with a virtual passkey, the listener's leaf trusted; its `ev`, `wait` and `button`. */
async function phoneBrowser(t: { after: (f: () => unknown) => void }, dir: string) {
  const browser: Browser = await launch({
    userDataDir: join(fake, dir),
    caCert: join(paths.ca(), "hosts", `${HOST}.crt`), // the leaf: the listener serves no chain to pin the CA by
    args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`],
  });
  t.after(() => browser.close());
  const cdp: Cdp = await connect(browser);
  t.after(() => cdp.close());
  const session = await page(cdp);
  for (const m of ["Page.enable", "Network.enable", "Runtime.enable", "Log.enable", "WebAuthn.enable"])
    await cdp.send(m, {}, session);
  await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
    session,
  );
  // a page that broke: an uncaught error, a console.error, the CSP refusing something (a failed request is the network's)
  const problems: string[] = [];
  cdp.on("Runtime.exceptionThrown", (p) => problems.push(JSON.stringify(p.exceptionDetails)));
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error") problems.push(JSON.stringify(p.args));
  });
  cdp.on("Log.entryAdded", (p) => {
    const e = p.entry as { level: string; source: string; text: string };
    if (e.level === "error" && e.source !== "network") problems.push(`${e.source}: ${e.text}`);
  });
  const ev = async <T>(expression: string): Promise<T> => {
    const r = await cdp.send<{ result: { value: T }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      session,
    );
    assert.equal(r.exceptionDetails, undefined, expression);
    return r.result.value;
  };
  const shot = async (name: string) => {
    if (!process.env.KEEP) return;
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", {}, session);
    writeFileSync(join(fake, `${name}.png`), Buffer.from(data, "base64"));
  };
  const wait = async (expression: string, ms = 20_000) => {
    for (let i = 0; i < ms; i += 50) {
      if (await ev(expression).catch(() => false)) return;
      await sleep(50);
    }
    await shot("timeout");
    assert.fail(`timed out: ${expression}; at ${await ev("location.href")}: ${await ev("document.body.innerText")}`);
  };
  const button = (text: string, within = "document") =>
    `[...${within}.querySelectorAll("button")].find((b) => b.textContent.includes(${JSON.stringify(text)}))`;
  const at = (path: string) => `location.pathname === ${JSON.stringify(path)} && document.readyState === "complete"`;
  const go = async (path: string) => {
    await cdp.send("Page.navigate", { url: origin + path }, session);
    await wait(`${at(path.split("?")[0] as string)} && !!document.querySelector("#main")`);
    await sleep(300); // its first calls answered
    assert.equal(await ev(`document.body.innerText.includes("This page could not be shown")`), false, path);
  };
  const text = () => ev<string>("document.body.innerText");
  return { cdp, session, ev, wait, button, at, go, shot, text, problems };
}

test("the web UI at 390 px: pick the project, send, watch the reply arrive, approve in the chat, a merge approved by tapping", {
  skip: noBrowser,
}, async (t) => {
  const { cdp, session, ev, wait, button, go, shot, text, problems } = await phoneBrowser(t, "chromium");
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    session,
  );
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true }, session);
  const fits = async (what: string) => {
    const [w, inner] = await ev<[number, number]>("[document.documentElement.scrollWidth, innerWidth]");
    assert.ok(w <= inner, `${what}: ${w} px wide in ${inner}`);
  };
  // the phone's session from the first test
  await cdp.send(
    "Network.setCookie",
    { name: "__Host-hortus", value: cookie, url: origin, path: "/", secure: true, httpOnly: true, sameSite: "Strict" },
    session,
  );
  const composer = `document.querySelector("form textarea")`;
  const say = async (message: string) => {
    await ev(`${composer}.focus()`);
    await cdp.send("Input.insertText", { text: message }, session);
    await wait(`!document.querySelector('button[aria-label="Send"]').disabled`);
    await ev(`document.querySelector('button[aria-label="Send"]').click()`);
  };

  await go("/");
  await fits("/");
  await wait(`document.querySelector("select")?.options.length === 3`);
  assert.equal(await ev(`document.querySelector("select").options[2].textContent`), "notes");
  await ev(
    `(() => { const s = document.querySelector("select"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, ${JSON.stringify(notes)}); s.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`,
  );
  await say("!bash cd $CWD && echo three >> todo.txt && cat todo.txt");
  await wait(`/^\\/chat\\/./.test(location.pathname)`);
  const id = (await ev<string>("location.pathname")).split("/")[2] as string;
  await wait(`document.body.innerText.includes("tool said: one")`);
  await idle(id);
  await fits("the chat");
  await shot("chat");
  assert.equal(readFileSync(join(notes, "todo.txt"), "utf8"), "one\ntwo\nthree\n");
  const owners = async () => (await card(id)).replies.filter((r) => r.body.type === "owner").length;
  assert.equal(await owners(), 1);

  // a second message by the keyboard: the phone's Enter is a newline, Send sends
  await ev(`${composer}.focus()`);
  await cdp.send("Input.insertText", { text: "line one" }, session);
  for (const type of ["keyDown", "keyUp"])
    await cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, session);
  await sleep(300);
  assert.equal(await owners(), 1, "Enter did not send");
  await ev(`document.querySelector('button[aria-label="Send"]').click()`);
  await wait(`document.body.innerText.includes("echo: line one")`);
  assert.equal(await owners(), 2);
  await idle(id);

  // a stream longer than the screen: the newest line is not under the composer, live or after a reload
  const newestShows = `(() => { const l = document.querySelector('[aria-live="off"]').lastElementChild.getBoundingClientRect(); return l.bottom <= document.querySelector("form").getBoundingClientRect().top + 1; })()`;
  await say("!bash seq 1 120");
  await wait(`document.body.innerText.includes("tool said: 1")`);
  await idle(id);
  await sleep(300);
  await shot("long-live");
  assert.ok(await ev(newestShows), "the newest line, live");
  await go(`/chat/${id}`);
  await wait(`document.body.innerText.includes("tool said: 1")`);
  await sleep(300);
  await shot("long-load");
  assert.ok(await ev(newestShows), "the newest line, after a reload");

  // a gated request from that chat: its entry shows above the composer, one tap, the retry goes out
  const post = `curl -s --interface "$HORTUS_RPC_LOCAL" -H "Host: slack.com" -H "Authorization: Bearer hortus-secret-post" -H "Content-Type: application/json" -X POST "$HORTUS_RPC/api/chat.postMessage" -d '{"channel":"C2","text":"from the phone"}'`;
  await say(`!bash ${post}`);
  const approve = button("Approve", `document.querySelector('[aria-label="Waiting for your approval"]')`);
  await wait(`!!document.querySelector('[aria-label="Waiting for your approval"]') && !!${approve}`);
  await sleep(300);
  await shot("approval");
  assert.ok(
    await ev(
      `(() => { const r = ${approve}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= document.querySelector("form").getBoundingClientRect().top; })()`,
    ),
    "the Approve button is on screen",
  );
  await ev(`${approve}.click()`);
  await wait(`!document.querySelector('[aria-label="Waiting for your approval"]')`);
  await idle(id);
  await say(`!bash ${post}`);
  await until(() => slack.calls.find((c) => c.params.text === "from the phone"), 20_000, "the post");

  await go(`/tasks/${id}`);
  await fits("the task page");
  await shot("task");
  await wait(`document.body.innerText.includes("tool said: one")`);
  assert.match(await text(), /notes/);

  const w = await worker("tapped.txt");
  const entry = await until(
    async () => {
      const e = await mergeOf(w);
      return e?.status === "pending" ? e : undefined;
    },
    30_000,
    "the merge entry",
  );
  await go("/approvals");
  await fits("/approvals");
  await shot("approvals");
  const card$ = `document.querySelector('[aria-labelledby="ap${entry.id}"]')`;
  await wait(`!!${card$} && !!${button("Approve and merge", card$)}`);
  await ev(`${button("Approve and merge", card$)}.click()`);
  // decided, it leaves Waiting for History; its own page says it merged
  await wait(`!${card$}`);
  await until(async () => (await mergeOf(w))?.status === "landed", 20_000, "landed");
  await go(`/approvals/${entry.id}`);
  await wait(`document.body.innerText.includes("Merged as")`);
  await shot("landed");
  assert.equal(readFileSync(join(repo, "tapped.txt"), "utf8"), "hi\n");
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// before sign-in: the web UI's shell and nothing else

const enrollCode = async () => {
  const rpc = rpcClient(paths.socket());
  const { code } = (await rpc.call("enroll.code", {})) as { code: string };
  rpc.close();
  return code;
};
/** Sent to sign in: a 302 to `/login`, with `next` when the target is a plain path of this origin, and no body. */
const toLogin = (r: Res, what: string, next?: string) => {
  assert.equal(r.status, 302, `${what}: ${r.status} ${r.body.slice(0, 80)}`);
  assert.equal(r.headers.location, next ? `/login?next=${encodeURIComponent(next)}` : "/login", what);
  assert.equal(r.body, "", what);
};

test("without a session: index.html at /login and a live /enroll, each asset at its exact path, the rest redirects or is refused", {
  skip,
}, async () => {
  cookie = "";
  const files = readdirSync(new URL("assets/", dist));
  assert.ok(files.length);

  const login = await ask("/login", "GET", NAV);
  assert.equal(login.status, 200);
  assert.equal(login.body, index);
  assert.match(String(login.headers["content-security-policy"]), /script-src 'self'/);
  assert.equal((await ask("/login", "HEAD", NAV)).status, 200);
  // what the gate sends a deep link to; SignIn checks `next` again before it goes there
  assert.equal((await ask("/login?next=%2Fapprovals%2F1", "GET", NAV)).body, index);
  assert.equal((await ask("/login?next=//evil.test", "GET", NAV)).body, index);
  for (const f of files) {
    const a = await ask(`/assets/${f}`, "GET", {});
    assert.equal(a.status, 200, f);
    assert.equal(a.body, readFileSync(new URL(`assets/${f}`, dist), "utf8"));
    assert.equal((await ask(`/assets/${f}`, "HEAD", {})).status, 200);
  }

  const [f] = files as [string];
  // [target, the `next` it carries]: a plain path of this origin, but never the sign-in pages or another host
  const redirected: [string, string?][] = [
    ["/"],
    ["/tasks", "/tasks"],
    ["/tasks/x/log", "/tasks/x/log"],
    ["/approvals/1/diff", "/approvals/1/diff"],
    ["/approvals/1/login", "/approvals/1/login"],
    ["/dof/slack/x.md", "/dof/slack/x.md"],
    ["/search?q=a%20b", "/search?q=a%20b"],
    ["/settings", "/settings"],
    ["/api/task.list", "/api/task.list"],
    ["/static/webauthn.js", "/static/webauthn.js"],
    ["/index.html", "/index.html"],
    ["/login?next=/tasks&x=1"],
    ["/login/", "/login/"],
    ["//login"],
    ["/LOGIN", "/LOGIN"],
    ["/%6Cogin", "/%6Cogin"],
    ["/assets", "/assets"],
    ["/assets/", "/assets/"],
    ["/assets/nope.js", "/assets/nope.js"],
    [`/assets/${f}?v=1`, `/assets/${f}?v=1`],
    [`/assets/${f}/`, `/assets/${f}/`],
    [`/assets/${f}%00`, `/assets/${f}%00`],
    [`//assets/${f}`],
    [`///assets/${f}`],
    [`/x/../assets/${f}`, `/x/../assets/${f}`],
    [`/assets/./${f}`, `/assets/./${f}`],
    [`/assets%2F${f}`, `/assets%2F${f}`],
    ["/assets/%2e%2e/index.html", "/assets/%2e%2e/index.html"],
    ["/assets/..%2F..%2Fhortusd.json", "/assets/..%2F..%2Fhortusd.json"],
    ["//evil.test/tasks"],
    ["/\\evil.test"],
    ["/enroll"],
    ["/enroll?code=nope"],
  ];
  for (const [p, next] of redirected) {
    toLogin(await ask(p, "GET", NAV), `GET ${p}`, next);
    toLogin(await ask(p, "HEAD", NAV), `HEAD ${p}`, next);
  }
  for (const p of ["/api/task.list", "/api/remote.status", "/login", `/assets/${f}`, "/tasks"]) {
    const r = await ask(p, "POST", { ...FETCH, origin }, "{}");
    assert.deepEqual([`POST ${p}`, r.status, r.body], [`POST ${p}`, 401, "sign in first"]);
  }
  for (const p of ["/events/tasks,approvals,settings", "/events/login?id=1", "/events/chat?task=x"])
    assert.equal(
      (await ask(p, "GET", { accept: "text/event-stream", "sec-fetch-site": "same-origin" })).status,
      401,
      p,
    );
  // other methods: refused, no data, not the shell
  for (const m of ["PUT", "DELETE", "OPTIONS", "PATCH"])
    for (const p of ["/login", "/tasks", `/assets/${f}`]) {
      const r = await ask(p, m, {});
      assert.deepEqual([`${m} ${p}`, r.status, r.body], [`${m} ${p}`, 405, "method not allowed"]);
    }

  // a live code gets the shell; a used one and a bad one the same redirect, and the same refusal from the RPC
  const code = await enrollCode();
  assert.equal((await ask(`/enroll?code=${code}`, "GET", NAV)).body, index);
  const passkey = new SoftAuthenticator(origin);
  const reg = JSON.parse((await phone("/webauthn/register/options", { code })).body);
  assert.equal(
    (await phone("/webauthn/register/verify", { code, device: "web", response: passkey.create(reg) })).status,
    200,
  );
  const used = await ask(`/enroll?code=${code}`, "GET", NAV);
  const bad = await ask("/enroll?code=nope", "GET", NAV);
  toLogin(used, "a used code");
  assert.deepEqual([used.status, used.headers.location, used.body], [bad.status, bad.headers.location, bad.body]);
  const usedRpc = await phone("/webauthn/register/options", { code });
  const badRpc = await phone("/webauthn/register/options", { code: "nope" });
  assert.equal(usedRpc.status, 400);
  assert.deepEqual([usedRpc.status, usedRpc.body], [badRpc.status, badRpc.body]);

  // the session that enrolment made is not used here: sign in with the passkey, as the SignIn page does
  const o = JSON.parse((await phone("/webauthn/login/options", {})).body);
  const signed = await phone("/webauthn/login/verify", { response: passkey.get(o) });
  assert.equal(signed.status, 200, signed.body);
  assert.match(
    signed.headers["set-cookie"]?.[0] ?? "",
    /^__Host-hortus=[\w-]+; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/,
  );
  cookie = setCookie(signed);
  assert.equal((await phone("/tasks")).body, index);
  assert.equal((await phone("/login")).body, index);
});

test("signed in: the CSRF and Host guards, and enrolment refused over the remote listener", { skip }, async () => {
  assert.deepEqual(await api("remote.status"), { remote: true, listening: true, url: origin, cert: "the hortus CA" });
  await assert.rejects(api("enroll.code"), /made at the machine only/);
  const post = (headers: Record<string, string>) => ask("/api/remote.status", "POST", headers, "{}");
  assert.equal((await post({ ...FETCH, origin })).status, 200);
  assert.equal((await post({ ...FETCH, "x-hortus": "" })).status, 403);
  assert.equal((await post({ ...FETCH, "content-type": "text/plain" })).status, 403);
  assert.equal((await post({ ...FETCH, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({ ...FETCH, "sec-fetch-site": "same-site" })).status, 403);
  assert.equal((await post({ ...FETCH, host: `evil.test:${rport}` })).status, 421);
  assert.equal((await ask("/tasks", "GET", { ...NAV, host: "127.0.0.1" })).status, 421);
});

test("in Chromium: Enroll, then a DM's deep link signs in and lands there; a revoked session's page goes to /login", {
  skip: noBrowser,
}, async (t) => {
  const { cdp, session, ev, wait, button, at, problems } = await phoneBrowser(t, "chromium-web");

  // a bad code: the sign-in page
  await cdp.send("Page.navigate", { url: `${origin}/enroll?code=nope` }, session);
  await wait(`${at("/login")} && !!${button("Sign in with a passkey")}`);

  const code = await enrollCode();
  await cdp.send("Page.navigate", { url: `${origin}/enroll?code=${code}` }, session);
  await wait(`${at("/enroll")} && !!${button("Create passkey")} && !${button("Create passkey")}.disabled`);
  await ev(`${button("Create passkey")}.click()`);
  await wait(`document.body.innerText.includes("This device can now sign in")`);

  // the owner.notify DM's link, opened signed out: sign-in, then that page
  await cdp.send("Network.clearBrowserCookies", {}, session);
  await cdp.send("Page.navigate", { url: `${origin}/approvals?x=1` }, session);
  await wait(
    `${at("/login")} && location.search === "?next=%2Fapprovals%3Fx%3D1" && !!${button("Sign in with a passkey")}`,
  );
  await ev(`${button("Sign in with a passkey")}.click()`);
  await wait(`${at("/approvals")} && location.search === "?x=1" && !!document.querySelector("#main")`);
  assert.ok(!(await ev<boolean>(`!!${button("Sign in with a passkey")}`)));

  // a forged `next` goes nowhere but home
  await cdp.send("Page.navigate", { url: `${origin}/login?next=//evil.test/x` }, session);
  await wait(`${at("/login")} && !!${button("Sign in with a passkey")}`);
  await ev(`${button("Sign in with a passkey")}.click()`);
  await wait(
    `${at("/")} && location.host === ${JSON.stringify(new URL(origin).host)} && !!document.querySelector("#main")`,
  );

  // the page's stream is cut with the session; its reopen gets a 401, the probe after it goes to sign-in, and back
  await cdp.send("Page.navigate", { url: `${origin}/schedules` }, session);
  await wait(`${at("/schedules")} && !!document.querySelector("#main")`);
  const rpc = rpcClient(paths.socket());
  for (const s of (await rpc.call("session.list", {})) as { id: string; device: string }[])
    if (s.device !== "web") await rpc.call("session.revoke", { id: s.id });
  rpc.close();
  await wait(
    `${at("/login")} && location.search === "?next=%2Fschedules" && !!${button("Sign in with a passkey")}`,
    15_000,
  );
  assert.deepEqual(problems, []);
});
