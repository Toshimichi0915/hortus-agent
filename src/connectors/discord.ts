/**
 * Discord: gateway WebSocket events, REST history (16-discord-telegram.md). REST carries `Authorization: Bot
 * hortus-secret-<name>` through `deps.fetch`; IDENTIFY/RESUME carry `hortus-secret-<name>` in the frame and the proxy's
 * `ws:text` relay swaps it. This module never sees a real token.
 */
import type { Change, Connector, ConnectorDeps, ConnectorStatus, Event, Incoming, Mirrored } from "../types.ts";
import { backoff, sleep } from "./retry.ts";

/** Tunables tests shorten. */
export const timing = { helloMs: 10_000, fatalMs: 3_600_000, memberMs: 3_600_000 };
const MAX_FILE = 20 * 1024 * 1024;
// GUILDS | GUILD_MEMBERS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | DIRECT_MESSAGES | DIRECT_MESSAGE_REACTIONS |
// MESSAGE_CONTENT
const INTENTS = 1 | 2 | 512 | 1024 | 4096 | 8192 | 32768;
const THREAD = new Set([10, 11, 12]);
const TEXT = new Set([0, 5]);
/** parents of public threads that hold no messages of their own: forum and media */
const FORUM = new Set([15, 16]);
/** default, reply, and a slash or context command's answer; system messages (pins, joins, thread created) are not */
const MIRRORED = new Set([0, 19, 20, 23]);
const EVENTS = new Set([
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
  "MESSAGE_DELETE_BULK",
  "MESSAGE_REACTION_ADD",
  "MESSAGE_REACTION_REMOVE",
  "MESSAGE_REACTION_REMOVE_ALL",
  "MESSAGE_REACTION_REMOVE_EMOJI",
  "THREAD_CREATE",
  "THREAD_UPDATE",
  "CHANNEL_CREATE",
  "CHANNEL_UPDATE",
  "CHANNEL_DELETE",
  "GUILD_MEMBER_ADD",
  "GUILD_MEMBER_REMOVE",
]);
/** close codes that start a new session */
const FRESH = new Set([4007, 4009]);
/** close codes the docs say not to reconnect on, and what the owner has to do */
const FATAL = new Map([
  [4004, "authentication failed: check the bot token"],
  [4010, "invalid shard"],
  [4011, "sharding required: the bot is in too many guilds for one session"],
  [4012, "invalid API version"],
  [4013, "invalid intents"],
  [
    4014,
    "disallowed intents: enable Server Members Intent and Message Content Intent on the bot's page in the Developer Portal",
  ],
]);
/** Discord asks for this form; a client without it may be blocked at Cloudflare (Reference › User Agent). */
const USER_AGENT = "DiscordBot (https://github.com/hortus-agent, 1)";

interface DUser {
  id: string;
  username: string;
  bot?: boolean;
}
interface DAttachment {
  id: string;
  filename?: string;
  size?: number;
  url?: string;
}
interface DMsg {
  id: string;
  channel_id: string;
  guild_id?: string;
  author?: DUser;
  member?: unknown;
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  type?: number;
  attachments?: DAttachment[];
  message_reference?: { message_id?: string };
  reactions?: { emoji: { id: string | null; name: string | null } }[];
  /** a forward: `content` is empty, the text is here */
  message_snapshots?: { message: { content?: string } }[];
}
interface DChannel {
  id: string;
  type: number;
  name?: string;
  topic?: string | null;
  guild_id?: string;
  parent_id?: string | null;
  recipients?: DUser[];
  thread_metadata?: { archive_timestamp?: string };
}
interface Frame {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}
/** events.payload: the dispatch with the session it came on */
interface Payload {
  session_id: string;
  s: number;
  t: string;
  d: Record<string, unknown>;
}
/** The socket surface used: the global WebSocket, or whatever `deps.ws` returns (the proxy route, a test swap). */
type Socket = Pick<WebSocket, "send" | "close" | "readyState" | "onmessage" | "onclose" | "onerror">;

const iso = (ts: string | null | undefined): string => `${new Date(ts ?? Date.now()).toISOString().slice(0, 19)}Z`;
const cmpId = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const fileName = (f: DAttachment): string => `${f.id}-${(f.filename ?? "file").replace(/[/\\\0]/g, "_")}`;
const emojiKey = (e: { id: string | null; name: string | null }) => (e.id ? `${e.name}:${e.id}` : (e.name ?? ""));

export async function create(deps: ConnectorDeps): Promise<Connector> {
  const { name, log, config: cfg } = deps;
  const base = (cfg.api ?? "https://discord.com/api/v10").replace(/\/$/, "");
  const open: (url: string) => Socket = deps.ws ?? ((u) => new WebSocket(u));
  const st: ConnectorStatus = { connected: false };
  const chans = new Map<string, DChannel>();
  const names = new Map<string, string>();
  const guilds = new Map<string, { yes: boolean; at: number }>();
  let gatewayUrl: string | undefined;
  let session: { id: string; seq: number; url: string } | undefined;
  let lastAck: number | undefined;
  /** set by a close code that must not be retried at once */
  let fatal: string | undefined;

  /** JSON REST. 429 → wait Retry-After and retry, 5 times, then throw. */
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let i = 0; ; i++) {
      const res = await deps.fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bot hortus-secret-${name}`,
          "user-agent": USER_AGENT,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status === 429 && i < 5) {
        await res.body?.cancel();
        await sleep(Number(res.headers.get("retry-after") ?? 1) * 1000, deps.signal);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`discord ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      return (res.status === 204 ? undefined : await res.json()) as T;
    }
  }

  const remember = (c: DChannel, guild?: string): DChannel => {
    const x = { ...c, guild_id: c.guild_id ?? guild };
    chans.set(c.id, x);
    return x;
  };
  async function chan(id: string): Promise<DChannel | undefined> {
    const c = chans.get(id);
    if (c) return c;
    try {
      return remember(await api<DChannel>("GET", `/channels/${id}`));
    } catch (e) {
      log.error(`${name}: channel ${id} lookup failed`, e);
      return undefined;
    }
  }
  const label = (u: DUser | undefined) => {
    if (!u) return "";
    names.set(u.id, u.username);
    return `${u.id} (${u.username})`;
  };

  /** v6: a thread channel is filed under its parent; a plain channel message is its own thread. */
  async function where(channel: string, message: string): Promise<{ channel: string; thread: string; dir: string }> {
    const c = await chan(channel);
    if (c && THREAD.has(c.type) && c.parent_id)
      return { channel: c.parent_id, thread: c.id, dir: `${c.parent_id}/${c.id}` };
    return { channel, thread: message, dir: `${channel}/${message}` };
  }

  const botUser = (await api<DUser>("GET", "/users/@me")).id;
  const openDm = async (u: string) => remember(await api<DChannel>("POST", "/users/@me/channels", { recipient_id: u }));
  const ownerDm = cfg.owner ? (await openDm(cfg.owner)).id : undefined;

  async function reactions(m: DMsg): Promise<Record<string, string[]> | undefined> {
    if (!m.reactions?.length) return undefined;
    // entries: a custom emoji may be named `__proto__`
    const out: [string, string[]][] = [];
    for (const r of m.reactions) {
      const key = emojiKey(r.emoji);
      const users = await api<DUser[]>(
        "GET",
        `/channels/${m.channel_id}/messages/${m.id}/reactions/${encodeURIComponent(key)}?limit=100`,
      );
      out.push([r.emoji.name ?? key, users.map((u) => u.username)]);
    }
    return Object.fromEntries(out);
  }

  async function messageChanges(m: DMsg, download: boolean): Promise<Change[]> {
    const { thread, dir } = await where(m.channel_id, m.id);
    const out: Change[] = [];
    const files: unknown[] = [];
    for (const f of m.attachments ?? []) {
      const fname = fileName(f);
      if (!f.url || (f.size ?? 0) > MAX_FILE) {
        files.push({ name: fname, size: f.size, url: f.url });
        continue;
      }
      files.push(`files/${fname}`);
      if (!download) continue;
      try {
        // attachments are CDN URLs: no credential
        const res = await deps.fetch(f.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        out.push({ op: "put", path: `${dir}/files/${fname}`, bytes: Buffer.from(await res.arrayBuffer()) });
      } catch (e) {
        log.error(`${name}: attachment ${f.id} download failed`, e);
      }
    }
    const fm: Record<string, unknown> = { id: m.id, thread, ts: iso(m.timestamp), user: label(m.author) };
    if (m.edited_timestamp) fm.edited = iso(m.edited_timestamp);
    if (m.message_reference?.message_id) fm.reply_to = m.message_reference.message_id;
    if (files.length) fm.files = files;
    const r = await reactions(m);
    if (r) fm.reactions = r;
    const body = m.content || m.message_snapshots?.[0]?.message.content || "";
    return [{ op: "put", path: `${dir}/${m.id}.md`, frontmatter: fm, body }, ...out];
  }

  function channelChange(c: DChannel): Change {
    const fm: Record<string, unknown> = {
      id: c.id,
      name: c.name ?? (c.recipients ?? []).map(label).join(", "),
      topic: c.topic ?? "",
    };
    if (c.guild_id) fm.guild = c.guild_id;
    if (c.recipients)
      fm.members = [label({ id: botUser, username: names.get(botUser) ?? "bot" }), ...c.recipients.map(label)];
    return { op: "put", path: `${c.id}/channel.md`, frontmatter: fm, body: "" };
  }

  /** A guild counts only with the owner in it: anyone can add a public bot to theirs, and be a member there. Cached an
   * hour; a failed lookup is no, and asked again. */
  async function ownerIn(guild: string | undefined): Promise<boolean> {
    const c = guild ? guilds.get(guild) : undefined;
    if (c && Date.now() - c.at < timing.memberMs) return c.yes;
    if (!guild) return false;
    let yes = true;
    try {
      await api("GET", `/guilds/${guild}/members/${cfg.owner}`);
    } catch (e) {
      yes = false;
      if (!/HTTP 404/.test(String(e))) {
        log.error(`${name}: owner's membership of ${guild} failed`, e);
        return false;
      }
    }
    guilds.set(guild, { yes, at: Date.now() });
    return yes;
  }

  async function toEvent(p: Payload): Promise<Event> {
    const d = p.d;
    const user = (d.author ?? d.user ?? (d.member as { user?: DUser } | undefined)?.user) as DUser | undefined;
    const uid = user?.id ?? (d.user_id as string | undefined);
    const refs: string[] = [];
    const msgId = (d.message_id as string | undefined) ?? (p.t.startsWith("MESSAGE_") ? (d.id as string) : undefined);
    const channel = d.channel_id as string | undefined;
    if (channel && msgId) {
      const w = await where(channel, msgId);
      refs.push(`${name}:${w.channel}:${w.thread}`);
      if (channel !== w.channel) refs.push(`${name}:${channel}:${channel}`); // a forum post's first message too
      const ref = (d.message_reference as { message_id?: string } | undefined)?.message_id;
      if (ref && w.thread === msgId) refs.push(`${name}:${w.channel}:${ref}`);
    }
    const text = String(d.content ?? (d.emoji as { name?: string } | undefined)?.name ?? d.name ?? "");
    const who = user?.username ?? (uid && names.get(uid)) ?? uid ?? "?";
    return {
      dof: name,
      key: `${p.session_id}:${p.s}`,
      ts: iso((d.edited_timestamp ?? d.timestamp) as string | undefined),
      payload: p,
      author: uid ? { user: uid, member: !!d.member && (await ownerIn(d.guild_id as string | undefined)) } : null,
      bot: !!user?.bot || uid === botUser,
      summary: `${p.t.toLowerCase()} in ${channel ?? d.guild_id ?? "?"} by ${who}: ${text}`,
      refs,
    };
  }

  /** One gateway connection: yields events until it closes; throws when neither READY nor RESUMED came. */
  async function* connect(url: string, signal: AbortSignal, onReady: () => void): AsyncGenerator<Incoming> {
    // an abort during `GET /gateway/bot` has already fired: the listener below would never hear it
    if (signal.aborted) return;
    const ws = open(url);
    const queue: Payload[] = [];
    let closed = false;
    let ready = false;
    let acked = true;
    let beat: NodeJS.Timeout | undefined;
    let wakeup: (() => void) | undefined;
    const notify = () => {
      wakeup?.();
      wakeup = undefined;
    };
    const send = (f: Frame) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(f));
    const close = () => {
      closed = true;
      notify();
      // 4000: a close the server lets us resume from (a 1000 would end the session)
      if (ws.readyState <= WebSocket.OPEN) ws.close(4000);
    };
    const timer = setTimeout(close, timing.helloMs);
    signal.addEventListener("abort", close, { once: true });
    ws.onclose = (e) => {
      closed = true;
      st.connected = false;
      const why = FATAL.get(e.code);
      if (why) fatal = `${why} (${e.code})`;
      if (why || FRESH.has(e.code)) session = undefined;
      notify();
    };
    ws.onerror = () => {};
    ws.onmessage = (m) => {
      let f: Frame;
      try {
        f = JSON.parse(String(m.data)) as Frame;
      } catch {
        return;
      }
      if (typeof f.s === "number" && session) session.seq = Math.max(session.seq, f.s);
      switch (f.op) {
        case 10: {
          clearTimeout(timer);
          const every = (f.d as { heartbeat_interval: number }).heartbeat_interval;
          const tick = () => {
            // no ACK since the last beat: a zombie connection, reconnect and resume
            if (!acked) return close();
            acked = false;
            send({ op: 1, d: session?.seq ?? null });
          };
          // the first beat after `heartbeat_interval * jitter`, then every interval
          beat = setTimeout(() => {
            tick();
            beat = setInterval(tick, every);
          }, every * Math.random());
          const token = `hortus-secret-${name}`;
          if (session) send({ op: 6, d: { token, session_id: session.id, seq: session.seq } });
          else
            send({
              op: 2,
              d: { token, intents: INTENTS, properties: { os: "linux", browser: "hortus", device: "hortus" } },
            });
          return;
        }
        case 11:
          acked = true;
          lastAck = Date.now();
          return;
        case 1:
          send({ op: 1, d: session?.seq ?? null });
          return;
        case 7:
          return close();
        case 9:
          if (!f.d) session = undefined;
          return close();
        case 0:
          break;
        default:
          return;
      }
      const d = (f.d ?? {}) as Record<string, unknown>;
      const t = f.t ?? "";
      if (t === "READY") {
        session = { id: String(d.session_id), seq: f.s ?? 0, url: String(d.resume_gateway_url ?? url) };
      }
      if (t === "READY" || t === "RESUMED") {
        ready = true;
        st.connected = true;
        st.error = undefined;
        onReady();
        return;
      }
      if (t === "GUILD_CREATE") {
        const g = String(d.id);
        for (const c of [...((d.channels ?? []) as DChannel[]), ...((d.threads ?? []) as DChannel[])]) remember(c, g);
        return;
      }
      if (t === "INTERACTION_CREATE") {
        // ack within 3 s (type 5: deferred), then dropped
        const path = `/interactions/${d.id}/${d.token}/callback`;
        void api("POST", path, { type: 5 }).catch((e) => log.error(`${name}: interaction ack failed`, e));
        return;
      }
      // only these four carry a channel object: THREAD_MEMBER(S)_UPDATE also has an `id`, with no type or parent_id, and
      // would turn the thread's cache entry into a plain channel
      if (/^(THREAD|CHANNEL)_(CREATE|UPDATE)$/.test(t)) remember(d as unknown as DChannel);
      if (!EVENTS.has(t) || !session || typeof f.s !== "number") return;
      queue.push({ session_id: session.id, s: f.s, t, d });
      notify();
    };
    try {
      for (;;) {
        const p = queue.shift();
        if (p) {
          const event = await toEvent(p);
          st.lastEvent = event.ts;
          yield { event, ack: async () => {} };
        } else if (closed) break;
        else await new Promise<void>((r) => (wakeup = r));
      }
    } finally {
      clearTimeout(timer);
      clearInterval(beat);
      signal.removeEventListener("abort", close);
      if (!closed) close();
    }
    if (!ready && !signal.aborted) throw new Error("no READY from the gateway");
  }

  const gatewayQuery = (u: string) => {
    const x = new URL(u);
    x.searchParams.set("v", "10");
    x.searchParams.set("encoding", "json");
    return x.toString();
  };

  return {
    async *events(signal) {
      for (let attempt = 0; !signal.aborted; attempt++) {
        try {
          gatewayUrl ??= (await api<{ url: string }>("GET", "/gateway/bot")).url;
          yield* connect(gatewayQuery(session?.url ?? gatewayUrl), signal, () => {
            attempt = 0;
          });
        } catch (e) {
          st.error = e instanceof Error ? e.message : String(e);
          log.error(`${name}: gateway failed`, e);
          // "or the reconnect fails": back to the cached URL and a new session (a resume host gone, a session expired)
          if (attempt >= 3) session = undefined;
        }
        st.connected = false;
        if (fatal) {
          // ponytail: retried hourly, not never: nothing restarts a connector when the owner fixes the token or the
          // portal; 60 s backoff is 1440 IDENTIFYs a day, and at 1000 Discord resets the token
          st.error = fatal;
          fatal = undefined;
          await sleep(timing.fatalMs, signal);
        } else if (!signal.aborted) await sleep(backoff(attempt), signal);
      }
    },

    async mirror(e): Promise<Mirrored> {
      const { t, d } = e.payload as Payload;
      const none = { changes: [], wake: false };
      switch (t) {
        case "MESSAGE_CREATE": {
          const m = d as unknown as DMsg;
          if (!MIRRORED.has(m.type ?? 0)) return none;
          return { changes: await messageChanges(m, true), wake: !e.bot };
        }
        case "MESSAGE_UPDATE": {
          let m = d as unknown as DMsg;
          // embed-only updates carry no content
          if (m.content === undefined && !m.edited_timestamp) return none;
          if (!m.author || !m.timestamp) m = await api<DMsg>("GET", `/channels/${m.channel_id}/messages/${m.id}`);
          if (!MIRRORED.has(m.type ?? 0)) return none;
          return { changes: await messageChanges(m, false), wake: !e.bot && !!m.edited_timestamp };
        }
        case "MESSAGE_DELETE": {
          const { dir } = await where(String(d.channel_id), String(d.id));
          // ponytail: attachment files of a deleted message stay (the payload has no attachment list); the next
          // full resync drops nothing either, the mirror keeps them until the owner prunes
          return { changes: [{ op: "delete", path: `${dir}/${d.id}.md` }], wake: false };
        }
        case "MESSAGE_DELETE_BULK": {
          const changes: Change[] = [];
          for (const id of d.ids as string[]) {
            const { dir } = await where(String(d.channel_id), id);
            changes.push({ op: "delete", path: `${dir}/${id}.md` });
          }
          return { changes, wake: false };
        }
        case "MESSAGE_REACTION_ADD":
        case "MESSAGE_REACTION_REMOVE":
        case "MESSAGE_REACTION_REMOVE_ALL":
        case "MESSAGE_REACTION_REMOVE_EMOJI": {
          const m = await api<DMsg>("GET", `/channels/${d.channel_id}/messages/${d.message_id}`);
          const { dir } = await where(m.channel_id, m.id);
          const r = (await reactions(m)) ?? null;
          return { changes: [{ op: "patch", path: `${dir}/${m.id}.md`, frontmatter: { reactions: r } }], wake: false };
        }
        case "CHANNEL_CREATE":
        case "CHANNEL_UPDATE": {
          const c = d as unknown as DChannel;
          return THREAD.has(c.type) ? none : { changes: [channelChange(c)], wake: false };
        }
        case "CHANNEL_DELETE":
          return {
            changes: [{ op: "patch", path: `${d.id}/channel.md`, frontmatter: { deleted: true } }],
            wake: false,
          };
        default:
          // THREAD_*: the channel cache is updated on receipt; GUILD_MEMBER_*: membership lives in `author.member`
          return none;
      }
    },

    async scopes() {
      const out = new Set<string>();
      for (const g of await api<{ id: string }[]>("GET", "/users/@me/guilds")) {
        const list = await api<DChannel[]>("GET", `/guilds/${g.id}/channels`);
        const text = list.filter((c) => TEXT.has(c.type)).map((c) => remember(c, g.id));
        for (const c of text) out.add(c.id);
        const active = await api<{ threads: DChannel[] }>("GET", `/guilds/${g.id}/threads/active`);
        for (const c of active.threads) out.add(remember(c, g.id).id);
        for (const c of list.filter((x) => TEXT.has(x.type) || FORUM.has(x.type))) {
          try {
            for (let before = ""; ; ) {
              const path = `/channels/${c.id}/threads/archived/public?limit=100${before}`;
              const r = await api<{ threads: DChannel[]; has_more?: boolean }>("GET", path);
              for (const th of r.threads) out.add(remember(th, g.id).id);
              const last = r.threads.at(-1)?.thread_metadata?.archive_timestamp;
              if (!r.has_more || !last) break;
              before = `&before=${encodeURIComponent(last)}`;
            }
          } catch (e) {
            // a 403 on a channel the bot cannot read: it has no history to fetch, and must not cost the other scopes
            log.info(`${name}: skipping channel ${c.id}: ${e instanceof Error ? e.message : e}`);
            out.delete(c.id);
          }
        }
      }
      if (ownerDm) out.add(ownerDm);
      return [...out];
    },

    async *history(scope, cursor) {
      const c = await chan(scope);
      if (!c) throw new Error(`discord: unknown channel ${scope}`);
      let after = cursor ?? "0";
      for (let first = true; ; first = false) {
        const page = (await api<DMsg[]>("GET", `/channels/${scope}/messages?after=${after}&limit=100`)).sort((a, b) =>
          cmpId(a.id, b.id),
        );
        const changes: Change[] = first && !THREAD.has(c.type) ? [channelChange(c)] : [];
        for (const m of page) {
          if (!MIRRORED.has(m.type ?? 0)) continue;
          const mine = await messageChanges(m, true);
          const top = mine.find((x) => x.frontmatter);
          // the live event's fields: past the first sync a reconcile may be the only one to see it. REST leaves out
          // `member` and `guild_id`, which a guild channel implies
          if (cursor && top) {
            const d = { ...m, ...(c.guild_id ? { member: {}, guild_id: c.guild_id } : {}) };
            const { author, bot, summary, refs } = await toEvent({ session_id: "", s: 0, t: "MESSAGE_CREATE", d });
            top.heard = { author, bot, summary, refs };
          }
          changes.push(...mine);
        }
        after = page.at(-1)?.id ?? after;
        if (first || page.length) yield { changes, cursor: after };
        if (!page.length) break;
      }
    },

    async dm(owner, text) {
      const channel = owner === cfg.owner && ownerDm ? ownerDm : (await openDm(owner)).id;
      await api("POST", `/channels/${channel}/messages`, { content: text });
    },

    status: () => ({
      ...st,
      notes: [
        `gateway session ${session?.id ?? "none"}`,
        lastAck ? `heartbeat ack ${Math.round((Date.now() - lastAck) / 1000)} s ago` : "no heartbeat ack yet",
      ],
    }),
  };
}
