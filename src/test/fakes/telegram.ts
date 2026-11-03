/**
 * Fake Telegram Bot API (16-discord-telegram.md › Fakes): `/bot<token>/<method>` and `/file/bot<token>/<path>`, a
 * `getUpdates` long poll whose `offset` confirms (drops) earlier updates, `sendMessage` (a private chat only after its
 * user has messaged the bot), `getChatMember`, `getFile` (≤ 20 MB). The test handle mirrors the Slack fake's (`post`,
 * `edit`, `delete`, `react`, `join`, `replay`, `disconnect`). Like the real API, the bot's own messages are not updates.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as paths from "../../paths.ts";

export interface TUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}
export interface TChat {
  id: number;
  type: "private" | "group" | "supergroup";
  title?: string;
  username?: string;
  is_forum?: boolean;
}
export interface TMsg {
  message_id: number;
  chat: TChat;
  from?: TUser;
  date: number;
  edit_date?: number;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: TMsg;
  document?: { file_id: string; file_unique_id: string; file_name: string; file_size: number };
}
export interface PostOpts {
  user?: number;
  text?: string;
  /** reply to this message id */
  reply?: number;
  /** forum topic id */
  topic?: number;
  /** one document: `bytes` is served, `size` (default bytes.length) is what the API reports */
  file?: { name: string; bytes?: Buffer; size?: number };
  /** state only, no update */
  quiet?: boolean;
}
type Json = Record<string, unknown>;
export interface FakeChat extends TChat {
  members: Map<number, string>;
  messages: TMsg[];
  /** private: its user has messaged the bot */
  started?: boolean;
}
interface Update extends Json {
  update_id: number;
}

export class FakeTelegram {
  token = "123456:telegram-fake-token";
  bot: TUser = { id: 999, is_bot: true, first_name: "hortus", username: "hortus_bot" };
  users = new Map<number, TUser>([[999, this.bot]]);
  chats = new Map<number, FakeChat>();
  files = new Map<string, { path: string; bytes: Buffer; size: number }>();
  /** every API call with its params and Authorization header, in order */
  calls: { method: string; params: Json; authorization?: string }[] = [];
  /** updates not yet confirmed by an offset */
  queue: Update[] = [];
  /** every update ever emitted */
  sent: Update[] = [];
  /** getUpdates calls answered so far */
  polls = 0;
  url = "";
  private limits = new Map<string, number>();
  private waiters = new Set<() => void>();
  private again: Update[] = [];
  private n = 0;
  private date = 1_730_000_000;
  private server: Server;

  private constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, body, headers }) => {
          if (res.destroyed) return;
          res.writeHead(status, headers);
          res.end(body);
        },
        (e) => {
          res.writeHead(500);
          res.end(String(e));
        },
      );
    });
  }

  static async start(): Promise<FakeTelegram> {
    const f = new FakeTelegram();
    await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
    f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
    return f;
  }

  /** `dofs.<name>.api` */
  get api(): string {
    return this.url;
  }

  vault(name: string): Record<string, { type: "token"; value: string; transform: string }> {
    return { [name]: { type: "token", value: this.token, transform: "telegram" } };
  }

  async close(): Promise<void> {
    for (const w of this.waiters) w();
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  // ---- control surface -----------------------------------------------------------------------------------------

  user(id: number, username: string, extra: Partial<TUser> = {}): TUser {
    const u = { id, is_bot: false, first_name: username, username, ...extra };
    this.users.set(id, u);
    return u;
  }

  /** A group (members: id → status); a private chat's id is its user's id. */
  chat(id: number, opts: Partial<TChat> & { members?: Record<number, string> } = {}): FakeChat {
    const { members = {}, ...rest } = opts;
    const c: FakeChat = {
      id,
      type: id > 0 ? ("private" as const) : ("supergroup" as const),
      ...(id > 0 ? { username: this.users.get(id)?.username } : { title: `chat ${id}` }),
      ...rest,
      members: new Map(Object.entries(members).map(([k, v]) => [Number(k), v])),
      messages: [] as TMsg[],
    };
    if (id > 0) c.members.set(id, "member");
    c.members.set(this.bot.id, "administrator");
    this.chats.set(id, c);
    return c;
  }

  post(chat: number, o: PostOpts = {}): TMsg {
    const c = this.chats.get(chat) ?? this.chat(chat);
    const from = this.users.get(o.user ?? 0);
    const m: TMsg = { message_id: ++this.n, chat: this.pub(c), date: ++this.date };
    if (from) m.from = from;
    if (o.text !== undefined) m[o.file ? "caption" : "text"] = o.text;
    if (o.topic) Object.assign(m, { message_thread_id: o.topic, is_topic_message: true });
    if (o.reply) {
      const r = c.messages.find((x) => x.message_id === o.reply);
      if (r) m.reply_to_message = { ...r, reply_to_message: undefined };
    }
    if (o.file) {
      const id = `file-${++this.n}`;
      const size = o.file.size ?? o.file.bytes?.length ?? 0;
      this.files.set(id, { path: `documents/${id}`, bytes: o.file.bytes ?? Buffer.alloc(0), size });
      m.document = { file_id: id, file_unique_id: `u${id}`, file_name: o.file.name, file_size: size };
    }
    c.messages.push(m);
    if (from && chat === from.id) c.started = true;
    if (!o.quiet && from?.id !== this.bot.id) this.emit({ message: m });
    return m;
  }

  edit(chat: number, id: number, text: string): TMsg {
    const m = this.msg(chat, id);
    m.text = text;
    m.edit_date = ++this.date;
    this.emit({ edited_message: { ...m } });
    return m;
  }

  /** Telegram sends no update for deletions: state only. */
  delete(chat: number, id: number): void {
    const c = this.chats.get(chat);
    if (c) c.messages = c.messages.filter((x) => x.message_id !== id);
  }

  react(chat: number, id: number, user: number, emoji: string, remove = false): void {
    const m = this.msg(chat, id);
    const r = [{ type: "emoji", emoji }];
    this.emit({
      message_reaction: {
        chat: m.chat,
        message_id: id,
        user: this.users.get(user),
        date: ++this.date,
        old_reaction: remove ? r : [],
        new_reaction: remove ? [] : r,
      },
    });
  }

  /** `user` joins `chat` (chat_member); the bot joining is my_chat_member. */
  join(chat: number, user: number, status = "member"): void {
    const c = this.chats.get(chat) ?? this.chat(chat);
    const old = c.members.get(user) ?? "left";
    c.members.set(user, status);
    const u = this.users.get(user);
    const change = {
      chat: this.pub(c),
      from: u,
      date: ++this.date,
      old_chat_member: { user: u, status: old },
      new_chat_member: { user: u, status },
    };
    this.emit(user === this.bot.id ? { my_chat_member: change } : { chat_member: change });
  }

  emit(u: Json): Update {
    const up = { update_id: 100_000 + this.sent.length + 1, ...u };
    this.sent.push(up);
    this.queue.push(up);
    this.wake();
    return up;
  }

  /** Deliver the last update once more on the next poll, whatever the offset (a redelivery). */
  replay(): void {
    const u = this.sent.at(-1);
    if (!u) throw new Error("nothing to replay");
    this.again.push(u);
    this.wake();
  }

  /** Drop every open connection (the in-flight long poll fails). */
  disconnect(): void {
    this.server.closeAllConnections();
  }

  /** The next `times` calls to `method` answer 429 with retry_after: 1. */
  rateLimit(method: string, times: number): void {
    this.limits.set(method, times);
  }

  // ---- HTTP ----------------------------------------------------------------------------------------------------

  private wake(): void {
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  private pub(c: TChat): TChat {
    const { id, type, title, username, is_forum } = c;
    return {
      id,
      type,
      ...(title ? { title } : {}),
      ...(username ? { username } : {}),
      ...(is_forum ? { is_forum } : {}),
    };
  }

  private msg(chat: number, id: number): TMsg {
    const m = this.chats.get(chat)?.messages.find((x) => x.message_id === id);
    if (!m) throw new Error(`no message ${chat}/${id}`);
    return m;
  }

  private async handle(
    req: IncomingMessage,
  ): Promise<{ status: number; body: string | Buffer; headers?: Record<string, string> }> {
    const u = new URL(req.url ?? "/", this.url);
    const json = (v: Json, status = 200) => ({
      status,
      body: JSON.stringify(v),
      headers: { "content-type": "application/json" },
    });
    const file = u.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (file) {
      if (file[1] !== this.token) return json({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
      const f = [...this.files.values()].find((x) => x.path === file[2]);
      return f ? { status: 200, body: f.bytes } : { status: 404, body: "not found" };
    }
    const m = u.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m?.[2]) return json({ ok: false, error_code: 404, description: "Not Found" }, 404);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const params: Json = Object.fromEntries(u.searchParams);
    if (raw) Object.assign(params, JSON.parse(raw));
    const method = m[2];
    this.calls.push({ method, params, authorization: req.headers.authorization });
    if (m[1] !== this.token) return json({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
    const left = this.limits.get(method) ?? 0;
    if (left > 0) {
      this.limits.set(method, left - 1);
      return json(
        { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } },
        429,
      );
    }
    const r = await this.call(method, params, req);
    return json(r, r.ok ? 200 : Number(r.error_code ?? 400));
  }

  private async call(method: string, p: Json, req: IncomingMessage): Promise<Json> {
    const bad = (description: string, error_code = 400) => ({ ok: false, error_code, description });
    switch (method) {
      case "getMe":
        return { ok: true, result: this.bot };
      case "getUpdates": {
        const offset = Number(p.offset ?? 0);
        if (offset) this.queue = this.queue.filter((x) => x.update_id >= offset);
        const again = this.again.splice(0);
        if (again.length) return { ok: true, result: [...again, ...this.queue] };
        if (!this.queue.length && Number(p.timeout ?? 0) > 0) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, Number(p.timeout) * 1000);
            const done = () => {
              clearTimeout(t);
              resolve();
            };
            this.waiters.add(done);
            req.socket.once("close", done);
          });
        }
        this.polls++;
        return { ok: true, result: [...this.queue] };
      }
      case "getChatMember": {
        const c = this.chats.get(Number(p.chat_id));
        if (!c) return bad("Bad Request: chat not found");
        const user = this.users.get(Number(p.user_id));
        return { ok: true, result: { user, status: c.members.get(Number(p.user_id)) ?? "left" } };
      }
      case "getFile": {
        const f = this.files.get(String(p.file_id));
        if (!f) return bad("Bad Request: invalid file_id");
        if (f.size > 20 * 1024 * 1024) return bad("Bad Request: file is too big");
        return { ok: true, result: { file_id: p.file_id, file_size: f.size, file_path: f.path } };
      }
      case "sendMessage": {
        const id = Number(p.chat_id);
        const c = this.chats.get(id);
        if (!c) return bad("Bad Request: chat not found");
        if (c.type === "private" && !c.started)
          return bad("Forbidden: bot can't initiate conversation with a user", 403);
        const reply = (p.reply_parameters as { message_id?: number } | undefined)?.message_id;
        const m = this.post(id, {
          user: this.bot.id,
          text: String(p.text ?? ""),
          reply,
          topic: p.message_thread_id as number,
        });
        return { ok: true, result: m };
      }
      case "deleteMessage":
        this.delete(Number(p.chat_id), Number(p.message_id));
        return { ok: true, result: true };
      case "leaveChat":
        return { ok: true, result: true };
      default:
        return bad("Not Found: method not found", 404);
    }
  }
}

/**
 * Test-only stand-in for the pipeline's `path:/bot{}/` swap (step 1's `directFetch` handles only Authorization): the
 * vault.json value replaces `bothortus-secret-<name>` in the URL path.
 */
export function directPathFetch(names: string[]): (url: string, init?: RequestInit) => Promise<Response> {
  return (url, init) => {
    const vault = JSON.parse(readFileSync(paths.vault(), "utf8")) as Record<string, { value?: string }>;
    const swap = (m: string, n: string) => (names.includes(n) && vault[n]?.value ? `/bot${vault[n].value}/` : m);
    return fetch(url.replace(/\/bothortus-secret-([a-z0-9_-]+)\//, swap), init);
  };
}
