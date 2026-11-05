/**
 * Fake Discord (16-discord-telegram.md › Fakes): the REST routes the connector uses under `/api/v10`, attachment
 * downloads, and the gateway WebSocket at `/gateway` (HELLO, heartbeat ACK, IDENTIFY with a token check, READY and
 * GUILD_CREATE, dispatches with increasing `s` per session, RESUME replaying what the session missed, INVALID_SESSION).
 * The test handle mirrors the Slack fake's (`post`, `edit`, `delete`, `react`, `join`, `replay`, `disconnect`).
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import * as paths from "../../paths.ts";

export interface DUser {
  id: string;
  username: string;
  bot?: boolean;
}
export interface DAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
}
export interface DMsg {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DUser;
  member?: { roles: string[] };
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  type: number;
  attachments: DAttachment[];
  message_reference?: { message_id: string; channel_id: string };
  reactions?: { emoji: { id: string | null; name: string }; count: number }[];
  message_snapshots?: { message: { content: string } }[];
}
export interface DChannel {
  id: string;
  type: number;
  name?: string;
  topic?: string | null;
  guild_id?: string;
  parent_id?: string;
  recipients?: DUser[];
  thread_metadata?: { archived: boolean; archive_timestamp?: string };
  /** the bot lacks READ_MESSAGE_HISTORY here: 403 on its archived threads and messages */
  hidden?: boolean;
  messages: DMsg[];
  /** per emoji key → user ids, per message */
  reacts: Map<string, Map<string, string[]>>;
}
export interface PostOpts {
  user?: string;
  text?: string;
  /** reply to this message id (message_reference) */
  reply?: string;
  /** `bytes` is served; `size` (default bytes.length) is what the API reports */
  files?: { name: string; bytes?: Buffer; size?: number }[];
  /** a forward of this text: `content` stays empty, the text is in `message_snapshots` */
  forward?: string;
  /** state only, no dispatch (history fixtures) */
  quiet?: boolean;
  /** a forum post's first message has its thread's id */
  id?: string;
}
interface Frame {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}
interface Session {
  id: string;
  seq: number;
  log: Frame[];
  ws?: WebSocket;
}
type Json = Record<string, unknown>;

const GUILD = "1000";
const isThread = (c: DChannel) => c.type === 10 || c.type === 11 || c.type === 12;
const cmpId = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

export class FakeDiscord {
  token = "discord-fake-bot-token";
  botUser = "100";
  guild = GUILD;
  users = new Map<string, DUser>([["100", { id: "100", username: "hortus", bot: true }]]);
  /** guild member ids */
  members = new Set<string>(["100"]);
  channels = new Map<string, DChannel>();
  files = new Map<string, Buffer>();
  /** every REST call, in order */
  calls: { method: string; path: string; body: Json; userAgent?: string }[] = [];
  /** interaction callbacks received: id and the time since dispatch */
  callbacks: { id: string; type: number; ms: number }[] = [];
  /** tokens received in IDENTIFY / RESUME frames, in order */
  identifies: { op: number; token: string }[] = [];
  /** every frame received from clients */
  received: Frame[] = [];
  /** binary frames received */
  binary: Buffer[] = [];
  sessions = new Map<string, Session>();
  connects = 0;
  heartbeatMs = 41_250;
  /** send HELLO on connect */
  hello = true;
  /** `GET /gateway/bot` answers this when set (proxy tests point it at `wss://gateway.discord.gg`) */
  gatewayUrl?: string;
  /** READY's `resume_gateway_url` when set: a session-specific host, not the one connected to */
  resumeUrl?: string;
  /** the Host of every gateway connection, in order */
  hosts: string[] = [];
  /** close every IDENTIFY with this code (4014: a privileged intent not enabled in the portal) */
  closeOnIdentify = 0;
  /** archived threads per page (`has_more`) */
  archivedPage = 100;
  pageSize = 100;
  url = "";
  private limits = new Map<string, number>();
  private pending: Frame[] = [];
  private live?: Session;
  private interactionAt = new Map<string, number>();
  private n = 2000;
  private server: Server;
  private wss: WebSocketServer;

  private constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, body, headers }) => {
          res.writeHead(status, headers);
          res.end(body);
        },
        (e) => {
          res.writeHead(500);
          res.end(String(e));
        },
      );
    });
    // any path: the real gateway URL has none, the default one here is `/gateway`
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (ws, req) => {
      this.hosts.push(req.headers.host ?? "");
      this.connection(ws);
    });
  }

  static async start(): Promise<FakeDiscord> {
    const f = new FakeDiscord();
    await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
    f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
    return f;
  }

  /** `dofs.<name>.api` */
  get api(): string {
    return `${this.url}/api/v10`;
  }

  vault(name: string): Record<string, { type: "token"; value: string; transform: string }> {
    return { [name]: { type: "token", value: this.token, transform: "discord" } };
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise((r) => this.wss.close(r));
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  // ---- control surface -----------------------------------------------------------------------------------------

  user(id: string, username: string, extra: Partial<DUser> & { member?: boolean } = {}): DUser {
    const { member = true, ...rest } = extra;
    const u = { id, username, ...rest };
    this.users.set(id, u);
    if (member) this.members.add(id);
    return u;
  }

  /** A guild text channel (type 0); `quiet: false` dispatches CHANNEL_CREATE. */
  channel(id: string, opts: Partial<Omit<DChannel, "id" | "messages" | "reacts">> & { quiet?: boolean } = {}) {
    const { quiet = true, ...rest } = opts;
    const c: DChannel = {
      id,
      type: 0,
      name: `chan-${id}`,
      topic: null,
      guild_id: this.guild,
      messages: [],
      reacts: new Map(),
      ...rest,
    };
    this.channels.set(id, c);
    if (!quiet) this.dispatch("CHANNEL_CREATE", this.chan(c));
    return c;
  }

  /** A public thread under `parent`, started from message `from` (thread id = message id) or standalone. */
  thread(parent: string, opts: { from?: string; name?: string; quiet?: boolean } = {}): DChannel {
    const id = opts.from ?? this.id();
    const c = this.channel(id, { type: 11, parent_id: parent, name: opts.name ?? `thread-${id}` });
    c.thread_metadata = { archived: false };
    if (!opts.quiet) this.dispatch("THREAD_CREATE", { ...this.chan(c), newly_created: true });
    return c;
  }

  post(channel: string, o: PostOpts = {}): DMsg {
    const c = this.must(channel);
    const author = this.users.get(o.user ?? "") ?? { id: o.user ?? "0", username: o.user ?? "?" };
    const guild = c.guild_id ?? (c.parent_id ? this.channels.get(c.parent_id)?.guild_id : undefined);
    const m: DMsg = {
      id: o.id ?? this.id(),
      channel_id: channel,
      author,
      content: o.text ?? "",
      timestamp: this.now(),
      edited_timestamp: null,
      type: o.reply ? 19 : 0,
      attachments: (o.files ?? []).map((f) => {
        const id = this.id();
        this.files.set(id, f.bytes ?? Buffer.alloc(0));
        return { id, filename: f.name, size: f.size ?? f.bytes?.length ?? 0, url: `${this.url}/attachments/${id}` };
      }),
    };
    if (guild) m.guild_id = guild;
    if (guild && this.members.has(author.id)) m.member = { roles: [] };
    if (o.reply) m.message_reference = { message_id: o.reply, channel_id: channel };
    if (o.forward) m.message_snapshots = [{ message: { content: o.forward } }];
    c.messages.push(m);
    if (!o.quiet) this.dispatch("MESSAGE_CREATE", this.msgOut(c, m));
    return m;
  }

  edit(channel: string, id: string, text: string): DMsg {
    const c = this.must(channel);
    const m = this.msg(channel, id);
    m.content = text;
    m.edited_timestamp = this.now();
    this.dispatch("MESSAGE_UPDATE", this.msgOut(c, m));
    return m;
  }

  delete(channel: string, id: string): void {
    const c = this.must(channel);
    const m = this.msg(channel, id);
    c.messages = c.messages.filter((x) => x !== m);
    this.dispatch("MESSAGE_DELETE", { id, channel_id: channel, ...(m.guild_id ? { guild_id: m.guild_id } : {}) });
  }

  react(channel: string, id: string, user: string, emoji: string, remove = false): void {
    const c = this.must(channel);
    this.msg(channel, id);
    const per = c.reacts.get(id) ?? new Map<string, string[]>();
    const list = per.get(emoji) ?? [];
    per.set(emoji, remove ? list.filter((u) => u !== user) : [...new Set([...list, user])]);
    if (!per.get(emoji)?.length) per.delete(emoji);
    c.reacts.set(id, per);
    const d: Json = { user_id: user, channel_id: channel, message_id: id, emoji: { id: null, name: emoji } };
    if (c.guild_id) d.guild_id = c.guild_id;
    if (c.guild_id && !remove && this.members.has(user)) d.member = { roles: [] };
    this.dispatch(remove ? "MESSAGE_REACTION_REMOVE" : "MESSAGE_REACTION_ADD", d);
  }

  /** MESSAGE_DELETE_BULK */
  bulkDelete(channel: string, ids: string[]): void {
    const c = this.must(channel);
    c.messages = c.messages.filter((x) => !ids.includes(x.id));
    this.dispatch("MESSAGE_DELETE_BULK", { ids, channel_id: channel, guild_id: c.guild_id });
  }

  /** MESSAGE_REACTION_REMOVE_ALL */
  clearReactions(channel: string, id: string): void {
    const c = this.must(channel);
    c.reacts.delete(id);
    this.dispatch("MESSAGE_REACTION_REMOVE_ALL", { channel_id: channel, message_id: id, guild_id: c.guild_id });
  }

  /** Someone joins a thread: THREAD_MEMBERS_UPDATE, whose `id` is the thread and which is no channel object. */
  threadJoin(thread: string, user: string): void {
    const m = { id: thread, user_id: user, join_timestamp: this.now(), flags: 0 };
    this.dispatch("THREAD_MEMBERS_UPDATE", { id: thread, guild_id: this.guild, member_count: 2, added_members: [m] });
  }

  /** A guild member joins: GUILD_MEMBER_ADD. */
  join(user: string): void {
    this.members.add(user);
    const u = this.users.get(user) ?? { id: user, username: user };
    this.dispatch("GUILD_MEMBER_ADD", { guild_id: this.guild, user: u, roles: [] });
  }

  /** A slash-command interaction; the connector must call back within 3 s. */
  interaction(user: string, channel: string): string {
    const id = this.id();
    this.interactionAt.set(id, Date.now());
    const u = this.users.get(user) ?? { id: user, username: user };
    this.dispatch("INTERACTION_CREATE", { id, token: `itok-${id}`, type: 2, channel_id: channel, member: { user: u } });
    return id;
  }

  /** Dispatch on the live session (or queue it until the next READY when there is none). */
  dispatch(t: string, d: unknown): Frame {
    const s = this.live;
    if (!s) {
      const f = { op: 0, t, d, s: null };
      this.pending.push(f);
      return f;
    }
    const f = { op: 0, t, d, s: ++s.seq };
    s.log.push(f);
    s.ws?.send(JSON.stringify(f));
    return f;
  }

  /** Resend the last event dispatch (not READY/RESUMED) of the live session as is (same `s`). */
  replay(): void {
    const s = this.live;
    const f = s?.log.filter((x) => x.t !== "READY" && x.t !== "RESUMED").at(-1);
    if (!s?.ws || !f) throw new Error("nothing to replay");
    s.ws.send(JSON.stringify(f));
  }

  /** Drop the gateway connection (resumable close 4000): the client should RESUME. */
  disconnect(code = 4000): void {
    for (const ws of this.wss.clients) ws.close(code, "reconnect");
    if (this.live) this.live.ws = undefined;
  }

  /** INVALID_SESSION (not resumable): the client must IDENTIFY again. */
  invalidate(): void {
    const s = this.live;
    if (!s) return;
    this.sessions.delete(s.id);
    this.live = undefined;
    s.ws?.send(JSON.stringify({ op: 9, d: false }));
  }

  /** The next `times` calls to `route` ("GET /channels/:id/messages" matched by prefix) answer 429. */
  rateLimit(route: string, times: number): void {
    this.limits.set(route, times);
  }

  // ---- gateway -------------------------------------------------------------------------------------------------

  private connection(ws: WebSocket): void {
    this.connects++;
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return void this.binary.push(Buffer.from(raw as Buffer));
      const f = JSON.parse(String(raw)) as Frame;
      this.received.push(f);
      const d = (f.d ?? {}) as Json;
      if (f.op === 1) ws.send(JSON.stringify({ op: 11, d: null }));
      else if (f.op === 2 || f.op === 6) {
        this.identifies.push({ op: f.op, token: String(d.token) });
        if (d.token !== this.token) return ws.close(4004, "Authentication failed.");
        if (f.op === 2 && this.closeOnIdentify) return ws.close(this.closeOnIdentify, "Disallowed intent(s).");
        if (f.op === 2) this.ready(ws);
        else this.resume(ws, String(d.session_id), Number(d.seq ?? 0));
      }
    });
    ws.on("close", () => {
      if (this.live?.ws === ws) this.live.ws = undefined;
    });
    if (this.hello) ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: this.heartbeatMs } }));
  }

  private ready(ws: WebSocket): void {
    const s: Session = { id: `sess-${this.id()}`, seq: 0, log: [], ws };
    this.sessions.set(s.id, s);
    this.live = s;
    const bot = this.users.get(this.botUser);
    this.dispatch("READY", {
      v: 10,
      user: bot,
      session_id: s.id,
      resume_gateway_url: this.resumeUrl ?? this.wsUrl(),
      guilds: [{ id: this.guild, unavailable: true }],
    });
    const all = [...this.channels.values()].filter((c) => c.guild_id === this.guild);
    this.dispatch("GUILD_CREATE", {
      id: this.guild,
      name: "guild",
      channels: all.filter((c) => !isThread(c)).map((c) => this.chan(c)),
      threads: all.filter((c) => isThread(c) && !c.thread_metadata?.archived).map((c) => this.chan(c)),
    });
    for (const f of this.pending.splice(0)) this.dispatch(String(f.t), f.d);
  }

  private resume(ws: WebSocket, id: string, seq: number): void {
    const s = this.sessions.get(id);
    if (!s) return void ws.send(JSON.stringify({ op: 9, d: false }));
    s.ws = ws;
    this.live = s;
    for (const f of s.log) if ((f.s ?? 0) > seq) ws.send(JSON.stringify(f));
    this.dispatch("RESUMED", null);
  }

  private wsUrl(): string {
    return this.gatewayUrl ?? `${this.url.replace("http", "ws")}/gateway`;
  }

  // ---- REST ----------------------------------------------------------------------------------------------------

  private id(): string {
    return String(++this.n * 1_000_000);
  }

  private now(): string {
    return new Date(1_730_000_000_000 + this.n * 1000).toISOString().replace("Z", "+00:00");
  }

  private must(channel: string): DChannel {
    const c = this.channels.get(channel);
    if (!c) throw new Error(`no channel ${channel}`);
    return c;
  }

  private msg(channel: string, id: string): DMsg {
    const m = this.must(channel).messages.find((x) => x.id === id);
    if (!m) throw new Error(`no message ${channel}/${id}`);
    return m;
  }

  private chan(c: DChannel): Json {
    const { messages: _m, reacts: _r, hidden: _h, ...rest } = c;
    return rest;
  }

  private msgOut(c: DChannel, m: DMsg): DMsg {
    const per = c.reacts.get(m.id);
    if (!per?.size) return { ...m };
    return { ...m, reactions: [...per].map(([name, us]) => ({ emoji: { id: null, name }, count: us.length })) };
  }

  private async handle(
    req: IncomingMessage,
  ): Promise<{ status: number; body: string | Buffer; headers?: Record<string, string> }> {
    const u = new URL(req.url ?? "/", this.url);
    const att = u.pathname.match(/^\/attachments\/(\d+)$/);
    if (att?.[1]) {
      const bytes = this.files.get(att[1]);
      return bytes ? { status: 200, body: bytes } : { status: 404, body: "not found" };
    }
    const path = u.pathname.replace(/^\/api\/v10/, "");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = (raw ? JSON.parse(raw) : {}) as Json;
    const method = req.method ?? "GET";
    this.calls.push({ method, path: path + u.search, body, userAgent: req.headers["user-agent"] });
    for (const [route, left] of this.limits) {
      if (left > 0 && `${method} ${path}`.startsWith(route)) {
        this.limits.set(route, left - 1);
        return { status: 429, body: JSON.stringify({ retry_after: 1 }), headers: { "retry-after": "1" } };
      }
    }
    const json = (v: unknown, status = 200) => ({
      status,
      body: JSON.stringify(v),
      headers: { "content-type": "application/json" },
    });
    // the interaction callback carries no bot token (the interaction token authorizes it)
    const cb = path.match(/^\/interactions\/(\d+)\/([^/]+)\/callback$/);
    if (cb?.[1] && method === "POST") {
      const at = this.interactionAt.get(cb[1]);
      if (!at || cb[2] !== `itok-${cb[1]}`) return json({ message: "Unknown interaction", code: 10062 }, 404);
      this.callbacks.push({ id: cb[1], type: Number(body.type), ms: Date.now() - at });
      return { status: 204, body: "" };
    }
    if (req.headers.authorization !== `Bot ${this.token}`) return json({ message: "401: Unauthorized", code: 0 }, 401);
    const seg = path.split("/");
    if (seg[1] === "channels" && this.channels.get(seg[2] ?? "")?.hidden)
      return json({ message: "Missing Access", code: 50001 }, 403);
    const r = this.route(method, path, u.searchParams, body);
    return r === undefined ? json({ message: "404: Not Found", code: 0 }, 404) : json(r);
  }

  private route(method: string, path: string, q: URLSearchParams, body: Json): unknown {
    const seg = path.split("/").filter(Boolean);
    const c = seg[0] === "channels" && seg[1] ? this.channels.get(seg[1]) : undefined;
    const isId = (s: string, i: number) => /^\d+$/.test(s) || (i === 5 && seg[4] === "reactions");
    const key = `${method} /${seg.map((s, i) => (isId(s, i) ? ":id" : s)).join("/")}`;
    switch (key) {
      case "GET /gateway/bot":
        return { url: this.wsUrl(), shards: 1 };
      case "GET /users/@me":
        return this.users.get(this.botUser);
      case "GET /users/@me/guilds":
        return [{ id: this.guild, name: "guild" }];
      case "GET /guilds/:id/members/:id":
        return this.members.has(seg[3] ?? "") ? { user: this.users.get(seg[3] ?? ""), roles: [] } : undefined;
      case "GET /guilds/:id/channels":
        return [...this.channels.values()]
          .filter((x) => x.guild_id === seg[1] && !isThread(x))
          .map((x) => this.chan(x));
      case "GET /guilds/:id/threads/active":
        return {
          threads: [...this.channels.values()]
            .filter((x) => x.guild_id === seg[1] && isThread(x) && !x.thread_metadata?.archived)
            .map((x) => this.chan(x)),
        };
      case "GET /channels/:id/threads/archived/public": {
        // newest archive first, `before` an archive_timestamp
        const stamp = (x: DChannel) => x.thread_metadata?.archive_timestamp ?? "";
        const before = q.get("before");
        const all = [...this.channels.values()]
          .filter((x) => x.parent_id === seg[1] && x.thread_metadata?.archived && (!before || stamp(x) < before))
          .sort((a, b) => stamp(b).localeCompare(stamp(a)));
        const limit = Math.min(Number(q.get("limit") ?? 50), this.archivedPage);
        return { threads: all.slice(0, limit).map((x) => this.chan(x)), has_more: all.length > limit };
      }
      case "GET /channels/:id":
        return c && this.chan(c);
      case "GET /channels/:id/messages": {
        if (!c) return undefined;
        const after = q.get("after") ?? "0";
        const limit = Math.min(Number(q.get("limit") ?? 50), this.pageSize);
        // the `limit` oldest after `after`, newest first (as Discord answers)
        return c.messages
          .filter((m) => cmpId(m.id, after) > 0)
          .sort((a, b) => cmpId(a.id, b.id))
          .slice(0, limit)
          .reverse()
          .map((m) => this.msgOut(c, m));
      }
      case "GET /channels/:id/messages/:id": {
        const m = c?.messages.find((x) => x.id === seg[3]);
        return c && m && this.msgOut(c, m);
      }
      case "GET /channels/:id/messages/:id/reactions/:id": {
        const ids = c?.reacts.get(seg[3] ?? "")?.get(decodeURIComponent(seg[5] ?? "")) ?? [];
        return ids.map((id) => this.users.get(id) ?? { id, username: id });
      }
      case "POST /channels/:id/messages": {
        if (!c) return undefined;
        const ref = (body.message_reference as { message_id?: string } | undefined)?.message_id;
        return this.post(c.id, { user: this.botUser, text: String(body.content ?? ""), reply: ref });
      }
      case "POST /users/@me/channels": {
        const rid = String(body.recipient_id);
        const found = [...this.channels.values()].find((x) => x.type === 1 && x.recipients?.[0]?.id === rid);
        const dm =
          found ??
          this.channel(`9${rid}`, {
            type: 1,
            name: undefined,
            guild_id: undefined,
            recipients: [this.users.get(rid) ?? { id: rid, username: rid }],
          });
        return this.chan(dm);
      }
      case "DELETE /channels/:id/messages/:id":
        if (!c) return undefined;
        this.delete(c.id, seg[3] ?? "");
        return {};
      default:
        return undefined;
    }
  }
}

/** Test-only stand-in for the proxy's `ws:text` swap (step 1's `directFetch` for frames): vault.json values. */
export function directSocket(names: string[]): (url: string) => globalThis.WebSocket {
  return (url) => {
    const ws = new globalThis.WebSocket(url);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      const vault = JSON.parse(readFileSync(paths.vault(), "utf8")) as Record<string, { value?: string }>;
      const swap = (m: string, n: string) => (names.includes(n) && vault[n]?.value) || m;
      send(typeof data === "string" ? data.replace(/hortus-secret-([a-z0-9_-]+)/g, swap) : data);
    };
    return ws;
  };
}
