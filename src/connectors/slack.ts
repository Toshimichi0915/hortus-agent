/**
 * Slack: Socket Mode events, Web API history (02-slack-gateway.md). Every request carries a placeholder
 * (`hortus-secret-<name>`, `-app` for Socket Mode) through `deps.fetch`; this module never sees a real token.
 */
import type { Change, Connector, ConnectorDeps, ConnectorStatus, Event, Incoming, Mirrored } from "../types.ts";
import { backoff, sleep } from "./retry.ts";

/** Tunables tests shorten. */
export const timing = { helloMs: 10_000, lifeMs: 3_600_000, usersMs: 3_600_000, unknownUserMs: 60_000 };
const MAX_FILE = 20 * 1024 * 1024;

interface SlackFile {
  id: string;
  name?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}
export interface SlackMsg {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
  files?: SlackFile[];
  reactions?: { name: string; users: string[] }[];
  reply_count?: number;
  edited?: { ts: string };
}
interface SlackEvent extends Omit<Partial<SlackMsg>, "user"> {
  type: string;
  user?: unknown;
  event_ts?: string;
  channel?: string | { id: string };
  message?: SlackMsg;
  previous_message?: SlackMsg;
  deleted_ts?: string;
  /** a `file` or `file_comment` item has no channel or ts */
  item?: { channel?: string; ts?: string };
  reaction?: string;
}
interface Payload {
  event_id: string;
  event: SlackEvent;
}
interface SlackUser {
  id: string;
  name: string;
  is_bot?: boolean;
  is_restricted?: boolean;
}
interface SlackChannel {
  id: string;
  name?: string;
  user?: string;
  topic?: { value: string };
  is_member?: boolean;
  is_im?: boolean;
  is_archived?: boolean;
}
interface Envelope {
  type: string;
  envelope_id?: string;
  payload?: Payload;
  debug_info?: { approximate_connection_time?: number };
}
type Params = Record<string, string | number | boolean | undefined>;

/** Slack ts strings ("1730000000.123456") compared without float rounding. */
const cmpTs = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const iso = (ts: string): string => `${new Date(Number(ts) * 1000).toISOString().slice(0, 19)}Z`;
const MIRRORED = new Set([undefined, "thread_broadcast", "file_share", "bot_message", "me_message"]);
const fileName = (f: SlackFile): string => `${f.id}-${(f.name ?? "file").replace(/[/\\\0]/g, "_")}`;
const chanOf = (ev: SlackEvent): string =>
  (typeof ev.channel === "string" ? ev.channel : ev.channel?.id) ?? ev.item?.channel ?? "";

export async function create(deps: ConnectorDeps): Promise<Connector> {
  const { name, log, config: cfg } = deps;
  const base = (cfg.api ?? "https://slack.com/api").replace(/\/$/, "");
  const auth = { authorization: `Bearer hortus-secret-${name}` };
  const st: ConnectorStatus = { connected: false };
  const users = new Map<string, SlackUser>();
  let usersAt = 0;

  /** POST form (accepted by every method). 429 → wait Retry-After and retry, 5 times, then throw. */
  async function api<T>(method: string, params: Params = {}, token = name): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    for (let i = 0; ; i++) {
      const res = await deps.fetch(`${base}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer hortus-secret-${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
      if (res.status === 429 && i < 5) {
        await res.body?.cancel();
        await sleep(Number(res.headers.get("retry-after") ?? 1) * 1000, deps.signal);
        continue;
      }
      if (!res.ok) throw new Error(`slack ${method}: HTTP ${res.status}`);
      const r = (await res.json()) as T & { ok: boolean; error?: string };
      if (!r.ok) throw new Error(`slack ${method}: ${r.error}`);
      return r;
    }
  }

  async function all<T>(method: string, params: Params, key: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const r = await api<Record<string, unknown> & { response_metadata?: { next_cursor?: string } }>(method, {
        ...params,
        cursor,
      });
      out.push(...((r[key] as T[] | undefined) ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  async function loadUsers(): Promise<void> {
    const list = await all<SlackUser>("users.list", { limit: 200 }, "members");
    users.clear();
    for (const u of list) users.set(u.id, u);
    usersAt = Date.now();
  }

  /** Cached; refreshed hourly, and on an unknown id at most once a minute (a deactivated user stays unknown). */
  async function user(id: string): Promise<SlackUser | undefined> {
    const age = Date.now() - usersAt;
    if (age > timing.usersMs || (!users.has(id) && age > timing.unknownUserMs)) {
      await loadUsers().catch((e) => log.error(`${name}: users.list failed`, e));
    }
    return users.get(id);
  }
  const label = (id: string) => {
    const u = users.get(id);
    return u ? `${id} (${u.name})` : id;
  };
  const uname = (id: string) => users.get(id)?.name ?? id;

  const botUser = (await api<{ user_id: string }>("auth.test")).user_id;
  await loadUsers();
  const open = async (u: string) =>
    (await api<{ channel: { id: string } }>("conversations.open", { users: u })).channel.id;
  const ownerDm = cfg.owner ? await open(cfg.owner) : undefined;

  const reactions = (m: SlackMsg) =>
    m.reactions?.length ? Object.fromEntries(m.reactions.map((r) => [r.name, r.users.map(uname)])) : undefined;

  async function messageChanges(ch: string, m: SlackMsg, download: boolean): Promise<Change[]> {
    const thread = m.thread_ts ?? m.ts;
    const dir = `${ch}/${thread}`;
    const out: Change[] = [];
    const files: unknown[] = [];
    for (const f of m.files ?? []) {
      const fname = fileName(f);
      const url = f.url_private_download ?? f.url_private;
      if (!url || (f.size ?? 0) > MAX_FILE) {
        files.push({ name: fname, size: f.size, url });
        continue;
      }
      files.push(`files/${fname}`);
      if (!download) continue;
      try {
        const res = await deps.fetch(url, { headers: auth });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        out.push({ op: "put", path: `${dir}/files/${fname}`, bytes: Buffer.from(await res.arrayBuffer()) });
      } catch (e) {
        log.error(`${name}: file ${f.id} download failed`, e);
      }
    }
    const fm: Record<string, unknown> = { id: m.ts, thread, ts: iso(m.ts), user: label(m.user ?? m.bot_id ?? "") };
    if (m.edited) fm.edited = iso(m.edited.ts);
    if (files.length) fm.files = files;
    const r = reactions(m);
    if (r) fm.reactions = r;
    return [{ op: "put", path: `${dir}/${m.ts}.md`, frontmatter: fm, body: m.text ?? "" }, ...out];
  }

  async function channelChange(ch: string): Promise<Change> {
    const { channel: c } = await api<{ channel: SlackChannel }>("conversations.info", { channel: ch });
    const members = await all<string>("conversations.members", { channel: ch, limit: 200 }, "members");
    const fm: Record<string, unknown> = {
      id: c.id,
      name: c.name || (c.user ? label(c.user) : c.id),
      topic: c.topic?.value ?? "",
      members: members.map(label),
    };
    if (c.is_archived) fm.archived = true;
    return { op: "put", path: `${ch}/channel.md`, frontmatter: fm, body: "" };
  }

  async function toEvent(p: Payload): Promise<Event> {
    const ev = p.event;
    const msg = ev.message ?? ev.previous_message;
    const uid = typeof ev.user === "string" ? ev.user : ev.message?.user;
    const u = uid ? await user(uid) : undefined;
    const ch = chanOf(ev);
    const thread = ev.item ? ev.item.ts : msg ? (msg.thread_ts ?? msg.ts) : (ev.thread_ts ?? ev.ts);
    const threaded = ev.type === "message" || ev.type.startsWith("reaction_");
    // the whole of what an owner says, within reason: the Planner, a brief and a Worker's inbox see only this, and a task
    // gets no DOF by default (2000 × batch_max stays well inside a context; a longer paste is cut, the mirror keeps it)
    const text = (ev.text ?? ev.message?.text ?? ev.reaction ?? "").replace(/\s+/g, " ").slice(0, 2000);
    return {
      dof: name,
      key: p.event_id,
      ts: iso(ev.event_ts ?? ev.ts ?? String(Date.now() / 1000)),
      payload: p,
      author: uid ? { user: uid, member: !!u && !u.is_restricted && !u.is_bot } : null,
      bot: Boolean(ev.bot_id ?? ev.message?.bot_id) || ev.subtype === "bot_message" || uid === botUser || !!u?.is_bot,
      summary: `${ev.subtype ?? ev.type} in ${ch} by ${u?.name ?? uid ?? "?"}: ${text}`,
      refs: threaded && thread ? [`${name}:${ch}:${thread}`] : [],
    };
  }

  /** One WebSocket session: yields events until it closes; throws when no `hello` came. */
  async function* session(url: string, signal: AbortSignal, onHello: () => void): AsyncGenerator<Incoming> {
    // an abort during `apps.connections.open` has already fired: the listener below would never hear it
    if (signal.aborted) return;
    const ws = new WebSocket(url);
    const queue: { p: Payload; ack(): Promise<void> }[] = [];
    let closed = false;
    let hello = false;
    let wakeup: (() => void) | undefined;
    const notify = () => {
      wakeup?.();
      wakeup = undefined;
    };
    const close = () => {
      closed = true;
      notify();
      ws.close();
    };
    let timer = setTimeout(close, timing.helloMs);
    signal.addEventListener("abort", close, { once: true });
    ws.onclose = () => {
      closed = true;
      st.connected = false;
      notify();
    };
    ws.onmessage = (m) => {
      let env: Envelope;
      try {
        env = JSON.parse(String(m.data)) as Envelope;
      } catch {
        return;
      }
      if (env.type === "hello") {
        hello = true;
        clearTimeout(timer);
        // Slack refreshes a connection every few hours; past the announced life with no `disconnect`, the TCP path is
        // dead (a suspend, a NAT drop) and nothing here writes to notice: a global WebSocket has no ping
        const life = env.debug_info?.approximate_connection_time;
        timer = setTimeout(close, 1.5 * (life ? life * 1000 : timing.lifeMs));
        st.connected = true;
        st.error = undefined;
        onHello();
      } else if (env.type === "disconnect") close();
      else if (env.envelope_id !== undefined) {
        const id = env.envelope_id;
        const ack = async () => {
          if (ws.readyState !== WebSocket.OPEN) throw new Error("socket closed before ack");
          ws.send(JSON.stringify({ envelope_id: id }));
        };
        // slash_commands / interactive: acked and dropped
        if (env.type !== "events_api" || !env.payload) void ack().catch(() => {});
        else {
          queue.push({ p: env.payload, ack });
          notify();
        }
      }
    };
    try {
      for (;;) {
        const item = queue.shift();
        if (item) {
          const event = await toEvent(item.p);
          st.lastEvent = event.ts;
          yield { event, ack: item.ack };
        } else if (closed) break;
        else await new Promise<void>((r) => (wakeup = r));
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", close);
      if (!closed) close();
    }
    if (!hello && !signal.aborted) throw new Error("no hello from Socket Mode");
  }

  return {
    async *events(signal) {
      for (let attempt = 0; !signal.aborted; attempt++) {
        try {
          const { url } = await api<{ url: string }>("apps.connections.open", {}, `${name}-app`);
          yield* session(url, signal, () => {
            attempt = 0;
          });
        } catch (e) {
          st.error = e instanceof Error ? e.message : String(e);
          log.error(`${name}: socket mode failed`, e);
        }
        st.connected = false;
        if (!signal.aborted) await sleep(backoff(attempt), signal);
      }
    },

    async mirror(e): Promise<Mirrored> {
      const ev = (e.payload as Payload).event;
      const ch = chanOf(ev);
      const none = { changes: [], wake: false };
      switch (ev.type) {
        case "message": {
          // `!ev.message`: message_replied arrives without its subtype (the docs' bug alert), and its `ts` is the event's
          if (MIRRORED.has(ev.subtype) && ev.ts && !ev.message) {
            return { changes: await messageChanges(ch, ev as SlackMsg, true), wake: !e.bot };
          }
          if (ev.subtype === "message_changed" && ev.message) {
            // unfurls and reply counts also arrive as message_changed: only `edited` makes it an edit
            return { changes: await messageChanges(ch, ev.message, false), wake: !e.bot && !!ev.message.edited };
          }
          if (ev.subtype === "message_deleted") {
            const m = ev.previous_message ?? { ts: ev.deleted_ts ?? "" };
            const dir = `${ch}/${m.thread_ts ?? m.ts}`;
            const files: Change[] = (m.files ?? [])
              .filter((f) => (f.size ?? 0) <= MAX_FILE)
              .map((f) => ({ op: "delete", path: `${dir}/files/${fileName(f)}` }));
            return { changes: [{ op: "delete", path: `${dir}/${m.ts}.md` }, ...files], wake: false };
          }
          return none;
        }
        case "reaction_added":
        case "reaction_removed": {
          const { channel, ts } = ev.item ?? {};
          if (!channel || !ts) return none;
          const r = await api<{ messages: SlackMsg[] }>("conversations.replies", { channel, ts, inclusive: true });
          const m = r.messages.find((x) => x.ts === ts);
          if (!m) return none;
          const path = `${channel}/${m.thread_ts ?? m.ts}/${m.ts}.md`;
          return { changes: [{ op: "patch", path, frontmatter: { reactions: reactions(m) ?? null } }], wake: false };
        }
        case "member_joined_channel":
        case "member_left_channel":
        case "channel_rename":
        case "channel_created":
        case "channel_archive":
        case "channel_unarchive":
        case "group_rename":
        case "group_archive":
        case "group_unarchive":
          return { changes: [await channelChange(ch)], wake: false };
        default:
          return none;
      }
    },

    async scopes() {
      const list = await all<SlackChannel>(
        "conversations.list",
        { types: "public_channel,private_channel,im,mpim", exclude_archived: true, limit: 200 },
        "channels",
      );
      const s = new Set(list.filter((c) => c.is_member || c.is_im).map((c) => c.id));
      if (ownerDm) s.add(ownerDm);
      return [...s];
    },

    async *history(scope, cursor) {
      const oldest = cursor ?? undefined;
      const msgs = (await all<SlackMsg>("conversations.history", { channel: scope, oldest, limit: 200 }, "messages"))
        .filter((m) => MIRRORED.has(m.subtype))
        .sort((a, b) => cmpTs(a.ts, b.ts));
      let max = cursor ?? "0";
      for (let i = 0; i === 0 || i < msgs.length; i += 200) {
        const changes: Change[] = i === 0 ? [await channelChange(scope)] : [];
        for (const m of msgs.slice(i, i + 200)) {
          changes.push(...(await messageChanges(scope, m, true)));
          if (m.reply_count) {
            const replies = await all<SlackMsg>(
              "conversations.replies",
              { channel: scope, ts: m.ts, oldest },
              "messages",
            );
            for (const r of replies) if (r.ts !== m.ts) changes.push(...(await messageChanges(scope, r, true)));
          }
          if (cmpTs(m.ts, max) > 0) max = m.ts;
        }
        yield { changes, cursor: max };
      }
    },

    async dm(owner, text) {
      const channel = owner === cfg.owner && ownerDm ? ownerDm : await open(owner);
      await api("chat.postMessage", { channel, text });
    },

    status: () => ({ ...st }),
  };
}
