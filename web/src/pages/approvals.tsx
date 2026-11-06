/**
 * Approvals: what waits for the owner (a credentialed request, a merge, a new transform, a login, a grant), said in
 * plain words with the request itself below; the history; and the live login view.
 */
import { type ReactNode, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type Approval, type ApprovalStatus, call, type LoginField, type LoginFrame, useCall } from "../api.ts";
import { CodeBlock } from "../markdown.tsx";
import {
  buttonVariants,
  Button,
  Callout,
  cn,
  Empty,
  errorText,
  Icon,
  type IconName,
  Link,
  Page,
  Pill,
  RelTime,
  SecretField,
  Spinner,
  Switch,
  Tabs,
  TextField,
  toast,
  useAction,
} from "../ui.tsx";

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const credName = (cat: string) => (cat.startsWith("credential:") ? cat.slice("credential:".length) : cat);
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
const VERB: Record<string, string> = {
  GET: "Read from",
  HEAD: "Read from",
  POST: "Send to",
  PUT: "Change on",
  PATCH: "Change on",
  DELETE: "Delete on",
};
const taskLink = (a: Approval) => `/tasks/${a.task_id}`;

/** One line for lists: "Send to slack.com (slack)". */
export function approvalTitle(a: Approval): string {
  const s = a.summary;
  if (a.category === "merge") return `Merge a change into ${str(s.project)}`;
  if (a.category === "transforms") return `${s.new ? "Install" : "Update"} the transform ${str(s.name)}`;
  if (a.kind === "login") return `Sign in to ${hostOf(str(s.origin))}`;
  if (a.kind === "grant") {
    if (a.category.startsWith("origin:")) return `Reuse your login for ${hostOf(a.category.slice(7))}`;
    const name = str(s.grant) || credName(a.category);
    return a.task_id ? `Let this task use ${name}` : `Let the judge handle ${name}`;
  }
  return `${VERB[str(s.method)] ?? str(s.method)} ${str(s.host)} (${credName(a.category)})`;
}

function head(a: Approval): { icon: IconName; title: ReactNode } {
  const s = a.summary;
  if (a.category === "merge")
    return {
      icon: "merge",
      title: (
        <>
          Merge a change into <b>{str(s.project)}</b>
        </>
      ),
    };
  if (a.category === "transforms")
    return {
      icon: "code",
      title: (
        <>
          {s.new ? "Install" : "Update"} the transform <b>{str(s.name)}</b>
        </>
      ),
    };
  if (a.kind === "login")
    return {
      icon: "lock",
      title: (
        <>
          Sign in to <b>{hostOf(str(s.origin))}</b>
        </>
      ),
    };
  if (a.kind === "grant") {
    if (a.category.startsWith("origin:"))
      return {
        icon: "globe",
        title: (
          <>
            Reuse your login for <b>{hostOf(a.category.slice(7))}</b>
          </>
        ),
      };
    const name = str(s.grant) || credName(a.category);
    return {
      icon: "key",
      title: a.task_id ? (
        <>
          Let this task use <b>{name}</b>
        </>
      ) : (
        <>
          Let the judge handle <b>{name}</b> for every task
        </>
      ),
    };
  }
  return {
    icon: str(s.method) === "DELETE" ? "trash" : str(s.method) === "GET" ? "globe" : "send",
    title: (
      <>
        {VERB[str(s.method)] ?? str(s.method)} <b>{str(s.host)}</b>{" "}
        <span
          className="inline-flex h-5 items-center gap-1 rounded-full border px-2 text-xs font-medium bg-muted text-foreground/80 h-4.5 px-1.5 text-[11px]"
          title="The credential this request uses"
        >
          <Icon name="key" size={12} /> {credName(a.category)}
        </span>
      </>
    ),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// What is asked

function RequestView({ s }: { s: Record<string, unknown> }) {
  const headers = Object.entries((s.headers ?? {}) as Record<string, unknown>);
  const body = str(s.bodyPreview);
  let pretty = body;
  let lang = "";
  try {
    pretty = JSON.stringify(JSON.parse(body), null, 2);
    lang = "json";
  } catch {}
  const method = str(s.method);
  const placeholder = JSON.stringify(s).includes("hortus-secret-");
  return (
    <div className="flex flex-col gap-2 *:data-[slot=button]:self-start">
      <p className="flex flex-wrap items-baseline gap-2">
        <span
          className={cn(
            "rounded-md px-1.5 py-1 font-mono text-[11.5px] leading-none font-semibold",
            method === "DELETE"
              ? "bg-destructive/10 text-destructive"
              : method === "GET" || method === "HEAD"
                ? "bg-success/10 text-success"
                : "bg-brand/10 text-brand-text",
          )}
        >
          {method}
        </span>
        <code className="text-[13px] wrap-anywhere">
          {str(s.host)}
          <span className="text-muted-foreground">{str(s.path)}</span>
        </code>
      </p>
      {body &&
        (pretty.length > 900 ? (
          <details className="[&>summary]:cursor-pointer [&>summary]:text-[13px] [&>summary]:font-medium [&>summary]:text-foreground/80 [&[open]>summary]:mb-2 [&>pre]:max-h-72 [&>pre]:overflow-auto [&>pre]:rounded-md [&>pre]:border [&>pre]:bg-muted/50 [&>pre]:p-2.5 [&>pre]:text-xs [&>pre]:wrap-anywhere [&>pre]:whitespace-pre-wrap">
            <summary>What it sends ({body.length.toLocaleString()} characters)</summary>
            <CodeBlock code={pretty} lang={lang} />
          </details>
        ) : (
          <CodeBlock code={pretty} lang={lang} />
        ))}
      {!!s.rendered && <CodeBlock code={str(s.rendered)} />}
      {headers.length > 0 && (
        <details className="[&>summary]:cursor-pointer [&>summary]:text-[13px] [&>summary]:font-medium [&>summary]:text-foreground/80 [&[open]>summary]:mb-2 [&>pre]:max-h-72 [&>pre]:overflow-auto [&>pre]:rounded-md [&>pre]:border [&>pre]:bg-muted/50 [&>pre]:p-2.5 [&>pre]:text-xs [&>pre]:wrap-anywhere [&>pre]:whitespace-pre-wrap">
          <summary>Headers ({headers.length})</summary>
          <table className="w-full text-xs [&_td]:py-1 [&_td]:wrap-anywhere [&_th]:py-1 [&_th]:pr-3 [&_th]:text-left [&_th]:align-top [&_th]:font-mono [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-muted-foreground">
            <tbody>
              {headers.map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td>
                    <code>{str(v)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {placeholder && (
        <p className="text-muted-foreground text-[13px] flex flex-wrap items-center gap-2">
          <Icon name="lock" size={14} />
          <span>
            <code>hortus-secret-…</code> is a placeholder: the proxy puts the real secret in only if you approve.
          </span>
        </p>
      )}
    </div>
  );
}

function MergeView({ s, full }: { s: Record<string, unknown>; full?: boolean }) {
  const patch = str(s.patch);
  const lines = patch.split("\n");
  const [all, setAll] = useState(!!full);
  const n = Number(s.files ?? 0);
  return (
    <div className="flex flex-col gap-2 *:data-[slot=button]:self-start">
      <p className="flex flex-wrap items-center gap-1.5 [&_code]:rounded-md [&_code]:border [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:text-xs">
        <code>{str(s.branch)}</code>
        <Icon name="arrowRight" size={14} />
        <code>main</code>
        <span className="text-muted-foreground text-[13px]">at {str(s.main_sha).slice(0, 7)}</span>
      </p>
      <p className="font-mono text-[13px]">
        <span className="text-success">+{str(s.added)}</span>{" "}
        <span className="text-destructive">−{str(s.removed)}</span>{" "}
        <span className="text-muted-foreground">
          in {n} file{n === 1 ? "" : "s"}
        </span>
      </p>
      {patch && <CodeBlock code={all ? patch : lines.slice(0, 24).join("\n")} lang="diff" />}
      {!all && lines.length > 24 && (
        <button
          type="button"
          className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-brand-text hover:underline"
          onClick={() => setAll(true)}
        >
          Show the whole diff ({lines.length} lines)
        </button>
      )}
    </div>
  );
}

interface Missing {
  name: string;
  type: string;
}

const CRED_FIELDS: Record<string, { key: string; label: string; secret?: boolean; multiline?: boolean }[]> = {
  token: [{ key: "value", label: "Token", secret: true }],
  "webhook-secret": [{ key: "value", label: "Secret", secret: true }],
  "github-app": [
    { key: "appId", label: "App ID" },
    { key: "installationId", label: "Installation ID" },
    { key: "privateKey", label: "Private key (PEM)", secret: true, multiline: true },
  ],
  aws: [
    { key: "keyId", label: "Access key ID", secret: true },
    { key: "secret", label: "Secret access key", secret: true },
  ],
};

function TransformView({
  s,
  pending,
  values,
  onValues,
}: {
  s: Record<string, unknown>;
  pending: boolean;
  values: Record<string, Record<string, string>>;
  onValues: (v: Record<string, Record<string, string>>) => void;
}) {
  const creds = Object.entries((s.credentials ?? {}) as Record<string, { hosts: string[]; locations: string[] }>);
  const missing = (s.missing ?? []) as Missing[];
  return (
    <div className="flex flex-col gap-2 *:data-[slot=button]:self-start">
      {creds.map(([name, c]) => (
        <p key={name}>
          Puts <code>{name}</code> into <code>{c.locations.join(", ")}</code> on <code>{c.hosts.join(", ")}</code>,
          nowhere else.
        </p>
      ))}
      <p className="flex flex-wrap items-center gap-2">
        <Pill tone="ok">
          <Icon name="check" size={13} /> {str(s.tests ?? 0)} tests passed in the sandbox
        </Pill>
        {!!s.codeChanged && <Pill>{str(s.codeChanged)} lines of code changed</Pill>}
      </p>
      <details className="[&>summary]:cursor-pointer [&>summary]:text-[13px] [&>summary]:font-medium [&>summary]:text-foreground/80 [&[open]>summary]:mb-2 [&>pre]:max-h-72 [&>pre]:overflow-auto [&>pre]:rounded-md [&>pre]:border [&>pre]:bg-muted/50 [&>pre]:p-2.5 [&>pre]:text-xs [&>pre]:wrap-anywhere [&>pre]:whitespace-pre-wrap">
        <summary>{s.new ? "Manifest" : "What changed in the manifest"}</summary>
        <CodeBlock code={str(s.new ? s.manifest : s.manifestDiff)} lang={s.new ? "json" : "diff"} />
      </details>
      {pending && missing.length > 0 && (
        <div className="rounded-lg border bg-muted/50 p-3.5 flex flex-col gap-2 *:data-[slot=button]:self-start">
          <p className="text-sm font-medium">Its credentials</p>
          <p className="text-muted-foreground text-[13px]">
            Enter them now, or later in Settings › Credentials. hortus never shows them again.
          </p>
          {missing.map((m) =>
            (CRED_FIELDS[m.type] ?? []).map((f) => {
              const value = values[m.name]?.[f.key] ?? "";
              const set = (v: string) => onValues({ ...values, [m.name]: { ...values[m.name], [f.key]: v } });
              const label = (
                <>
                  <code>{m.name}</code> {f.label}
                </>
              );
              return f.secret ? (
                <SecretField key={m.name + f.key} label={label} value={value} onChange={set} multiline={f.multiline} />
              ) : (
                <TextField key={m.name + f.key} label={label} value={value} onChange={set} mono />
              );
            }),
          )}
        </div>
      )}
    </div>
  );
}

function Body({
  a,
  full,
  values,
  onValues,
}: {
  a: Approval;
  full?: boolean;
  values: Record<string, Record<string, string>>;
  onValues: (v: Record<string, Record<string, string>>) => void;
}) {
  const s = a.summary;
  if (a.category === "merge") return <MergeView s={s} full={full} />;
  if (a.category === "transforms")
    return <TransformView s={s} pending={a.status === "pending"} values={values} onValues={onValues} />;
  if (a.kind === "login")
    return (
      <div className="flex flex-col gap-2 *:data-[slot=button]:self-start">
        <p>{str(s.why)}</p>
        <p className="flex flex-wrap items-baseline gap-2">
          <code className="text-[13px] wrap-anywhere">{str(s.url)}</code>
        </p>
        <p className="text-muted-foreground text-[13px]">
          You sign in yourself, in a live view of the site. The task never sees your password: it gets placeholders for
          the cookies the site sets.
        </p>
      </div>
    );
  if (a.kind === "grant")
    return (
      <div className="flex flex-col gap-2 *:data-[slot=button]:self-start">
        <p>
          {a.category.startsWith("origin:")
            ? "The task wants to use the login you stored for this site."
            : a.task_id
              ? `The task's scope does not include ${credName(a.category)}. Allowing it covers this task only.`
              : `Under the judge policy, routine requests with ${str(s.grant) || credName(a.category)} then pass without asking you. Pushes, merges, deletes and anything the judge doubts still come to you.`}
        </p>
        {!!s.method && (
          <>
            <p className="text-muted-foreground text-[13px]">The request that asked:</p>
            <RequestView s={s} />
          </>
        )}
      </div>
    );
  return <RequestView s={s} />;
}

function Why({ a }: { a: Approval }) {
  const p = a.payload ?? {};
  if (p.untrusted?.length)
    return (
      <Callout tone="warning" title="This task read untrusted text">
        {p.untrusted.join("; ")}. Make sure this is what <em>you</em> want, not what they asked for.
      </Callout>
    );
  if (p.judge)
    return (
      <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-[13px] text-foreground/80 [&>svg]:mt-0.5 [&>svg]:text-muted-foreground">
        <Icon name="scale" size={15} /> <span>The judge passed this to you: {p.judge}</span>
      </p>
    );
  if (p.consequential || a.category === "merge")
    return (
      <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-[13px] text-foreground/80 [&>svg]:mt-0.5 [&>svg]:text-muted-foreground">
        <Icon name="alert" size={15} /> <span>It changes something that is hard to undo, so it always asks you.</span>
      </p>
    );
  return null;
}

const TILE = "grid flex-none place-items-center rounded-lg";
const TONE = {
  warning: "bg-warning/10 text-warning",
  neutral: "bg-muted text-muted-foreground",
  ok: "bg-success/10 text-success",
  danger: "bg-destructive/10 text-destructive",
};

const DECIDED: Record<Exclude<ApprovalStatus, "pending">, { icon: IconName; tone: keyof typeof TONE }> = {
  approved: { icon: "check", tone: "ok" },
  landed: { icon: "merge", tone: "ok" },
  rejected: { icon: "x", tone: "danger" },
  expired: { icon: "clock", tone: "neutral" },
  replaced: { icon: "refresh", tone: "neutral" },
};

function decisionText(a: Approval): string {
  if (a.status === "landed") return `Merged as ${str(a.summary.sha).slice(0, 7)}`;
  if (a.status === "approved") return a.decided_by === "judge" ? "Allowed by the judge" : "Approved by you";
  if (a.status === "rejected") return a.decided_by === "owner" ? "Rejected by you" : "Rejected";
  if (a.status === "expired") return "Expired";
  return "Replaced";
}

/** Approved but not landed: a merge whose checkout was dirty, say. Retry lands it once that is fixed. */
const stuck = (a: Approval) =>
  a.category === "merge" && a.status === "approved" && a.decided_by === "owner" && !!a.reason;

function Decision({ a }: { a: Approval }) {
  const [retry, busy] = useAction(() => call("merge.retry", { id: a.id }));
  if (a.status === "pending") return null;
  if (stuck(a))
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted px-3 py-2 text-[13px] text-foreground/80 [&>button]:ml-auto bg-destructive/10 [&>svg]:text-destructive">
        <Icon name="alert" size={16} />
        <span>
          <b>Approved, but not merged:</b> {a.reason}
        </span>
        <Button size="sm" icon="refresh" loading={busy} onClick={() => retry()}>
          Retry
        </Button>
      </div>
    );
  const d = DECIDED[a.status];
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg bg-muted px-3 py-2 text-[13px] text-foreground/80 [&>button]:ml-auto",
        d.tone === "ok"
          ? "[&>svg]:text-success"
          : d.tone === "danger"
            ? "[&>svg]:text-destructive"
            : "[&>svg]:text-muted-foreground",
      )}
    >
      <Icon name={d.icon} size={16} />
      <span>
        <b>{decisionText(a)}</b> · <RelTime iso={a.decided_at} />
        {a.reason && <> · {a.reason}</>}
      </span>
    </div>
  );
}

export function ApprovalCard({ a, compact, full }: { a: Approval; compact?: boolean; full?: boolean }) {
  const pending = a.status === "pending";
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [decide, busy] = useAction(async (decision: "approve" | "reject", extra: Record<string, unknown> = {}) => {
    const r = await call<{ message?: string }>("approval.decide", { id: a.id, decision, ...extra });
    return { message: r.message ?? (decision === "approve" ? "Approved" : "Rejected") };
  });
  const [rejectLogin, rejectingLogin] = useAction(() => call("login.reject", { id: a.id }), "Rejected");
  const h = head(a);
  // only what was typed: an empty field stays unconfigured
  const entered = Object.fromEntries(
    Object.entries(values)
      .map(([n, v]) => [n, Object.fromEntries(Object.entries(v).filter(([, x]) => x))] as const)
      .filter(([, v]) => Object.keys(v).length),
  );
  return (
    <article
      className={cn(
        "flex flex-col gap-3.5 rounded-xl bg-card px-5 py-4.5 ring-1 ring-foreground/10",
        pending && "ring-warning/40",
        compact && "gap-3 px-4 py-3.5",
      )}
      aria-labelledby={`ap${a.id}`}
    >
      <header className="flex items-start gap-3">
        <span className={cn(TILE, "size-8.5", TONE[pending ? "warning" : "neutral"])}>
          <Icon name={h.icon} size={18} />
        </span>
        <div className="min-w-0 [&_a]:underline [&_b]:font-semibold [&_h3]:text-[15.5px] [&_h3]:leading-snug [&_h3]:font-medium [&_h3]:wrap-anywhere">
          <h3 id={`ap${a.id}`}>{h.title}</h3>
          <p className="text-muted-foreground text-[13px]">
            {a.task_id && !compact && (
              <>
                for <Link to={taskLink(a)}>{a.task_title ?? a.task_id}</Link> ·{" "}
              </>
            )}
            <RelTime iso={a.requested_at} /> ·{" "}
            <Link to={`/approvals/${a.id}`} className="text-muted-foreground">
              #{a.id}
            </Link>
          </p>
        </div>
      </header>
      {pending && <Why a={a} />}
      <div className="min-w-0">
        <Body a={a} full={full} values={values} onValues={setValues} />
      </div>
      {!pending ? (
        <Decision a={a} />
      ) : a.kind === "login" ? (
        <div className="flex flex-wrap gap-2">
          <Link to={`/approvals/${a.id}/login`} className={buttonVariants()}>
            <Icon name="lock" /> Open the login view
          </Link>
          <Button variant="quiet-danger" loading={rejectingLogin} onClick={() => rejectLogin()}>
            Reject
          </Button>
        </div>
      ) : rejecting ? (
        <form
          className="flex flex-wrap gap-2 flex-col items-stretch rounded-lg border bg-muted/50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            decide("reject", reason.trim() ? { reason: reason.trim() } : {});
          }}
        >
          <TextField
            label="Tell the task why"
            optional
            value={reason}
            onChange={setReason}
            placeholder="e.g. Post it in #dev instead"
            autoFocus
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setRejecting(false)}>Cancel</Button>
            <Button type="submit" variant="danger" loading={busy}>
              Reject
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon="check"
            loading={busy}
            onClick={() => decide("approve", a.category === "transforms" ? { credentials: entered } : {})}
          >
            {a.category === "merge"
              ? "Approve and merge"
              : a.category === "transforms"
                ? "Approve and install"
                : "Approve"}
          </Button>
          {a.grantable && (
            <Button
              disabled={busy}
              onClick={() => decide("approve", { grant: true })}
              title="Its later routine requests with this credential go through. Consequential ones still ask."
            >
              Approve, and allow {credName(a.category)} for this task
            </Button>
          )}
          <Button variant="quiet-danger" disabled={busy} onClick={() => setRejecting(true)}>
            Reject…
          </Button>
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The page

function HistoryRow({ a }: { a: Approval }) {
  const judge = a.decided_by === "judge";
  const d = a.status === "pending" ? undefined : DECIDED[a.status];
  return (
    <li>
      <Link
        to={`/approvals/${a.id}`}
        className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-inherit no-underline hover:bg-muted/60 [&>time]:text-xs [&>time]:text-muted-foreground"
      >
        <span className={cn(TILE, "size-7.5", TONE[stuck(a) ? "danger" : (d?.tone ?? "neutral")])}>
          <Icon name={judge ? "scale" : stuck(a) ? "alert" : (d?.icon ?? "check")} size={15} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{approvalTitle(a)}</span>
          <span className="text-muted-foreground text-[13px] truncate">
            {stuck(a) ? `Approved, but not merged: ${a.reason}` : decisionText(a)}
            {!stuck(a) && a.reason && ` · ${a.reason}`}
            {a.task_title && ` · ${a.task_title}`}
          </span>
        </span>
        <RelTime iso={a.decided_at ?? a.requested_at} />
      </Link>
    </li>
  );
}

export function Approvals() {
  const list = useCall<Approval[]>("approval.list", {}, ["approvals"]);
  const [tab, setTab] = useState<"waiting" | "history">("waiting");
  const [judge, setJudge] = useState(true);
  const all = list.data ?? [];
  const waiting = all.filter((a) => a.status === "pending");
  const decided = all.filter((a) => a.status !== "pending" && (judge || a.decided_by !== "judge"));
  return (
    <Page
      title="Approvals"
      description="Requests that use a credential, merges, logins and new transforms wait here until you decide."
    >
      <Tabs
        label="Approvals"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "waiting", label: "Waiting", count: waiting.length },
          { value: "history", label: "History" },
        ]}
      />
      {!list.data ? (
        <div className="grid flex-1 place-items-center p-12 text-muted-foreground">
          <Spinner />
        </div>
      ) : tab === "waiting" ? (
        waiting.length ? (
          <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
            {waiting.map((a) => (
              <ApprovalCard key={a.id} a={a} />
            ))}
          </div>
        ) : (
          <Empty icon="shield" title="Nothing waits for you">
            When a task needs your OK it shows up here, in its chat, and as a DM where you chose in Settings › General.
          </Empty>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2.5">
            <Switch label="Show the judge's decisions" checked={judge} onChange={setJudge} />
            <Link to="/settings/approvals" className="font-medium text-brand-text hover:underline text-[13px]">
              Tune the judge
            </Link>
          </div>
          {decided.length ? (
            <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
              {decided.map((a) => (
                <HistoryRow key={a.id} a={a} />
              ))}
            </ul>
          ) : (
            <Empty icon="clock" title="No decisions yet" />
          )}
        </>
      )}
    </Page>
  );
}

export function ApprovalPage({ id }: { id: number }) {
  const a = useCall<Approval>("approval.get", { id }, ["approvals"]);
  return (
    <Page title={a.data ? approvalTitle(a.data) : `Approval #${id}`} back={{ to: "/approvals", label: "Approvals" }}>
      {a.error ? <Callout tone="danger">{a.error}</Callout> : a.data ? <ApprovalCard a={a.data} full /> : <Spinner />}
    </Page>
  );
}

type Send = (input: Record<string, unknown>) => void;

/** Keys the box forwards to the page instead of editing itself. */
const FORWARDED = ["Enter", "Backspace", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/**
 * The way to type on a phone (a canvas brings up no keyboard) and to paste. Nothing stays here: each character goes to
 * the page and leaves the box, so a password is never on show. An IME's text goes once it is committed.
 */
function TypeBox({ send }: { send: Send }) {
  const id = useId();
  const [text, setText] = useState("");
  const flush = (v: string) => {
    if (v) send({ type: "text", text: v });
    setText("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Type into the page</Label>
      <p className="text-[13px] leading-snug text-muted-foreground" id={`${id}-hint`}>
        Click a field in the page first. Each character goes there as you type and leaves this box. Paste works too, and
        so do Enter, Tab and Backspace.
      </p>
      <Input
        id={id}
        value={text}
        placeholder="Type or paste here"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          if ((e.nativeEvent as InputEvent).isComposing) setText(e.target.value);
          else flush(e.target.value);
        }}
        onCompositionEnd={(e) => flush(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || !FORWARDED.includes(e.key)) return;
          e.preventDefault();
          send({ type: "key", event: "keyDown", key: e.key, code: e.code, keyCode: e.keyCode });
          send({ type: "key", event: "keyUp", key: e.key, code: e.code, keyCode: e.keyCode });
        }}
      />
    </div>
  );
}

/** ponytail: the mock's drawing of the remote page; the real one is a canvas of JPEG frames, clicks sent as x, y. */
function FakeSite({ frame, send }: { frame: LoginFrame | undefined; send: Send }) {
  const click = (field: string) => send({ type: "mouse", event: "mousePressed", field });
  if (frame?.signedIn)
    return (
      <div className="flex flex-col items-center gap-1 text-neutral-800">
        <p className="text-xl font-semibold">You're signed in</p>
        <p className="text-sm text-neutral-500">{frame.email}</p>
      </div>
    );
  const field = (name: LoginField, label: string) => (
    <button
      type="button"
      className={cn(
        "cursor-text rounded-lg border border-neutral-300 px-3 py-2 text-left text-sm text-neutral-500",
        frame?.focus === name && "border-neutral-800 ring-1 ring-neutral-800",
        frame?.[name] && "text-neutral-800",
      )}
      onClick={() => click(name)}
    >
      {frame?.[name] || label}
      {frame?.focus === name && <span className="ml-px inline-block h-3.5 w-px bg-neutral-800 align-text-bottom" />}
    </button>
  );
  return (
    <div className="flex w-[min(300px,80%)] flex-col gap-3 text-neutral-800">
      <span className="size-9 rounded-lg bg-neutral-800" />
      <p className="text-xl font-semibold">Sign in</p>
      {field("email", "Email")}
      {field("password", "Password")}
      <button
        type="button"
        className="cursor-pointer rounded-lg bg-neutral-800 p-2 text-center text-sm font-semibold text-white"
        onClick={() => click("submit")}
      >
        Continue
      </button>
    </div>
  );
}

/**
 * The live login view: the site in a headless browser, drawn here; the owner clicks and types, the task gets only
 * placeholders for the cookies it sets. ponytail: the page is a static stand-in until the frames stream in.
 */
export function LoginView({ id }: { id: number }) {
  const a = useCall<Approval>("approval.get", { id }, ["approvals"]);
  const frame = useCall<LoginFrame>(import.meta.env.VITE_MOCK === "1" ? "login.frame" : null, { id }, [`login:${id}`]);
  const [done, finishing] = useAction(() => call("login.done", { id }));
  const [reject, rejecting] = useAction(() => call("login.reject", { id }), "Rejected");
  // one at a time, in order: a late character must not land after a newer one
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const send: Send = (input) => {
    queue.current = queue.current
      .then(() => call("login.input", { id, ...input }))
      .catch((e) => toast(errorText(e), "error"));
  };
  const s = a.data?.summary ?? {};
  const host = hostOf(str(s.origin));
  const back = { to: "/approvals", label: "Approvals" };
  if (a.data && a.data.status !== "pending")
    return (
      <Page title={`Sign in to ${host}`} back={back}>
        <ApprovalCard a={a.data} />
      </Page>
    );
  return (
    <Page
      title={`Sign in to ${host}`}
      back={back}
      description={
        a.data?.task_id && (
          <>
            For <Link to={`/tasks/${a.data.task_id}`}>{a.data.task_title}</Link>: {str(s.why)}
          </>
        )
      }
      wide
    >
      <div className="overflow-hidden rounded-xl border bg-card shadow-md">
        <div className="flex items-center gap-2.5 border-b bg-muted px-3 py-2 text-[13px] text-foreground/80 [&_code]:flex-1">
          <Icon name="lock" size={15} />
          <code className="truncate">{str(s.url)}</code>
          <Pill tone="ok" dot>
            Live
          </Pill>
        </div>
        <div
          className="grid aspect-video max-h-[60vh] place-items-center bg-white outline-none focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset"
          role="application"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the live page takes the owner's clicks and keys
          tabIndex={0}
          aria-label="The site, live: click and type here"
        >
          <FakeSite frame={frame.data} send={send} />
        </div>
        <div className="border-t px-3.5 py-3">
          <TypeBox send={send} />
        </div>
      </div>
      <Callout tone="info">
        What you type goes to the site only. The task gets placeholders for the cookies the site sets, never your
        password.
      </Callout>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon="check" loading={finishing} onClick={() => done()}>
          I'm signed in
        </Button>
        <Button variant="quiet-danger" loading={rejecting} onClick={() => reject()}>
          Reject
        </Button>
      </div>
    </Page>
  );
}
