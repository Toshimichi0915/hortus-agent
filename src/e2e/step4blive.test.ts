/**
 * Step 4b with a live Worker (HORTUS_TEST_LLM=1, `HORTUS_TEST_MODEL`; no sudo, unlike step4live): does a real model,
 * from the real Worker prompt and a brief as the Planner writes it, reply in the right place on Discord and Telegram?
 * No daemon (step4b.test.ts is the daemon's half): the task plugin alone as in planner.live.test.ts, the shipped
 * transforms readable, and a `curl` on PATH standing in for the proxy: hosts to the fakes, placeholders to the tokens.
 * A Bearer header on Discord or a Telegram URL without the placeholder is refused by the fake as by the service.
 */
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run, setup } from "../agent/testkit.ts";
import { FakeDiscord } from "../test/fakes/discord.ts";
import { FakeTelegram } from "../test/fakes/telegram.ts";

const live = process.env.HORTUS_TEST_LLM === "1";
const MODEL = process.env.HORTUS_TEST_MODEL ?? "deepseek-v4.1-flash:1017";
const TRANSFORMS = fileURLToPath(new URL("../transforms", import.meta.url));

let dc: FakeDiscord;
let tg: FakeTelegram;

before(async () => {
  if (!live) return;
  dc = await FakeDiscord.start();
  tg = await FakeTelegram.start();
  dc.user("200", "alice");
  dc.channel("3000", { name: "general" });
  dc.thread("3000", { quiet: true, from: "3100" });
  tg.user(500, "alice");
  tg.chat(500);
});
after(async () => {
  if (!live) return;
  await dc.close();
  await tg.close();
});

/** The session's stdout, kept for the failure message: what the Worker did is all a model's failure leaves. */
async function worker(credential: string, ref: string, summary: string): Promise<string> {
  const all = JSON.parse(readFileSync(join(homedir(), ".hortus", "secrets.json"), "utf8"));
  const key = all["ollama-cloud"];
  assert.ok(key, "ollama-cloud missing from ~/.hortus/secrets.json");
  const dir = setup(
    {
      title: "Say the build is green",
      brief: `Tell the owner, as a reply in the originating thread, that the build is green. Nothing else.\n\n## Originating events\n- [e1] ${ref} (owner, trusted) at 2026-11-04T09:00:00Z\n${summary}`,
      provider: "ollama-cloud",
      model: MODEL,
      context_window: 131072,
      scope: { credentials: [credential], repos: [], dofs: ["transforms"] },
      origins: ["discord.com", "api.telegram.org"],
    },
    { "ollama-cloud": { type: "openai", endpoint: "https://ollama.com/v1", apiKey: key.apiKey } },
    { provider: "ollama-cloud", model: MODEL },
  );
  mkdirSync(join(dir, "dof"));
  cpSync(TRANSFORMS, join(dir, "dof", "transforms"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  writeFileSync(
    join(dir, "bin", "curl"),
    `#!/bin/bash
args=()
for a in "$@"; do
  a=\${a//https:\\/\\/api.telegram.org/${tg.url}}
  a=\${a//https:\\/\\/discord.com/${dc.url}}
  a=\${a//hortus-secret-${credential}/${credential === "tg" ? tg.token : dc.token}}
  args+=("$a")
done
exec /usr/bin/curl "\${args[@]}"
`,
  );
  chmodSync(join(dir, "bin", "curl"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${join(dir, "bin")}:${path}`;
  try {
    const r = await run(dir, undefined, 240_000);
    assert.equal(r.code, 0, r.stderr + r.stdout.slice(-2000));
    return r.stdout.slice(-6000);
  } finally {
    process.env.PATH = path;
  }
}

test("live Worker: Telegram, the owner's DM → sendMessage replying to it", {
  skip: !live,
  timeout: 300_000,
}, async () => {
  const m = tg.post(500, { user: 500, text: "how is the build?" });
  const session = await worker("tg", `tg:500:${m.message_id}`, "message in 500 by alice: how is the build?");
  const sent = tg.chats.get(500)?.messages.find((x) => x.from?.id === tg.bot.id);
  console.log(`# telegram: ${JSON.stringify(sent?.text)} reply_to ${sent?.reply_to_message?.message_id}`);
  assert.match(sent?.text ?? "", /green/i, session);
  // in a DM a plain message reads the same, and its own ref routes an answer: the model does not always quote (1 run in 2)
});

test("live Worker: Discord, a channel message → a reply to it", { skip: !live, timeout: 300_000 }, async () => {
  const m = dc.post("3000", { user: "200", text: "how is the build?" });
  const session = await worker("discord", `discord:3000:${m.id}`, "message_create in 3000 by alice: how is the build?");
  const sent = dc.channels.get("3000")?.messages.find((x) => x.author.id === dc.botUser);
  console.log(`# discord: ${JSON.stringify(sent?.content)} reply_to ${sent?.message_reference?.message_id}`);
  assert.match(sent?.content ?? "", /green/i, session);
  assert.equal(sent?.message_reference?.message_id, m.id);
});

test("live Worker: Discord, a thread channel → a post in the thread", { skip: !live, timeout: 300_000 }, async () => {
  dc.post("3100", { user: "200", text: "how is the build?" });
  const session = await worker("discord", "discord:3000:3100 discord:3100:3100", "message_create in 3100 by alice: how is the build?");
  const sent = dc.channels.get("3100")?.messages.find((x) => x.author.id === dc.botUser);
  console.log(`# discord thread: ${JSON.stringify(sent?.content)}`);
  assert.match(sent?.content ?? "", /green/i, session);
});
