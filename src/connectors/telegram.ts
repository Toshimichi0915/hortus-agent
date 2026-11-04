/**
 * Telegram: `getUpdates` long poll, no history (16-discord-telegram.md). The token rides as a path segment,
 * `/bothortus-secret-<name>/…`, which the `telegram` transform maps to `path:/bot{}/`; this module never sees it.
 */
import type { Change, Connector, ConnectorDeps, ConnectorStatus, Event, Mirrored } from "../types.ts";
import { backoff, sleep } from "./retry.ts";

/** Tunables tests shorten. */
export const timing = { pollS: 50, memberMs: 3_600_000 };
const MAX_FILE = 20 * 1024 * 1024;
const ALLOWED = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "message_reaction",
  "chat_member",
  "my_chat_member",
];
const MEMBER = new Set(["member", "administrator", "creator"]);

interface TUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}
interface TChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
}
interface TFile {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  file_size?: number;
}
interface TMsg {
  message_id: number;
  chat: TChat;
  from?: TUser;
  date: number;
  edit_date?: number;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  reply_to_message?: TMsg;
  document?: TFile;
  photo?: TFile[];
  video?: TFile;
  audio?: TFile;
  voice?: TFile;
  animation?: TFile;
  video_note?: TFile;
  new_chat_members?: TUser[];
  left_chat_member?: TUser;
  new_chat_title?: string;
}
interface TReaction {
  type: string;
  emoji?: string;
  custom_emoji_id?: string;
}
interface TMemberChange {
  chat: TChat;
  from: TUser;
  date: number;
  new_chat_member: { user: TUser; status: string };
}
interface Update {
  update_id: number;
  message?: TMsg;
  edited_message?: TMsg;
  channel_post?: TMsg;
  edited_channel_post?: TMsg;
  message_reaction?: {
    chat: TChat;
    message_id: number;
    user?: TUser;
    date: number;
    old_reaction: TReaction[];
    new_reaction: TReaction[];
  };
  chat_member?: TMemberChange;
  my_chat_member?: TMemberChange;
}

const iso = (s: number): string => `${new Date(s * 1000).toISOString().slice(0, 19)}Z`;
const uname = (u: TUser): string => u.username ?? u.first_name ?? String(u.id);
const label = (u: TUser | undefined): string => (u ? `${u.id} (${uname(u)})` : "");
const safe = (s: string) => s.replace(/[/\\\0]/g, "_");
const rname = (r: TReaction) => r.emoji ?? r.custom_emoji_id ?? r.type;

export async function create(deps: ConnectorDeps): Promise<Connector> {
  const { name, log, config: cfg } = deps;
  const base = (cfg.api ?? "https://api.telegram.org").replace(/\/$/, "");
  const st: ConnectorStatus = { connected: false };
  const chats = new Map<string, TChat>();
  const members = new Map<string, { member: boolean; at: number }>();
  // ponytail: reply-chain roots and reaction sets live in memory for the process lifetime (ConnectorDeps offers no
  // read of the mirror); after a restart a reply to a pre-restart reply files under the replied-to message, and the
  // first reaction delta per message restarts its set. Upgrade: give connectors a read-only view of their DOF.
  const roots = new Map<string, number>();
  const reacts = new Map<string, Map<string, Set<string>>>();
  let offset: number | undefined;
  let lastUpdate: number | undefined;

  async function api<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    for (let i = 0; ; i++) {
      const res = await deps.fetch(`${base}/bothortus-secret-${name}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        ...(signal ? { signal } : {}),
      });
      let r: { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
      try {
        r = (await res.json()) as typeof r;
      } catch {
        throw new Error(`telegram ${method}: HTTP ${res.status}`);
      }
      if (res.status === 429 && i < 5) {
        await sleep((r.parameters?.retry_after ?? 1) * 1000, signal);
        continue;
      }
      if (!r.ok) throw new Error(`telegram ${method}: ${r.description ?? `HTTP ${res.status}`}`);
      return r.result as T;
    }
  }

  const botUser = (await api<TUser>("getMe")).id;

  /** Cached an hour per chat and user; a failed lookup counts as not a member and is retried next time. */
  async function isMember(chat: number, user: number): Promise<boolean> {
    const key = `${chat}:${user}`;
    const c = members.get(key);
    if (c && Date.now() - c.at < timing.memberMs) return c.member;
    try {
      const r = await api<{ status: string }>("getChatMember", { chat_id: chat, user_id: user });
      const member = MEMBER.has(r.status);
      members.set(key, { member, at: Date.now() });
      return member;
    } catch (e) {
      log.error(`${name}: getChatMember failed`, e);
      return false;
    }
  }

  /** v6: the forum topic, else the root of the reply chain, else the message itself. */
  function threadOf(m: TMsg): number {
    const key = `${m.chat.id}:${m.message_id}`;
    const known = roots.get(key);
    if (known !== undefined) return known;
    const r = m.reply_to_message;
    const t = m.message_thread_id ?? (r ? (roots.get(`${m.chat.id}:${r.message_id}`) ?? r.message_id) : m.message_id);
    roots.set(key, t);
    return t;
  }

  function filesOf(m: TMsg): TFile[] {
    const largest = m.photo?.at(-1);
    return [m.document, largest, m.video, m.audio, m.voice, m.animation, m.video_note].filter((f): f is TFile => !!f);
  }
  /** a poll, a location, a sticker: nothing to mirror (and a live location is an edit every few seconds) */
  const blank = (m: TMsg) => m.text === undefined && m.caption === undefined && !filesOf(m).length;
  const reactionsOf = (key: string) => {
    const set = reacts.get(key);
    return set?.size ? Object.fromEntries([...set].map(([k, v]) => [k, [...v]])) : undefined;
  };

  async function messageChanges(m: TMsg, download: boolean): Promise<Change[]> {
    const thread = threadOf(m);
    const dir = `${m.chat.id}/${thread}`;
    const out: Change[] = [];
    const files: unknown[] = [];
    for (const f of filesOf(m)) {
      const fname = `${f.file_unique_id ?? f.file_id}-${safe(f.file_name ?? "file")}`;
      if ((f.file_size ?? 0) > MAX_FILE) {
        // getFile refuses over 20 MB: metadata only
        files.push({ name: fname, size: f.file_size });
        continue;
      }
      files.push(`files/${fname}`);
      if (!download) continue;
      try {
        const { file_path } = await api<{ file_path: string }>("getFile", { file_id: f.file_id });
        const res = await deps.fetch(`${base}/file/bothortus-secret-${name}/${file_path}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        out.push({ op: "put", path: `${dir}/files/${fname}`, bytes: Buffer.from(await res.arrayBuffer()) });
      } catch (e) {
        log.error(`${name}: file ${f.file_id} download failed`, e);
      }
    }
    const fm: Record<string, unknown> = { id: m.message_id, thread, ts: iso(m.date), user: label(m.from) };
    if (m.edit_date) fm.edited = iso(m.edit_date);
    if (m.reply_to_message) fm.reply_to = m.reply_to_message.message_id;
    if (files.length) fm.files = files;
    const rs = reactionsOf(`${m.chat.id}:${m.message_id}`);
    if (rs) fm.reactions = rs;
    return [{ op: "put", path: `${dir}/${m.message_id}.md`, frontmatter: fm, body: m.text ?? m.caption ?? "" }, ...out];
  }

  const chatName = (c: TChat) => c.title ?? c.username ?? c.first_name ?? String(c.id);
  const channelChange = (c: TChat): Change => ({
    op: "put",
    path: `${c.id}/channel.md`,
    frontmatter: { id: c.id, name: chatName(c), type: c.type },
    body: "",
  });

  async function toEvent(u: Update): Promise<Event> {
    const fresh = u.message ?? u.channel_post;
    const m = fresh ?? u.edited_message ?? u.edited_channel_post;
    const r = u.message_reaction;
    const cm = u.chat_member ?? u.my_chat_member;
    const chat = (m ?? r ?? cm)?.chat;
    const from = m?.from ?? r?.user ?? cm?.from;
    if (chat) {
      const left = u.my_chat_member && ["left", "kicked"].includes(u.my_chat_member.new_chat_member.status);
      if (left) chats.delete(String(chat.id));
      else chats.set(String(chat.id), chat);
    }
    const thread = m ? threadOf(m) : r ? (roots.get(`${r.chat.id}:${r.message_id}`) ?? r.message_id) : undefined;
    const kind = fresh ? "message" : m ? "edited" : r ? "reaction" : cm ? "member" : "update";
    const text = (m?.text ?? m?.caption ?? r?.new_reaction.map(rname).join(" ") ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 80);
    return {
      dof: name,
      key: String(u.update_id),
      ts: iso(m?.edit_date ?? m?.date ?? r?.date ?? cm?.date ?? Date.now() / 1000),
      payload: u,
      author: from ? { user: String(from.id), member: chat ? await isMember(chat.id, from.id) : false } : null,
      bot: !!from?.is_bot || from?.id === botUser,
      summary: `${kind} in ${chat?.id ?? "?"} by ${from ? uname(from) : "?"}: ${text}`,
      refs: chat && thread !== undefined ? [`${name}:${chat.id}:${thread}`] : [],
    };
  }

  return {
    async *events(signal) {
      let attempt = 0;
      while (!signal.aborted) {
        let updates: Update[];
        try {
          const wait = AbortSignal.any([signal, AbortSignal.timeout((timing.pollS + 15) * 1000)]);
          updates = await api<Update[]>(
            "getUpdates",
            { offset, timeout: timing.pollS, allowed_updates: ALLOWED },
            wait,
          );
          st.connected = true;
          st.error = undefined;
          attempt = 0;
        } catch (e) {
          if (signal.aborted) break;
          st.connected = false;
          st.error = e instanceof Error ? e.message : String(e);
          log.error(`${name}: getUpdates failed`, e);
          await sleep(backoff(attempt++), signal);
          continue;
        }
        for (const u of updates) {
          const event = await toEvent(u);
          st.lastEvent = event.ts;
          lastUpdate = u.update_id;
          // the ack is the next offset: an update not acked (insert failed, crash) is delivered again
          yield {
            event,
            ack: async () => {
              offset = Math.max(offset ?? 0, u.update_id + 1);
            },
          };
        }
      }
      st.connected = false;
    },

    async mirror(e): Promise<Mirrored> {
      const u = e.payload as Update;
      const none = { changes: [], wake: false };
      const m = u.message ?? u.channel_post;
      if (m) {
        if (m.new_chat_members || m.left_chat_member || m.new_chat_title)
          return { changes: [channelChange(m.chat)], wake: false };
        if (blank(m)) return none;
        return { changes: await messageChanges(m, true), wake: !e.bot };
      }
      const edited = u.edited_message ?? u.edited_channel_post;
      // download: an edit can replace the media, under a new file_unique_id
      if (edited) return blank(edited) ? none : { changes: await messageChanges(edited, true), wake: !e.bot };
      const r = u.message_reaction;
      if (r) {
        const key = `${r.chat.id}:${r.message_id}`;
        const set = reacts.get(key) ?? new Map<string, Set<string>>();
        const who = r.user ? uname(r.user) : "anonymous";
        for (const x of r.old_reaction) set.get(rname(x))?.delete(who);
        for (const x of r.new_reaction) set.set(rname(x), (set.get(rname(x)) ?? new Set()).add(who));
        for (const [k, v] of set) if (!v.size) set.delete(k);
        reacts.set(key, set);
        const thread = roots.get(key) ?? r.message_id;
        const frontmatter = { reactions: reactionsOf(key) ?? null };
        return {
          changes: [{ op: "patch", path: `${r.chat.id}/${thread}/${r.message_id}.md`, frontmatter }],
          wake: false,
        };
      }
      const cm = u.chat_member ?? u.my_chat_member;
      if (cm) return { changes: [channelChange(cm.chat)], wake: false };
      return none;
    },

    /** Chats seen since start (no history to backfill, so the gateway never reconciles them). */
    // ponytail: in memory, not `syncs` rows (the gateway writes syncs only from history): after a restart a chat
    // reappears with its next update; the owner's DM included. Upgrade: an optional Connector.remember() → syncs.
    async scopes() {
      return [...chats.keys()];
    },

    async dm(owner, text) {
      await api("sendMessage", { chat_id: owner, text });
    },

    status: () => {
      const notes = [`last update ${lastUpdate ?? "none"}`, `known chats: ${chats.size}`];
      if (cfg.owner && !chats.has(String(cfg.owner))) notes.push("message the bot once to open your DM");
      return { ...st, notes };
    },
  };
}
