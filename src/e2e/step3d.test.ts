/**
 * v6 step 3d's last done-when (10-remote-console.md, v6 › Projects › Chat): "a chat opened from the phone edits a
 * project in place like one opened at the machine". The real daemon (HORTUS_NO_NET=1, delegated user scope) with
 * `console.listen` on; the only things done at the machine are the enrolment code (socket) and reading the disk.
 * Everything else goes through the TLS listener with the phone's cookie and `Host`: the requests app.js makes, then
 * (Chromium present) app.js itself at 390 px. A chat neither clones, pushes nor merges: the edit is in the checkout at
 * once and "the next sync carries its commits"; a Worker's merge is what the phone approves.
 * The fake model is step 3's: directive lines, `$CWD` = the directory the system prompt names, text in word deltas.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const usage = { input: 10, output: 5, cached: 0 };
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
let unit = "";

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

/** A page load or an app.js call, as the phone's browser sends it. */
function phone(path: string, body?: unknown): Promise<Res> {
  const post = body !== undefined;
  return new Promise((resolve, reject) => {
    const r = raw(path, {
      method: post ? "POST" : "GET",
      headers: post
        ? {
            "x-hortus": "1",
            "content-type": "application/json",
            "sec-fetch-site": "same-origin",
            origin,
          }
        : { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" },
    });
    r.on("response", (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    r.end(post ? JSON.stringify(body) : undefined);
  });
}

const page200 = async (path: string) => {
  const r = await phone(path);
  assert.equal(r.status, 200, `${path}: ${r.body}`);
  assert.ok(!r.body.includes("Sign in with passkey"), `${path}: the login page`);
  return r.body;
};

const api = async <T = Record<string, unknown>>(method: string, body: unknown = {}): Promise<T> => {
  const r = await phone(`/api/${method}`, body);
  const j = JSON.parse(r.body) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  assert.equal(r.status, 200);
  return j.result as T;
};

/** The chat stream as EventSource reads it: resolves with the SSE text once `done` matches it. */
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
        const html = [...sse.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1] as string).html).join("");
        if (!done.test(html.replace(/<[^>]+>/g, ""))) return;
        clearTimeout(timer);
        resolve(html);
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
  unit = `hortusd-3d-${process.pid}`;
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
      env: { ...process.env, HORTUS_HOME: home, HORTUS_CONSOLE_PORT: String(port), HORTUS_NO_NET: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  daemon.stderr?.pipe(createWriteStream(join(fake, "hortusd.log"), { flags: "a" }));
  await until(
    () =>
      phone("/").then(
        (r) => r.status === 200,
        () => false,
      ),
    15_000,
    "the remote listener",
  );
});

after(async () => {
  if (skip) return;
  if (daemon && daemon.exitCode === null) {
    await stopped(daemon);
  }
  spawnSync("systemctl", ["--user", "stop", `${unit}.scope`], { stdio: "ignore" });
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
  assert.match(await page200("/"), /<nav>/);
});

test("v6 3d: a chat opened from the phone edits a git project in place; the next sync carries its commit", {
  skip,
}, async () => {
  // what the Chat page offers: the project picker, the call and where it goes next
  const form = await page200("/chat");
  assert.match(form, /data-call="task\.open"/);
  const cwd = /<option value="([^"]+)">repo<\/option>/.exec(form)?.[1];
  assert.equal(cwd, repo);

  const { id } = await api<{ id: string }>("task.open", {
    cwd,
    text: `add a line to the README\n!bash cd $CWD && echo 'from the phone' >> README.md && cat README.md`,
  });
  const stream = await chatStream(id, /tool said: # repo\s+from the phone/);
  assert.match(stream, /cd .*repo &amp;&amp; echo/);
  const c = await idle(id);
  assert.equal(c.task.project, "repo");
  assert.equal(c.task.runtime, "host");
  assert.equal(c.task.error, null);

  // in place: the owner's working tree, uncommitted, and no clone or branch of the task's
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# repo\nfrom the phone\n");
  assert.equal(git(repo, "status", "--porcelain"), "M README.md");
  assert.ok(!existsSync(paths.clone(id)));

  const chatView = await page200(`/chat/${id}`);
  assert.match(chatView, /add a line to the README/);
  assert.match(chatView.replace(/<[^>]+>/g, ""), /tool said: # repo\s+from the phone/);
  const taskCard = await page200(`/tasks/${id}`);
  assert.match(taskCard, /<th>Project<\/th><td>repo<\/td>/);
  assert.match(taskCard.replace(/<[^>]+>/g, ""), /tool said: # repo\s+from the phone/);
  assert.match(await page200("/"), new RegExp(`/chat/${id}`));

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
  assert.match(await page200(`/chat/${id}`), /This chat is closed/);
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
    JSON.stringify({ tokens: 1e6, hours: 1 }),
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
  category: string;
}
const mergeOf = async (task: string) =>
  (await api<Entry[]>("approval.list", { limit: 500 })).find((a) => a.task_id === task && a.category === "merge");

test("v6 3d: the phone approves a Worker's merge; a chat's dirty checkout holds it until the chat cleans it", {
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
  const list = await page200("/approvals");
  assert.match(list, /data-call="approval\.decide"/);
  assert.match(await page200(`/approvals/${entry.id}`), /\+1 −0 in 1 file/);

  // a chat left the checkout dirty: the approval does not land, the reason and Retry are on the phone's page
  const { id: chat } = await api<{ id: string }>("task.open", {
    cwd: repo,
    text: "!bash cd $CWD && echo x >> README.md",
  });
  await idle(chat);
  await api("approval.decide", { id: entry.id, decision: "approve" });
  assert.match((await mergeOf(id))?.reason ?? "", /not clean/);
  const held = await page200(`/approvals/${entry.id}`);
  assert.match(held, /checkout is not clean/);
  assert.match(held, /data-call="merge\.retry"/);

  await turn(chat, "!bash cd $CWD && git checkout README.md");
  await api("merge.retry", { id: entry.id });
  assert.equal((await mergeOf(id))?.status, "landed");
  assert.equal(readFileSync(join(repo, "worker.txt"), "utf8"), "hi\n");
  assert.match(await page200(`/approvals/${entry.id}`), /landed <code>/);
  await api("task.close", { id: chat, outcome: "done" });
  await api("task.close", { id, outcome: "done" });
});

// ---------------------------------------------------------------------------------------------------------------------
// the same path in a browser: app.js, the phone's width, its cookie

test("app.js at 390 px: pick the project, send, watch the reply arrive, the task card, a merge approved by tapping", {
  skip: noBrowser,
}, async (t) => {
  const browser: Browser = await launch({
    userDataDir: join(fake, "chromium"),
    caCert: join(paths.ca(), "hosts", `${HOST}.crt`), // the leaf: the listener serves no chain to pin the CA by
    args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`],
  });
  t.after(() => browser.close());
  const cdp: Cdp = await connect(browser);
  t.after(() => cdp.close());
  const session = await page(cdp);
  for (const m of ["Page.enable", "Network.enable", "Runtime.enable"]) await cdp.send(m, {}, session);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    session,
  );
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true }, session);
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
    assert.fail(`timed out: ${expression}; body: ${await ev("document.body.innerText")}`);
  };
  const go = async (path: string) => {
    await cdp.send("Page.navigate", { url: origin + path }, session);
    await wait(
      `location.pathname + location.search === ${JSON.stringify(path)} && document.readyState === "complete" && !!document.querySelector("#msg")`,
    );
  };
  const fits = async (what: string) => {
    const [w, inner] = await ev<[number, number]>("[document.documentElement.scrollWidth, innerWidth]");
    assert.ok(w <= inner, `${what}: ${w} px wide in ${inner}`);
  };

  // webauthn.js against a virtual platform authenticator: enrol, sign out by losing the cookie, sign in
  await cdp.send("WebAuthn.enable", {}, session);
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
  const rpc = rpcClient(paths.socket());
  const { code } = (await rpc.call("enroll.code", {})) as { code: string };
  rpc.close();
  await go(`/enroll?code=${code}`);
  await fits("/enroll");
  await ev(`document.querySelector("#enroll button").click()`);
  await wait(`!document.querySelector("#enrolled").hidden`);
  await cdp.send("Network.clearBrowserCookies", {}, session);
  await go("/chat");
  await ev(`document.querySelector("#signin").click()`);
  await wait(`!!document.querySelector("nav")`);

  await go("/chat");
  await fits("/chat");
  await shot("chat-new");
  assert.equal(await ev(`document.querySelector("select[name=cwd]").options[2].textContent`), "notes");
  await ev(`document.querySelector("select[name=cwd]").value = ${JSON.stringify(notes)}`);
  await ev(
    `document.querySelector(".composer textarea").value = "!bash cd $CWD && echo three >> todo.txt && cat todo.txt"`,
  );
  await ev(`document.querySelector(".composer button").click()`);
  await wait(`/^\\/chat\\/./.test(location.pathname)`);
  await wait(`document.querySelector("#stream")?.textContent.includes("tool said: one")`);
  await wait(`document.querySelector("#chat-status").textContent.includes("waiting")`);
  await fits("the chat");
  await shot("chat");
  assert.equal(readFileSync(join(notes, "todo.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.deepEqual(await ev(`[...document.querySelectorAll("#stream .owner")].map((e) => e.textContent.slice(0, 5))`), [
    "!bash",
  ]);
  const id = (await ev<string>("location.pathname")).split("/")[2] as string;

  // a second message by the keyboard: the phone's Enter is a newline, Send sends
  await ev(`document.querySelector(".composer textarea").focus()`);
  await cdp.send("Input.insertText", { text: "line one" }, session);
  await cdp.send(
    "Input.dispatchKeyEvent",
    { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    session,
  );
  await cdp.send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    session,
  );
  await sleep(300);
  assert.equal(await ev(`document.querySelectorAll("#stream .owner").length`), 1, "Enter did not send");
  await ev(`document.querySelector(".composer button").click()`);
  await wait(`document.querySelectorAll("#stream .owner").length === 2`);
  await wait(`document.querySelector("#stream").textContent.includes("echo: line one")`);

  // a stream longer than the screen: the newest line is not under the sticky composer, on load or as it arrives
  const newestShows = `document.querySelector("#stream").lastElementChild.getBoundingClientRect().bottom <= document.querySelector(".composer").getBoundingClientRect().top + 1`;
  await ev(`document.querySelector(".composer textarea").value = "!bash seq 1 120"`);
  await ev(`document.querySelector(".composer button").click()`);
  await wait(`document.querySelector("#stream").textContent.includes("tool said: 1")`);
  await wait(`document.querySelector("#chat-status").textContent.includes("waiting")`);
  await sleep(200);
  await shot("long-live");
  assert.ok(await ev(newestShows), "the newest line, live");
  await go(`/chat/${id}`);
  await shot("long-load");
  assert.ok(await ev(newestShows), "the newest line, after a reload");

  // a gated request from that chat: its entry comes into view above the composer, one tap, the retry goes out
  const post = `curl -s --interface "$HORTUS_RPC_LOCAL" -H "Host: slack.com" -H "Authorization: Bearer hortus-secret-post" -H "Content-Type: application/json" -X POST "$HORTUS_RPC/api/chat.postMessage" -d '{"channel":"C2","text":"from the phone"}'`;
  await ev(`document.querySelector(".composer textarea").value = ${JSON.stringify(`!bash ${post}`)}`);
  await ev(`document.querySelector(".composer button").click()`);
  const approve = `document.querySelector('#approvals button[data-call="approval.decide"].ok')`;
  await wait(`!!${approve}`);
  await sleep(200);
  await shot("approval");
  assert.ok(
    await ev(
      `(() => { const r = ${approve}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= document.querySelector(".composer").getBoundingClientRect().top; })()`,
    ),
    "the Approve button is on screen",
  );
  await ev(`${approve}.click()`);
  await wait(`!${approve}`);
  await wait(`document.querySelector("#chat-status").textContent.includes("waiting")`);
  await ev(`document.querySelector(".composer textarea").value = ${JSON.stringify(`!bash ${post}`)}`);
  await ev(`document.querySelector(".composer button").click()`);
  await until(() => slack.calls.find((c) => c.params.text === "from the phone"), 20_000, "the post");

  await go("/");
  await fits("/");
  await go(`/tasks/${id}`);
  await fits("the task card");
  await shot("card");
  assert.match(await ev<string>(`document.querySelector("#card").innerText`), /Project\s+notes/);
  assert.match(await ev<string>(`document.querySelector("#card").innerText`), /tool said: one/);

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
  await ev(`document.querySelector('#a${entry.id} button[data-call="approval.decide"].ok').click()`);
  await wait(`document.querySelector("#a${entry.id}").textContent.includes("landed")`);
  await shot("landed");
  assert.equal(readFileSync(join(repo, "tapped.txt"), "utf8"), "hi\n");
});
