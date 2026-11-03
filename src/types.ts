/**
 * Cross-module contracts. Every design doc under docs/design refers to these names; modules import them from here and
 * never redefine them. Config shapes live in config.ts (zod), everything else here.
 */
import type { Effort } from "@hortus/core";

// ---------------------------------------------------------------------------------------------------------------------
// RPC (00-foundation.md)

export type Role = "owner" | "core" | "worker" | "planner" | "login";

/** Who is calling: set by the transport (socket = owner, console = owner, proxy link = its role and task), never by the body. */
export interface Caller {
  role: Role;
  task?: string;
  /** console: the request came through the remote listener (10-remote-console.md); `session` is its row's hash */
  remote?: boolean;
  session?: string;
}

export type RpcCode = "not_found" | "forbidden" | "invalid" | "failed";

export class RpcError extends Error {
  constructor(
    public code: RpcCode,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Mirror (01-mirror-search.md)

/**
 * One file-level change in a DOF, relative to the DOF root (`<channel>/channel.md`, `<channel>/<thread>/<message>.md`,
 * `<channel>/<thread>/files/<id>-<name>`). `put` writes frontmatter+body (Markdown) or `bytes`; `patch` merges
 * frontmatter keys into an existing Markdown file (a null value removes the key; file missing → logged, skipped);
 * `delete` removes the file.
 */
export interface Change {
  op: "put" | "patch" | "delete";
  path: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
  bytes?: Buffer;
}

export interface DiffEntry {
  status: "A" | "M" | "D";
  path: string;
}

export interface SearchQuery {
  q: string;
  in?: string;
  author?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface SearchHit {
  dof: string;
  path: string;
  author: string;
  ts: string;
  title: string;
  snippet: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Connectors (02-slack-gateway.md, 17-github.md)

export interface Author {
  user: string;
  /** the service counts them a member (workspace user, guild member, chat member, repo collaborator) */
  member: boolean;
}

export interface Event {
  dof: string;
  /** the service's dedupe key (event_id, update_id, delivery guid) */
  key: string;
  /** ISO time of the event */
  ts: string;
  /** the service's own object; stored as events.payload */
  payload: unknown;
  /** null: no author, never trusted */
  author: Author | null;
  /** our bot or any bot: mirrored, never wakes the Planner */
  bot: boolean;
  /** one line for logs and the Planner batch */
  summary: string;
  /** task_refs keys this event belongs to: "<dof>:<channel>:<thread>" */
  refs: string[];
}

export interface Incoming {
  event: Event;
  /** sent after the insert, whatever the service wants (envelope ack, interaction callback, next offset, 200) */
  ack(): Promise<void>;
}

export interface Mirrored {
  changes: Change[];
  /** wake the Planner (messages and edits by non-bots; CI results only when their PR is in task_refs) */
  wake: boolean;
}

export interface ConnectorStatus {
  connected: boolean;
  lastEvent?: string;
  error?: string;
  /** connector-specific lines for the Sources page */
  notes?: string[];
}

export interface Connector {
  /** reconnects itself with backoff; yields nothing while down; ends when the signal aborts */
  events(signal: AbortSignal): AsyncIterable<Incoming>;
  /** may call the API (channel info on membership changes) */
  mirror(e: Event): Promise<Mirrored>;
  /** channels the bot is in (+ the owner's DM); forges: projects */
  scopes(): Promise<string[]>;
  /** backfill and the 10-min reconcile; absent where the service keeps no history (Telegram) */
  history?(scope: string, cursor: string | null): AsyncIterable<{ changes: Change[]; cursor: string }>;
  /** messengers: a note to the owner's DM (owner.notify) */
  dm?(owner: string, text: string): Promise<void>;
  status(): ConnectorStatus;
}

export interface Forge extends Connector {
  /** where the bot is installed, filtered by dofs.<name>.repos */
  projects(): Promise<string[]>;
  /** HTTPS git URL; the placeholder rides as basic:password through git's insteadOf */
  clone(project: string): string;
  /** the project whose repo mirror to fetch */
  pushed(e: Event): string | null;
  /** verify and parse one webhook delivery */
  webhook(req: { headers: Record<string, string>; body: Buffer }): Promise<{ ok: boolean; event?: Event }>;
  /** the delivery log, for the hourly redelivery check */
  redeliveries?(since: string): AsyncIterable<{ key: string; event: Event }>;
}

/** What a connector gets from hortusd. `fetch` is placeholder-aware: step 1 swaps from vault.json, step 2 is the pipeline. */
export interface ConnectorDeps {
  name: string;
  /** the dofs.<name> entry (config.ts DofConfig) */
  config: Record<string, unknown> & { type: string; owner?: string; trust?: unknown; api?: string; host?: string };
  log: Log;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** a WebSocket through the proxy as role core (Discord's gateway: the `ws:text` relay swaps IDENTIFY's placeholder) */
  ws?(url: string): Pick<WebSocket, "send" | "close" | "readyState" | "onmessage" | "onclose" | "onerror">;
  /** a ref is in task_refs (CI routing) */
  hasRef(ref: string): boolean;
}

export type ConnectorFactory = (deps: ConnectorDeps) => Promise<Connector>;

export interface Log {
  info(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, err?: unknown, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tasks (05-agent.md, 07-step3-runtime.md)

export type TaskKind = "chat" | "unattended" | "run" | "planner";
export type TaskStatus = "queued" | "running" | "waiting" | "done" | "failed";

export interface TaskScope {
  credentials: string[];
  /** forge projects as "<dof>:<project>" */
  repos: string[];
  /** a project from `projects` */
  project?: string;
}

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
}

/** tasks/<id>/ctl/task.json: everything the Worker needs, written by hortusd at every start. */
export interface TaskJson {
  id: string;
  kind: TaskKind;
  title: string;
  brief: string;
  scope: TaskScope;
  origins: "*" | string[];
  budget: { tokens: number; hours: number };
  /** hortusd's sum over earlier starts */
  hours_used: number;
  provider: string;
  model: string;
  effort?: Effort;
  context_window: number;
  tz: string;
  paths: {
    /** DOF root: host `~/.hortus/dof`, VM `/dof` */
    dof: string;
    /** forge repo mirrors: host `~/.hortus/repos`, VM `/repos` */
    repos?: string;
    /** scratch: out/work */
    work: string;
    /** the project clone (unattended host) or where to clone it (VM): URL in `clone_url` */
    clone?: string;
    /** a run's persistent directory (3c) */
    schedule?: string;
  };
  /** the origin to clone (unattended project tasks) */
  clone_url?: string;
  /** chat: the owner's projects */
  projects?: Record<string, { path: string; main: string; runtime: "host" | "vm" }>;
  /** chat: the CLI's cwd */
  cwd?: string;
  /** 3h: the placeholder cookie jar */
  cookies?: Cookie[];
  /** 3c: a run's script */
  script?: string;
  /** "https://hortusd.internal" */
  rpc: string;
  /** tool sets enabled: "merge", "schedule", "browser" */
  features: string[];
}

/** tasks/<id>/ctl/inbox/<seq>.json */
export interface InboxMsg {
  seq: number;
  /** "owner" | "console" | "planner" | "approval" | "merge" | "rebase" | "cookies" | "schedule:<id>" | "<dof>:<channel>:<thread>" */
  from: string;
  author?: string;
  trusted: boolean;
  text: string;
  data?: unknown;
  ts: string;
}

/** tasks/<id>/out/outbox/<seq>.json */
export interface OutboxMsg {
  seq: number;
  type: "reply" | "result" | "budget_exceeded";
  text: string;
  ts: string;
}

/** One JSON line on the Worker's stdout. */
export type StdoutLine =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError?: boolean }
  | { type: "message"; role: "user" | "assistant" | "tool" }
  | { type: "status"; text: string }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------------------------------------------------
// Vault and transforms (03-vault-proxy.md)

export type CredentialType = "token" | "github-app" | "webhook-secret" | "aws";

export type Credential =
  | { type: "token"; value: string }
  | { type: "github-app"; appId: number; installationId: number; privateKey: string }
  | { type: "webhook-secret"; value: string }
  | { type: "aws"; keyId: string; secret: string };

/** One vault.json entry. `hosts` overrides the manifest's (v7). */
export type VaultEntry = Credential & { transform?: string; hosts?: string[]; last_use?: string };

/** Where a raw secret may appear in a request. */
export type Location =
  | `header:${string}`
  | "basic:password"
  | `form:${string}`
  | `query:${string}`
  | `path:${string}`
  | "ws:text";

export interface Manifest {
  name: string;
  credentials: Record<string, { type: CredentialType; hosts: string[]; locations: Location[] }>;
  /** URL patterns with {project}: the credential rides only on a match whose project is in scope.repos */
  scope?: string[];
  /** "METHOD host/path" globs (* and **): approval per request */
  consequential?: string[];
  /** 3h: what a site transform captures from responses */
  captures?: unknown[];
}

export interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** null when streaming (large or git/octet bodies): the transform may only touch url and headers */
  body: string | null;
  stream: boolean;
}

/** A Req whose values may hold handles: {secret:name}, {basic:user:name}, {sign:op(json-args)} */
export type Template = Req;

export interface Res {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

export interface ResponseResult {
  res: Res;
  capture?: { name: string; value: string; origin: string; kind?: string; meta?: Record<string, unknown> }[];
  /** extend the task's scope.repos (only from an approved consequential request) */
  repos?: string[];
  /** created thread / issue / PR keys for task_refs */
  refs?: string[];
}

/** What the Approvals page shows for one entry; the shape depends on `kind`/`category`. */
export type ApprovalSummary = Record<string, unknown>;
