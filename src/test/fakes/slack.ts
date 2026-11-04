/**
 * Fake Slack (02-slack-gateway.md › Fake Slack): the Web API methods the connector uses, file downloads and Socket
 * Mode on one port, in-memory state. The test handle (`post`, `edit`, `delete`, `react`, `join`, `replay`,
 * `disconnect`) mutates state and emits the matching event; it is the template for the other fakes.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

export interface FakeUser {
  id: string;
  name: string;
  is_bot?: boolean;
  is_restricted?: boolean;
}
export interface FakeFile {
  id: string;
  name: string;
  size: number;
  url_private_download: string;
}
export interface FakeMsg {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  subtype?: string;
  files?: FakeFile[];
  reactions?: { name: string; users: string[]; count: number }[];
  reply_count?: number;
  edited?: { user: string; ts: string };
}
export interface FakeChannel {
  id: string;
  name: string;
  is_im: boolean;
  is_private: boolean;
  is_archived: boolean;
  topic: { value: string };
  members: string[];
  user?: string;
  messages: FakeMsg[];
}
export interface PostOpts {
  user?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  subtype?: string;
  /** `bytes` is served; `size` (default bytes.length) is what the API reports */
  files?: { name: string; bytes?: Buffer; size?: number }[];
  /** state only, no event (history fixtures) */
  quiet?: boolean;
}
type Params = Record<string, string>;
interface Envelope {
  envelope_id: string;
  type: string;
  accepts_response_payload: boolean;
  payload: { type: "event_callback"; event_id: string; event_time: number; event: Record<string, unknown> };
}

const cmpTs = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const isTop = (m: FakeMsg) => !m.thread_ts || m.thread_ts === m.ts || m.subtype === "thread_broadcast";

export class FakeSlack {
  botToken = "xoxb-fake";
  appToken = "xapp-fake";
  botUser = "U_BOT";
  users: FakeUser[] = [{ id: "U_BOT", name: "hortus", is_bot: true }];
  channels = new Map<string, FakeChannel>();
  files = new Map<string, Buffer>();
  /** envelope ids acked by the client, in order */
  acks: string[] = [];
  /** every API call, in order */
  calls: { method: string; params: Params }[] = [];
  /** every request's Authorization header (or ""), in order */
  auths: string[] = [];
  /** envelopes sent, by id (for replay) */
  sent = new Map<string, Envelope>();
  /** WebSocket connections accepted so far */
  connects = 0;
  /** send `hello` on connect */
  hello = true;
  /** `debug_info.approximate_connection_time` of `hello`, in seconds */
  connectionTime = 3600;
  /** API methods that take the request and never answer */
  stalled = new Set<string>();
  /** caps every page (pagination tests) */
  pageSize = 1000;
  /** the `Retry-After` of a `rateLimit` answer, in seconds */
  retryAfter = 1;
  url = "";
  private limits = new Map<string, number>();
  private sockets = new Set<WebSocket>();
  private pending: Envelope[] = [];
  private n = 0;
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
    this.wss = new WebSocketServer({ server: this.server, path: "/socket" });
    this.wss.on("connection", (ws) => {
      this.connects++;
      ws.on("message", (d) => {
        const id = (JSON.parse(String(d)) as { envelope_id?: string }).envelope_id;
        if (id) this.acks.push(id);
      });
      ws.on("close", () => this.sockets.delete(ws));
      if (!this.hello) return;
      this.sockets.add(ws);
      ws.send(
        JSON.stringify({
          type: "hello",
          connection_info: { app_id: "A1" },
          num_connections: 1,
          debug_info: { host: "applink-1", build_number: 54, approximate_connection_time: this.connectionTime },
        }),
      );
      for (const env of this.pending.splice(0)) ws.send(JSON.stringify(env));
    });
  }

  static async start(): Promise<FakeSlack> {
    const f = new FakeSlack();
    await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
    f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
    return f;
  }

  /** `dofs.<name>.api` */
  get api(): string {
    return `${this.url}/api`;
  }

  /** In-process tests without the proxy: `fetch` with `hortus-secret-<x>` (`-app` → app token) swapped in. */
  fetch = (url: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const a = headers.get("authorization");
    const swap = (m: string) => (m.endsWith("-app") ? this.appToken : this.botToken);
    if (a) headers.set("authorization", a.replace(/hortus-secret-[\w.-]+/g, swap));
    return fetch(url, { ...init, headers });
  };

  /** vault.json entries for DOF `name` */
  vault(name: string): Record<string, { type: "token"; value: string; transform: string }> {
    return {
      [name]: { type: "token", value: this.botToken, transform: "slack" },
      [`${name}-app`]: { type: "token", value: this.appToken, transform: "slack" },
    };
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise((r) => this.wss.close(r));
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  // ---- control surface -----------------------------------------------------------------------------------------

  user(id: string, name: string, extra: Partial<FakeUser> = {}): FakeUser {
    const u = { id, name, ...extra };
    this.users.push(u);
    return u;
  }

  channel(id: string, opts: Partial<Omit<FakeChannel, "id" | "messages">> = {}): FakeChannel {
    const c: FakeChannel = {
      id,
      name: opts.name ?? id.toLowerCase(),
      is_im: false,
      is_private: false,
      is_archived: false,
      topic: { value: "" },
      members: [],
      messages: [],
      ...opts,
    };
    this.channels.set(id, c);
    return c;
  }

  post(channel: string, o: PostOpts = {}): FakeMsg {
    const c = this.must(channel);
    const m: FakeMsg = { ts: o.ts ?? this.ts(), text: o.text ?? "", user: o.user };
    if (o.user === this.botUser) m.bot_id = "B_BOT";
    if (o.thread_ts) m.thread_ts = o.thread_ts;
    if (o.subtype) m.subtype = o.subtype;
    if (o.files?.length) {
      m.files = o.files.map((f) => {
        const id = `F${++this.n}`;
        this.files.set(id, f.bytes ?? Buffer.alloc(0));
        return {
          id,
          name: f.name,
          size: f.size ?? f.bytes?.length ?? 0,
          url_private_download: `${this.url}/files/${id}`,
        };
      });
    }
    c.messages.push(m);
    if (o.thread_ts && o.thread_ts !== m.ts) {
      const parent = c.messages.find((x) => x.ts === o.thread_ts);
      if (parent) parent.reply_count = (parent.reply_count ?? 0) + 1;
    }
    if (!o.quiet) {
      const subtype = m.subtype ?? (m.files ? "file_share" : undefined);
      this.emit({ type: "message", channel, ...m, ...(subtype ? { subtype } : {}), event_ts: m.ts });
    }
    return m;
  }

  edit(channel: string, ts: string, text: string): FakeMsg {
    const m = this.msg(channel, ts);
    m.text = text;
    const now = this.ts();
    m.edited = { user: m.user ?? this.botUser, ts: now };
    this.emit({
      type: "message",
      subtype: "message_changed",
      hidden: true,
      channel,
      message: { ...m },
      event_ts: now,
      ts: now,
    });
    return m;
  }

  delete(channel: string, ts: string): void {
    const c = this.must(channel);
    const m = this.msg(channel, ts);
    c.messages = c.messages.filter((x) => x !== m);
    const now = this.ts();
    this.emit({
      type: "message",
      subtype: "message_deleted",
      hidden: true,
      channel,
      deleted_ts: ts,
      previous_message: m,
      event_ts: now,
      ts: now,
    });
  }

  react(channel: string, ts: string, user: string, name: string, remove = false): void {
    const m = this.msg(channel, ts);
    const rs = m.reactions ?? [];
    let r = rs.find((x) => x.name === name);
    if (!r) {
      r = { name, users: [], count: 0 };
      rs.push(r);
    }
    r.users = remove ? r.users.filter((u) => u !== user) : [...new Set([...r.users, user])];
    r.count = r.users.length;
    m.reactions = rs.filter((x) => x.count > 0);
    if (!m.reactions.length) delete m.reactions;
    this.emit({
      type: remove ? "reaction_removed" : "reaction_added",
      user,
      reaction: name,
      item: { type: "message", channel, ts, channel_type: "channel" },
      event_ts: this.ts(),
    });
  }

  /** message_replied as delivered: no `subtype` (the docs' bug alert), the parent nested, `ts` the event's own. */
  replied(channel: string, ts: string): void {
    const now = this.ts();
    this.emit({
      type: "message",
      message: { ...this.msg(channel, ts) },
      hidden: true,
      channel,
      event_ts: now,
      ts: now,
    });
  }

  join(channel: string, user: string): void {
    const c = this.channels.get(channel) ?? this.channel(channel);
    if (!c.members.includes(user)) c.members.push(user);
    this.emit({ type: "member_joined_channel", user, channel, event_ts: this.ts() });
  }

  /** Emit any event (wrapped in a fresh envelope); queued until a socket has said hello. */
  emit(event: Record<string, unknown>): Envelope {
    const id = ++this.n;
    const env: Envelope = {
      envelope_id: `env-${id}`,
      type: "events_api",
      accepts_response_payload: false,
      payload: { type: "event_callback", event_id: `Ev${id}`, event_time: 1730000000 + id, event },
    };
    this.sent.set(env.envelope_id, env);
    if (this.sockets.size) for (const ws of this.sockets) ws.send(JSON.stringify(env));
    else this.pending.push(env);
    return env;
  }

  /** Resend one envelope as is (default: the last one). */
  replay(envelopeId = [...this.sent.keys()].at(-1)): void {
    const env = envelopeId && this.sent.get(envelopeId);
    if (!env) throw new Error(`no envelope ${envelopeId}`);
    for (const ws of this.sockets) ws.send(JSON.stringify(env));
  }

  /** Slack's refresh: a `disconnect` frame, then the socket closes. */
  disconnect(): void {
    for (const ws of this.wss.clients) {
      ws.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
      ws.close();
    }
    this.sockets.clear();
  }

  /** The next `times` calls to `method` answer 429 with Retry-After: 1. */
  rateLimit(method: string, times: number): void {
    this.limits.set(method, times);
  }

  // ---- HTTP ----------------------------------------------------------------------------------------------------

  private ts(): string {
    return `${1730000000 + ++this.n}.000100`;
  }

  private must(channel: string): FakeChannel {
    const c = this.channels.get(channel);
    if (!c) throw new Error(`no channel ${channel}`);
    return c;
  }

  private msg(channel: string, ts: string): FakeMsg {
    const m = this.must(channel).messages.find((x) => x.ts === ts);
    if (!m) throw new Error(`no message ${channel}/${ts}`);
    return m;
  }

  private page<T>(items: T[], p: Params, key: string): Record<string, unknown> {
    const limit = Math.min(Number(p.limit ?? 100), this.pageSize);
    const start = Number(p.cursor || 0);
    const end = start + limit;
    return {
      ok: true,
      [key]: items.slice(start, end),
      response_metadata: { next_cursor: end < items.length ? String(end) : "" },
    };
  }

  private async handle(
    req: IncomingMessage,
  ): Promise<{ status: number; body: string | Buffer; headers?: Record<string, string> }> {
    const u = new URL(req.url ?? "/", this.url);
    const authz = req.headers.authorization;
    this.auths.push(authz ?? "");
    const file = u.pathname.match(/^\/files\/(\w+)$/);
    if (file?.[1]) {
      const bytes = this.files.get(file[1]);
      if (authz !== `Bearer ${this.botToken}`) return { status: 403, body: "forbidden" };
      return bytes ? { status: 200, body: bytes } : { status: 404, body: "not found" };
    }
    const method = u.pathname.replace(/^\/api\//, "");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const params: Params = Object.fromEntries(u.searchParams);
    if (raw) {
      const json = req.headers["content-type"]?.includes("json");
      Object.assign(params, json ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)));
    }
    this.calls.push({ method, params });
    if (this.stalled.has(method)) await new Promise(() => {});
    const left = this.limits.get(method) ?? 0;
    if (left > 0) {
      this.limits.set(method, left - 1);
      return { status: 429, body: "", headers: { "retry-after": String(this.retryAfter) } };
    }
    const token = method === "apps.connections.open" ? this.appToken : this.botToken;
    const r = authz === `Bearer ${token}` ? this.call(method, params) : { ok: false, error: "invalid_auth" };
    return { status: 200, body: JSON.stringify(r), headers: { "content-type": "application/json" } };
  }

  private call(method: string, p: Params): Record<string, unknown> {
    const ch = p.channel ? this.channels.get(p.channel) : undefined;
    const needCh = () => ({ ok: false, error: "channel_not_found" });
    const after = (m: FakeMsg) => !p.oldest || cmpTs(m.ts, p.oldest) > 0;
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: this.botUser, user: "hortus", team_id: "T1" };
      case "users.list":
        return this.page(this.users, p, "members");
      case "apps.connections.open":
        return { ok: true, url: `${this.url.replace("http", "ws")}/socket` };
      case "conversations.list": {
        const all = [...this.channels.values()]
          .filter((c) => !(p.exclude_archived === "true" && c.is_archived))
          .map((c) => this.info(c));
        return this.page(all, p, "channels");
      }
      case "conversations.info":
        return ch ? { ok: true, channel: this.info(ch) } : needCh();
      case "conversations.members":
        return ch ? this.page(ch.members, p, "members") : needCh();
      case "conversations.history": {
        if (!ch) return needCh();
        const msgs = ch.messages.filter((m) => isTop(m) && after(m)).sort((a, b) => cmpTs(b.ts, a.ts));
        return this.page(msgs, p, "messages");
      }
      case "conversations.replies": {
        if (!ch || !p.ts) return needCh();
        const m = ch.messages.find((x) => x.ts === p.ts);
        if (!m) return { ok: false, error: "thread_not_found" };
        if (m.thread_ts && m.thread_ts !== m.ts) return { ok: true, messages: [m] };
        const replies = ch.messages.filter((x) => x.thread_ts === m.ts && x.ts !== m.ts && after(x));
        return this.page([m, ...replies.sort((a, b) => cmpTs(a.ts, b.ts))], p, "messages");
      }
      case "conversations.open": {
        const user = p.users ?? "";
        const found = [...this.channels.values()].find((c) => c.is_im && c.user === user);
        const c = found ?? this.channel(`D_${user}`, { is_im: true, user, members: [this.botUser, user], name: "" });
        return { ok: true, channel: { id: c.id } };
      }
      case "chat.postMessage": {
        if (!ch) return needCh();
        const m = this.post(ch.id, { user: this.botUser, text: p.text, thread_ts: p.thread_ts });
        return { ok: true, channel: ch.id, ts: m.ts, message: m };
      }
      case "chat.update": {
        if (!ch || !p.ts) return needCh();
        return { ok: true, channel: ch.id, ts: p.ts, message: this.edit(ch.id, p.ts, p.text ?? "") };
      }
      case "chat.delete":
        if (!ch || !p.ts) return needCh();
        this.delete(ch.id, p.ts);
        return { ok: true, channel: ch.id, ts: p.ts };
      case "reactions.add":
        if (!ch || !p.timestamp || !p.name) return needCh();
        this.react(ch.id, p.timestamp, this.botUser, p.name);
        return { ok: true };
      default:
        return { ok: false, error: "unknown_method" };
    }
  }

  private info(c: FakeChannel): Record<string, unknown> {
    const { messages: _m, members, ...rest } = c;
    return { ...rest, is_member: members.includes(this.botUser) };
  }
}
