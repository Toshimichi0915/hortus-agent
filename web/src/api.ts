/**
 * The console API as the pages use it, and the one door to it. `call(method, input)` is `POST /api/<method>` (role
 * owner, `X-Hortus: 1`); `subscribe(topics)` and `streamRows` share the page's one SSE stream (src/console/live.ts).
 * `VITE_MOCK=1` (`pnpm web`) answers from the pretend hortusd in mock.ts instead, which a production bundle leaves out.
 *
 * ponytail: what the pages read beyond today's daemon: `login.frame` (the mock's stand-in for the `/events/login`
 * frames, CONNECT.md's step 5).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Config } from "../../src/config.ts";
import type { CredentialType, SearchHit, StdoutLine, TaskKind, TaskStatus } from "../../src/types.ts";
import { liveStream } from "../../src/console/live.ts";
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
const watch =
  import.meta.env.VITE_MOCK === "1" ? undefined : liveStream(bus, (url) => new EventSource(url), reconnecting.set);

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

/**
 * `method(input)`, again on each event of `topics`; `null` calls nothing. An answer to an older input never replaces
 * a newer one.
 */
export function useCall<T>(method: string | null, input: unknown = {}, topics: string[] = []) {
  const key = JSON.stringify(input);
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: !!method });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    if (!method) return setState({ loading: false });
    try {
      const data = await call<T>(method, JSON.parse(key));
      if (n === seq.current) setState({ data, loading: false });
    } catch (e) {
      if (n === seq.current) setState((s) => ({ ...s, error: errorText(e), loading: false }));
    }
  }, [method, key]);
  const topicKey = topics.join(",");
  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    load();
    return subscribe(topicKey ? topicKey.split(",") : [], load);
  }, [load, topicKey]);
  return { ...state, reload: load };
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

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "landed" | "replaced";

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

export type LoginField = "email" | "password";

/** The mock's stand-in for the login view's screencast frames (`/events/login?id=`). */
export interface LoginFrame {
  email: string;
  /** masked, as the site's own field would show it */
  password: string;
  focus: LoginField | null;
  signedIn: boolean;
}

export interface DofFile {
  text: string;
  size: number;
  siblings: string[];
}
