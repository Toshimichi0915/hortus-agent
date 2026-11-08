/**
 * Cross-module contracts. Modules import them from here and
 * never redefine them. Config shapes live in config.ts (zod), everything else here.
 */
import type { Effort } from "@hortus/core";

// ---------------------------------------------------------------------------------------------------------------------
// RPC

export type Role = "owner" | "core" | "worker" | "planner" | "login";

/** Who is calling: set by the transport (socket = owner, console = owner, proxy link = its role and task), never by the body. */
export interface Caller {
  role: Role;
  task?: string;
  /** console: the request came through the remote listener; `session` is its row's hash */
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
// Mirror

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
  /** history only: who this object is, should the live event for it have been missed (gateway › reconcile) */
  heard?: Heard;
  /** a CI result on the PR's head, live or read back, and the run it came from: the key both name, so one of the two
   * routes it (gateway › missed) */
  ci?: { sha: string; result: string; run: string };
}

/** What a reconcile routes for an object the mirror does not hold yet: the live event's fields, by the live rules. */
export interface Heard {
  author: Author | null;
  bot: boolean;
  summary: string;
  refs: string[];
  /** when it happened, where that is not `frontmatter.ts` (a PR's end) */
  ts?: string;
  /** a PR's: a change of state counts too, not only a new file */
  state?: string;
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
// Connectors

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
  /** verify and parse one webhook delivery (`ok` without `event`: verified, nothing to route, e.g. `ping`) */
  webhook(req: { headers: Record<string, string>; body: Buffer }): Promise<{ ok: boolean; event?: Event }>;
  /** hand an event to `events()` (the webhook listener's queue); resolves once the gateway inserted or deduped it */
  enqueue(e: Event): Promise<void>;
  /** the delivery log since `since`, skipping keys `seen` knows (in `events`), for the hourly redelivery check */
  redeliveries?(since: string, seen: (key: string) => boolean): AsyncIterable<{ key: string; event: Event }>;
}

/** What a connector gets from hortusd. `fetch` is placeholder-aware: the proxy pipeline (tests: a direct swap from vault.json). */
export interface ConnectorDeps {
  name: string;
  /** the dofs.<name> entry (config.ts DofConfig) */
  config: Record<string, unknown> & { type: string; owner?: string; trust?: unknown; api?: string; host?: string };
  log: Log;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** aborted when a stop's grace ends, as every `fetch` above is: a connector's own waits end with it */
  signal?: AbortSignal;
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
// Tasks

export type TaskKind = "chat" | "unattended" | "run" | "planner";
export type TaskStatus = "queued" | "running" | "waiting" | "done" | "failed";

export interface TaskScope {
  credentials: string[];
  /** forge projects as "<dof>:<project>" */
  repos: string[];
  /** a project from `projects` */
  project?: string;
  /**
   * The DOFs the task can read (mounted, searchable). Unset in the row: every DOF (chats, Planner
   * batches). Always set in task.json.
   */
  dofs?: string[];
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
  /** `usd` only when the model has a price (none: no spending limit); `tokens` is a Planner batch's share of
   * `daily_tokens` */
  budget: { usd?: number; tokens?: number; hours: number };
  /** the rates of `model` from `prices`, for the Worker's own count */
  price?: ModelPrice;
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
  /** the plain clone URL of each `scope.repos` entry */
  repo_urls?: Record<string, string>;
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
  /** tool sets enabled: "merge", "schedule", "browser", "settings" */
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
// Vault and transforms

export type CredentialType = "token" | "github-app" | "webhook-secret" | "aws";

export type Credential =
  | { type: "token"; value: string }
  | { type: "github-app"; appId: number; installationId: number; privateKey: string }
  | { type: "webhook-secret"; value: string }
  | { type: "aws"; keyId: string; secret: string };

/** One vault.json entry. `hosts` overrides the manifest's. */
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
  /** forges: defaults for `{host}`/`{api}` in hosts and patterns (`host_api`: the api of a configured `host`) */
  vars?: { host: string; api: string; host_api?: string };
}

export interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** null when streaming (large or git/octet bodies): the transform may only touch url and headers */
  body: string | null;
  stream: boolean;
}

/** A Req whose values may hold handles: {secret:name}, {basic:user:name}, {sign:op(json-args)}. `read`: the transform
 * vouches for a request a consequential pattern matches (one URL for reads and writes: GraphQL) */
export type Template = Req & { read?: boolean };

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

/**
 * What a cache read counts for against a budget, about its price next to a fresh input token. ponytail: one weight for
 * every provider (Anthropic's reads cost 0.1, OpenAI's 0.25-0.5); a per-provider weight in config if that bites.
 */
export const CACHED_WEIGHT = 0.1;

/**
 * Tokens a model call counts against `daily_tokens`, and what a task's card shows when its model has no price. `input`
 * includes `cached`, as core and the proxy both report it: counted whole, every call re-read the whole context and a
 * long conversation spent the limit at a rate quadratic in its length.
 */
export function budgetTokens(u: { input: number; output: number; cached?: number }): number {
  const cached = Math.min(u.cached ?? 0, u.input);
  return u.input - cached + Math.ceil(cached * CACHED_WEIGHT) + u.output;
}

/** One model's rates in dollars per million tokens (`prices` in hortusd.json). */
export interface ModelPrice {
  input: number;
  cached: number;
  /** a cache write; unset: at `input` (OpenAI's cost no more than input) */
  cache_write?: number;
  output: number;
}

/**
 * A model's rates at a provider (`prices` by credential name, as hosts charge differently for one model): its own, or
 * those of the longest listed name it extends, as an API answers `gpt-6-2026-01-01` to a call for `gpt-6`.
 */
export function priceOf(
  prices: Record<string, Record<string, ModelPrice>>,
  provider: string | undefined,
  model: string | undefined,
): ModelPrice | undefined {
  if (!provider || !model || !Object.hasOwn(prices, provider)) return undefined;
  const listed = prices[provider] as Record<string, ModelPrice>;
  if (Object.hasOwn(listed, model)) return listed[model];
  const name = Object.keys(listed)
    .filter((k) => model.startsWith(`${k}-`) || model.startsWith(`${k}:`))
    .sort((a, b) => b.length - a.length)[0];
  return name === undefined ? undefined : listed[name];
}

/**
 * Each rate at its highest over one provider's models: what a call to a model with no price costs a task whose budget
 * counts. Another provider's rates say nothing of this one's.
 */
export function highestPrice(listed: Record<string, ModelPrice>): ModelPrice {
  const all = Object.values(listed);
  const top = (f: (p: ModelPrice) => number) => Math.max(0, ...all.map(f));
  return {
    input: top((p) => p.input),
    cached: top((p) => p.cached),
    cache_write: top((p) => p.cache_write ?? p.input),
    output: top((p) => p.output),
  };
}

/**
 * Dollars of one model call. `input` includes `cached` and `written`, as core and the proxy report it. ponytail: one rate
 * per token type, so a provider's surcharge past a prompt size is not counted; tiers in `prices` if that bites.
 */
export function usageCost(
  u: { input: number; output: number; cached?: number; written?: number },
  p: ModelPrice,
): number {
  const cached = Math.min(u.cached ?? 0, u.input);
  const written = Math.min(u.written ?? 0, u.input - cached);
  return (
    ((u.input - cached - written) * p.input +
      cached * p.cached +
      written * (p.cache_write ?? p.input) +
      u.output * p.output) /
    1e6
  );
}

/** A budget stop the owner's raise alone starts again (task.budget writes "go on"); the task's card says so. */
export const GOES_ON = /^budget_exceeded: (budget exceeded|the session was stopped)/;
