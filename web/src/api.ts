/**
 * The console API as the pages use it, and the one door to it. `call(method, input)` is `POST /api/<method>` (role
 * owner, `X-Hortus: 1`); `subscribe(topics)` and `streamRows` share the page's one SSE stream (src/console/live.ts).
 * `loginStream` is the login view's own. `VITE_MOCK=1` (`pnpm web`) answers from the pretend hortusd in mock.ts instead,
 * which a production bundle leaves out.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Config } from "../../src/config.ts";
import type { CredentialType, SearchHit, StdoutLine, TaskKind, TaskStatus } from "../../src/types.ts";
import { pageAt, pageWindow } from "../../src/console/forms.ts";
import { liveStream } from "../../src/console/live.ts";
import { loginHref } from "../../src/console/next.ts";
import { errorText, store } from "./ui.tsx";

export type { Config, CredentialType, SearchHit, TaskKind, TaskStatus };

export class ApiError extends Error {
  constructor(
    public code: "not_found" | "forbidden" | "invalid" | "failed",
    message: string,
    /** `invalid` from settings.set: zod's issues, each with its `path` */
    public data?: unknown,
  ) {
    super(message);
  }
}

const BATCH_MS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CODES: Record<number, ApiError["code"]> = { 400: "invalid", 403: "forbidden", 404: "not_found" };

export async function call<T = unknown>(method: string, input: unknown = {}): Promise<T> {
  // spelled out each time: the bundler drops the mock's chunk only for this exact test
  if (import.meta.env.VITE_MOCK === "1") {
    const { handlers } = await import("./mock.ts");
    await sleep(80 + Math.random() * 160);
    const h = handlers[method] as ((i: unknown) => unknown) | undefined;
    if (!h) throw new ApiError("not_found", `no method ${method}`);
    return structuredClone(await h(input)) as T;
  }
  let status: number;
  let text: string;
  try {
    const res = await fetch(`/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hortus": "1" },
      body: JSON.stringify(input),
    });
    status = res.status;
    text = await res.text();
  } catch {
    throw new ApiError("failed", "hortusd is not answering");
  }
  // the remote listener without a live session: its sign-in page (which calls nothing here, so it cannot loop), and back
  if (status === 401 && location.pathname !== "/login" && location.pathname !== "/enroll")
    location.replace(loginHref(location.pathname + location.search));
  // the guards in front of the router answer in plain text
  let body: { result?: T; error?: { code: ApiError["code"]; message: string; data?: unknown } } | undefined;
  try {
    body = JSON.parse(text);
  } catch {}
  if (body?.error) throw new ApiError(body.error.code, body.error.message, body.error.data);
  if (status >= 300 || !body) throw new ApiError(CODES[status] ?? "failed", text.slice(0, 200) || `HTTP ${status}`);
  return body.result as T;
}

/** Each topic's events (`tasks`, `approvals`, `settings`, `chat:<id>`), from the stream or from mock.ts. */
export const bus = new EventTarget();
/** The page's stream is down, and retrying. */
export const reconnecting = store(false);
/** A stream that drops may be a 401 (EventSource cannot tell): one call finds out, and its 401 goes to sign-in. */
const down = (d: boolean) => {
  reconnecting.set(d);
  if (d) call("remote.status").catch(() => {});
};
const watch =
  import.meta.env.VITE_MOCK === "1" ? undefined : liveStream(bus, (url) => new EventSource(url), down, 3000, document);

/** Calls `f` on each event of `topics`. */
export function subscribe(topics: string[], f: (e: Event) => void): () => void {
  for (const t of topics) bus.addEventListener(t, f);
  const release = watch?.(topics);
  return () => {
    for (const t of topics) bus.removeEventListener(t, f);
    release?.();
  };
}

/**
 * A chat's rows from the stream: its last 1000, then each new one as it lands, in batches (a row can be one word, and
 * each batch renders once). The stream resumes after a drop by itself; `last` only makes a repeat harmless.
 */
export function streamRows(id: string, onRows: (rows: Row[]) => void): () => void {
  let live = true;
  let last = -1;
  let batch: Row[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const add = (r: Row) => {
    if (!live || r.seq <= last) return;
    last = r.seq;
    batch.push(r);
    timer ??= setTimeout(() => {
      timer = undefined;
      const rows = batch;
      batch = [];
      onRows(rows);
    }, BATCH_MS);
  };
  // the mock has no replay, and its `task.get` is read after any row that lands meanwhile
  let ready = import.meta.env.VITE_MOCK !== "1";
  const off = subscribe([`chat:${id}`], (e) => {
    if (ready) add((e as CustomEvent<Row>).detail);
  });
  if (import.meta.env.VITE_MOCK === "1")
    call<{ replies: Row[] }>("task.get", { id }).then(
      (d) => {
        ready = true;
        d.replies.forEach(add);
      },
      () => {},
    );
  return () => {
    live = false;
    clearTimeout(timer);
    off();
  };
}

/** One `/events/login` message (src/browser/login-view.ts › Event); `frame` is a base64 JPEG of the hostile site. */
export interface LoginEvent {
  frame?: string;
  w?: number;
  h?: number;
  until?: number;
  closed?: string;
  error?: string;
}

/**
 * `/events/login?id=`: the login view's frames, on a stream of its own while the page shows it (opening it starts the
 * view's Chromium). It ends at `closed` or `error`: a retry after those would start a new Chromium. `onDown` hears a
 * drop (`true`: the browser retries, `"lost"`: it gave up, a non-200) and the stream back (`false`).
 */
export function loginStream(
  id: number,
  on: (e: LoginEvent) => void,
  onDown: (down: boolean | "lost") => void,
): () => void {
  if (import.meta.env.VITE_MOCK === "1") {
    let off: (() => void) | undefined;
    let live = true;
    import("./mock.ts").then((m) => {
      if (live) off = m.loginStream(id, on);
    });
    return () => {
      live = false;
      off?.();
    };
  }
  const s = new EventSource(`/events/login?id=${id}`);
  s.onopen = () => onDown(false);
  s.onerror = () => onDown(s.readyState === EventSource.CLOSED ? "lost" : true);
  s.onmessage = (m) => {
    const e = JSON.parse(m.data) as LoginEvent;
    if (e.closed !== undefined || e.error !== undefined) s.close();
    on(e);
  };
  return () => s.close();
}

/**
 * `method(input)`, again after each event of `topics` (a burst once); `null` calls nothing. An answer to an older
 * input never replaces a newer one; until the newer one's lands, `current` is false and `data` is the older input's.
 */
export function useCall<T>(method: string | null, input: unknown = {}, topics: string[] = []) {
  const key = JSON.stringify(input);
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean; of?: string }>({
    loading: !!method,
  });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    if (!method) return setState({ loading: false });
    try {
      const data = await call<T>(method, JSON.parse(key));
      if (n === seq.current) setState({ data, loading: false, of: key });
    } catch (e) {
      if (n === seq.current) setState((s) => ({ ...s, error: errorText(e), loading: false }));
    }
  }, [method, key]);
  const topicKey = topics.join(",");
  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    load();
    // a burst (200 approvals at once, an event each) is one call, not one an event
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(topicKey ? topicKey.split(",") : [], () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        load();
      }, BATCH_MS);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [load, topicKey]);
  return { ...state, current: state.of === key, reload: load };
}

/** Rows a list page shows. */
export const PAGE = 50;

/**
 * Page `page` (from 0) of `task.list` or `approval.list`: their answer is newest-first lists one after the other (open
 * then closed, pending then decided), each paged alike by `limit`/`skip`; `parts` tells a row's list. Past the first
 * page each list holds still while rows land or leave above it (src/console/forms.ts › pageAt). `exact`: the whole
 * list is in the answer, so its length is its count.
 */
export function usePaged<T, K extends string>(
  method: string,
  page: number,
  topics: string[],
  parts: Record<K, (r: T) => boolean>,
  key: (r: T) => string | number,
) {
  const skip = page * PAGE;
  const input = pageWindow(skip, PAGE);
  const res = useCall<T[]>(method, input, topics);
  const anchors = useRef<{ page: number; at: Partial<Record<K, string | number>> }>({ page, at: {} });
  if (anchors.current.page !== page) anchors.current = { page, at: {} };
  const ready = !!res.data && res.current;
  const lists = {} as Record<K, { rows: T[]; more: boolean; exact: boolean }>;
  for (const k of Object.keys(parts) as K[]) {
    const all = ready ? (res.data ?? []).filter(parts[k]) : [];
    const p = pageAt(all, skip, PAGE, key, anchors.current.at[k]);
    // the row heading the page now heads it after the next reload too (or, gone, the row at `skip` does)
    if (ready && p.rows[0] !== undefined) anchors.current.at[k] = key(p.rows[0]);
    lists[k] = { ...p, exact: page === 0 && all.length < input.limit };
  }
  return { ...res, ready, lists };
}

// ---------------------------------------------------------------------------------------------------------------------
// What the methods answer

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  project: string | null;
  budget: { tokens: number; hours: number };
  usage: { tokens: number; runs?: number } | null;
  /** the proxy's count so far (usage is written when a session ends) */
  metered?: number;
  hours: number;
  summary: string | null;
  outcome: "done" | "failed" | null;
  created: string;
  updated: string;
  closed: string | null;
  cwd: string | null;
  error: string | null;
  runtime: "host" | "vm" | null;
  started: string | null;
  brief: string | null;
  scope: { credentials: string[]; repos: string[]; project?: string; dofs?: string[] } | null;
  /** pending approvals that wait on it */
  pending?: number;
}

/** A `replies` row: the Worker's stdout line, or the owner's own words in a chat. */
export type Line = StdoutLine | { type: "owner"; text: string };
export interface Row {
  seq: number;
  body: Line;
  created: string;
}

export interface Msg {
  seq: number;
  body: { from?: string; type?: string; text: string; author?: string; trusted?: boolean };
  created: string;
}

export interface TaskDetail {
  task: Task;
  replies: Row[];
  approvals: Approval[];
  inbox: Msg[];
  outbox: Msg[];
  schedules: Schedule[];
  origin?: { dof: string; channel: string; author: string | null; summary: string };
  tainted: string[];
  console_log?: string;
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "allowed"
  | "used"
  | "installing"
  | "rejected"
  | "expired"
  | "landed"
  | "replaced";

export interface Approval {
  id: number;
  kind: "request" | "login" | "grant";
  /** `credential:<name>`, `merge`, `transforms`, `origin:<site>` */
  category: string;
  task_id: string | null;
  task_title?: string;
  summary: Record<string, unknown>;
  status: ApprovalStatus;
  requested_at: string;
  decided_at: string | null;
  decided_by: "owner" | "judge" | null;
  reason: string | null;
  payload: { judge?: string; untrusted?: string[]; consequential?: boolean } | null;
  grantable: boolean;
}

export interface Credential {
  name: string;
  type: CredentialType;
  transform: string | null;
  hosts: string[] | null;
  last_use: string | null;
  /** its durable grant is given: under `auto`, the judge may pass its routine requests */
  enabled?: boolean;
}

export interface Captured {
  origin: string;
  cookies: number;
  tokens: number;
  last_use: string | null;
}

export interface Source {
  dof: string;
  type: string;
  connected: boolean;
  lastEvent?: string;
  error?: string;
  notes?: string[];
  scopes: { scope: string; last_sync: string | null }[];
  size?: string;
  deliveries_today?: number;
  last_delivery?: string | null;
  /** credentials the connector needs that the vault lacks */
  missing?: string[];
  /** forges: the path the service's webhook posts to, behind the owner's tunnel */
  webhook?: string;
  /** a GitHub App's `App <id>, installation <id>` */
  installation?: string;
  /** a GitHub forge's last hourly redelivery check */
  last_redelivery?: string;
  /** that check found deliveries the tunnel dropped */
  delivery_warning?: string;
}

export interface PlannerStatus {
  last?: string;
  routed: number;
  tokens: number;
  cap: number;
}

export interface Schedule {
  id: number;
  task_id: string;
  title: string | null;
  fire_at: string | null;
  every_sec: number | null;
  cron: string | null;
  tz: string | null;
  text: string;
  last_run: string | null;
  expires_at: string | null;
  summary: string | null;
}

export interface Snapshot {
  sha: string;
  ts: string;
  message: string;
}

export interface RemoteSession {
  id: number;
  device: string;
  created: string;
  last_seen: string;
  address: string;
  current: boolean;
}

export interface Passkey {
  id: number;
  device: string;
  created: string;
  last_use: string | null;
}

export interface RemoteStatus {
  listening: boolean;
  url?: string;
  cert?: string;
  /** this page came through the remote listener: enrolment codes are made at the machine */
  remote: boolean;
}

export interface DofFile {
  text: string;
  size: number;
  siblings: string[];
}
