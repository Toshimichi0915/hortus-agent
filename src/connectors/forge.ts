/**
 * What every forge connector shares: the in-process event queue the webhook listener fills, the
 * project → directory rule, and the `repos` glob filter.
 */
import type { Change, ConnectorDeps, Event, Incoming } from "../types.ts";

/** An event's author is who acted, so `trusted` and the owner's plain rendering are theirs: the text of what they acted on
 * stays out when someone else wrote it. The owner's label on a stranger's issue put its body before the Planner, as the
 * owner's own unquoted order and with `scope.project` open (round 19). */
export const NOT_THEIRS = "(its text is someone else's: read it in the mirror)";

/** How a PR or MR's end, or its reopening, opens an event's summary (each connector's `<type>.<action>`). */
export const PR_TURN =
  /^(pull_request\.(merged|closed|reopened)|merge_request\.(merge|close|reopen)|pullrequest:(fulfilled|rejected)) /;

/**
 * The PR or MR a request's path merges, as the tail of its ref (`o/r:!1`). Only a merge: a comment on an ended PR can still
 * be posted, and it may be the Worker's reply.
 * ponytail: REST by project name only. A GraphQL merge (`gh pr merge`, whose body names a node id) or GitLab's numeric
 * project id names none, so that request stays until it is decided or expires.
 */
export function mergeTarget(path: string): string | undefined {
  const m =
    /\/(?:repos\/(.+?)\/pulls|projects\/(.+?)\/merge_requests|repositories\/(.+?)\/pullrequests)\/(\d+)\/merge(?:[/?]|$)/.exec(
      path.replace(/%2F/gi, "/"),
    );
  return m ? `${m[1] ?? m[2] ?? m[3]}:!${m[4]}` : undefined;
}

/**
 * The webhook listener's hand-off to the gateway loop. `push` queues one event and resolves when the gateway acks it
 * (after its INSERT, before any mirror work), so the listener answers `200` only once the row exists. One consumer.
 */
export function eventQueue(): { push(e: Event): Promise<void>; events(signal: AbortSignal): AsyncIterable<Incoming> } {
  const items: Incoming[] = [];
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    push: (event) =>
      new Promise<void>((resolve) => {
        items.push({ event, ack: async () => resolve() });
        notify();
      }),
    async *events(signal) {
      signal.addEventListener("abort", notify);
      try {
        while (!signal.aborted) {
          const item = items.shift();
          if (item) yield item;
          else await new Promise<void>((r) => (wake = r));
        }
      } finally {
        signal.removeEventListener("abort", notify);
      }
    },
  };
}

/** A channel id with `/` would nest in the mirror: `owner/repo` lives in `owner__repo/`. */
export const dirOf = (project: string): string => project.replace(/\//g, "__");

/** git over HTTPS per forge type: the Basic user it wants and its host; Bitbucket is cloud only. */
export function gitOf(d: { type: string; host?: string | undefined }): { user: string; host: string } | undefined {
  if (d.type === "github") return { user: "x-access-token", host: d.host ?? "github.com" };
  if (d.type === "gitlab") return { user: "oauth2", host: d.host ?? "gitlab.com" };
  if (d.type === "bitbucket") return { user: "x-token-auth", host: "bitbucket.org" };
  return undefined;
}

/** `dofs.<name>.repos` globs: `*` one segment, `**` anything; none configured → every project. */
export function matches(project: string, globs: string[] | undefined): boolean {
  if (!globs?.length) return true;
  return globs.some((g) => {
    const src = g
      .split(/(\*\*|\*)/)
      .map((s) => (s === "**" ? ".*" : s === "*" ? "[^/]*" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("");
    return new RegExp(`^${src}$`).test(project);
  });
}

/** CI conclusions: anything that is not a pass is a failure; a suite still running makes the whole `pending`. */
export function worst(suites: { status: string; conclusion: string | null }[]): string | null {
  if (!suites.length) return null;
  if (suites.some((s) => s.status !== "completed")) return "pending";
  const ok = new Set(["success", "neutral", "skipped"]);
  return suites.every((s) => ok.has(s.conclusion ?? "")) ? "success" : "failure";
}

// ---------------------------------------------------------------------------------------------------------------------
// shared by the static-token forges

/** An HTTP error with its status (a member lookup's 404 is an answer, not a failure). */
export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * GETs against `api` through `deps.fetch` (role core): redirects followed (Bitbucket's `/diff`), `all` pages by
 * `Link: rel="next"` (GitLab) or the body's `next` (Bitbucket), `key` picking the list out of an object body.
 */
export function rest(deps: Pick<ConnectorDeps, "name" | "fetch">, api: string, headers: Record<string, string>) {
  async function get(url: string, hops = 3): Promise<Response> {
    const abs = url.startsWith("http") ? url : `${api}${url}`;
    const res = await deps.fetch(abs, { headers, redirect: "manual" });
    const to = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && to && hops > 0) {
      await res.body?.cancel();
      return get(new URL(to, abs).href, hops - 1);
    }
    if (!res.ok) {
      const why = (await res.text()).slice(0, 200); // Sources shows this line: "HTTP 401" alone says nothing to fix
      throw new HttpError(`${deps.name} GET ${url}: HTTP ${res.status} ${why}`.trim(), res.status);
    }
    return res;
  }
  const json = async <T>(url: string): Promise<T> => (await (await get(url)).json()) as T;
  async function all<T>(url: string, key?: string): Promise<T[]> {
    const out: T[] = [];
    for (let next: string | undefined = url; next; ) {
      const res = await get(next);
      const b = (await res.json()) as Record<string, unknown> | T[];
      out.push(...((key ? (b as Record<string, T[]>)[key] : b) as T[]));
      next =
        res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ??
        (Array.isArray(b) ? undefined : (b.next as string | undefined));
    }
    return out;
  }
  return { get, json, all };
}

/** `f` memoized per key for `ms` (member checks: 1 h); a rejection is not cached. */
export function cached<V>(ms: number, f: (key: string) => Promise<V>): (key: string) => Promise<V> {
  const m = new Map<string, { at: number; v: V }>();
  return async (key) => {
    const hit = m.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.v;
    const v = await f(key);
    m.set(key, { at: Date.now(), v });
    return v;
  };
}

/** Webhook and API timestamps (`…+00:00`, GitLab's older `2026-11-04 10:00:00 UTC`) as `YYYY-MM-DDTHH:MM:SSZ`. */
export function iso(s: string | null | undefined): string {
  const d = s ? new Date(s) : new Date();
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().replace(/\.\d+Z$/, "Z");
}

/** `Change.ci` of a PR head's CI: a result only (success or failure), with the run it is, as a re-run's same result is
 * news too. Undefined without either. */
export function ciOf(sha: string, checks: string | null, run: string | number | undefined): Change["ci"] {
  if ((checks !== "success" && checks !== "failure") || run === undefined || run === "") return undefined;
  return { sha: sha.slice(0, 12), result: checks, run: String(run) };
}

/**
 * What a reconcile routes of a task's open PR's CI result (gateway › missed): its hook was missed in an outage, or it
 * came before the PR existed (a push's pipeline done before the Worker's PR, whose own opening is a bot's and wakes
 * nothing). Nobody's words, as live: no author.
 */
export function ciHeard(o: {
  path: string;
  ref: string;
  type: string;
  where: string;
  sha: string;
  ci: Change["ci"];
  at: string | undefined;
}): Change[] {
  if (!o.ci) return [];
  const summary = `${o.type} ${o.where} by ?: ${o.ci.result} on ${o.sha.slice(0, 7)}`;
  const heard = { author: null, bot: false, summary, refs: [o.ref], ts: iso(o.at) };
  return [{ op: "patch", path: o.path, frontmatter: { checks: o.ci.result }, heard, ci: o.ci }];
}
