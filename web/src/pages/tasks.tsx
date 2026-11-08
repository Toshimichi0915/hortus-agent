/** Tasks: the list, one task's card, and the task widgets the chat shares (status, budget, session log). */

import { useEffect, useState } from "react";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { errorLine } from "../../../src/console/text.ts";
import { GOES_ON } from "../../../src/types.ts";
import { call, type Msg, type Row, streamRows, type Task, type TaskDetail, useCall, usePaged } from "../api.ts";
import { Markdown } from "../markdown.tsx";
import { Thread } from "../thread.tsx";
import {
  Button,
  buttonVariants,
  Callout,
  Card,
  Choice,
  CopyButton,
  confirmAction,
  Dialog,
  Empty,
  fmtTokens,
  fmtUsd,
  Icon,
  type IconName,
  Link,
  Meter,
  NumberField,
  Page,
  Pager,
  Pill,
  RelTime,
  ServiceTile,
  Spinner,
  Tabs,
  TextArea,
  useAction,
  useLocation,
} from "../ui.tsx";
import { ApprovalCard } from "./approvals.tsx";
import { ScheduleWhen } from "./schedules.tsx";

export const KIND: Record<string, { label: string; icon: IconName }> = {
  chat: { label: "Chat", icon: "chat" },
  unattended: { label: "From a message", icon: "inbox" },
  run: { label: "Scheduled run", icon: "clock" },
  planner: { label: "Planner batch", icon: "compass" },
};

export const isOpen = (t: Pick<Task, "status">): boolean =>
  t.status === "queued" || t.status === "running" || t.status === "waiting";

/** task.list's two lists (src/console/rows.ts › OPEN_SQL, CLOSED_SQL) */
const PARTS = { open: isOpen, closed: (t: Task) => !isOpen(t) };

/** Tokens so far: usage is written when a session ends, the proxy's count (plus its runs') is live. */
const used = (t: Task): number => Math.max(t.usage?.tokens ?? 0, (t.metered ?? 0) + (t.usage?.runs ?? 0));

/** The same in dollars. */
export const spent = (t: Task): number => Math.max(t.usage?.usd ?? 0, (t.metered_usd ?? 0) + (t.usage?.runs_usd ?? 0));

/** 0 for no limit, which a Meter shows as an empty bar: a chat (its owner is at the keyboard), a model with no price. */
export const spendLimit = (t: Task): number => (t.kind === "chat" || !t.priced ? 0 : (t.budget.usd ?? 0));

/** Dollars where its model has a price; without one, tokens, as nothing says what they cost. */
export const spendLine = (t: Task): string => {
  if (spendLimit(t)) return `${fmtUsd(spent(t))} of ${fmtUsd(spendLimit(t))}`;
  return t.priced ? `${fmtUsd(spent(t))}, no limit` : `${fmtTokens(used(t))} tokens, no spending limit`;
};

export const taskHref = (t: Pick<Task, "id" | "kind">): string =>
  t.kind === "chat" ? `/chat/${t.id}` : `/tasks/${t.id}`;

export function TaskStatus({ task: t }: { task: Task }) {
  if (t.status === "running")
    return (
      <Pill tone="info" dot pulse>
        Working
      </Pill>
    );
  if (t.status === "queued")
    return (
      <Pill dot title="Waiting for a free slot, or for hortus to resume">
        Queued
      </Pill>
    );
  if (t.status === "done") return <Pill tone="ok">Done</Pill>;
  if (t.status === "failed") return <Pill tone="danger">Failed</Pill>;
  if (t.pending)
    return (
      <Pill tone="warning" dot title="An approval waits for you">
        Needs you
      </Pill>
    );
  if (t.error?.startsWith("budget_exceeded")) return <Pill tone="warning">Over budget</Pill>;
  if (t.error) return <Pill tone="danger">Stopped</Pill>;
  return <Pill title="Waiting for a message, a note or a schedule">Waiting</Pill>;
}

/** What a stopped task needs from the owner to go on. */
export function TaskProblem({ task: t, onBudget }: { task: Task; onBudget: () => void }) {
  if (!t.error || !isOpen(t)) return null;
  if (GOES_ON.test(t.error))
    return (
      <Callout
        tone="warning"
        title="Stopped at its budget"
        action={
          <Button variant="primary" size="sm" onClick={onBudget}>
            Raise budget
          </Button>
        }
      >
        It used {spendLimit(t) ? spendLine(t) : `${+t.hours.toFixed(1)} of ${t.budget.hours} h`}. Raise the budget and
        it goes on where it stopped.
      </Callout>
    );
  return (
    <Callout tone="danger" title={errorLine(t.error)}>
      {t.error.startsWith("budget_exceeded") && "Raise its budget, then "}
      {t.kind === "chat" ? "a message from you starts it again." : "a note from you starts it again."}
      {t.error.includes("\n") && (
        <details className="[&>summary]:cursor-pointer [&>summary]:text-[13px] [&>summary]:font-medium [&>summary]:text-foreground/80 [&[open]>summary]:mb-2 [&>pre]:max-h-72 [&>pre]:overflow-auto [&>pre]:rounded-md [&>pre]:border [&>pre]:bg-muted/50 [&>pre]:p-2.5 [&>pre]:text-xs [&>pre]:wrap-anywhere [&>pre]:whitespace-pre-wrap">
          <summary>Full error</summary>
          <pre>{t.error}</pre>
        </details>
      )}
    </Callout>
  );
}

export function BudgetDialog({ task, open, onClose }: { task: Task; open: boolean; onClose: () => void }) {
  const [usd, setUsd] = useState(task.budget.usd ?? 0);
  const [hours, setHours] = useState(task.budget.hours);
  useEffect(() => {
    if (open) {
      setUsd(task.budget.usd ?? 0);
      setHours(task.budget.hours);
    }
  }, [open, task.budget.usd, task.budget.hours]);
  const [save, busy] = useAction(() => call("task.budget", { id: task.id, usd, hours }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Budget for this task"
      description="The task stops itself at its budget. Raise it, and a task stopped there goes on."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={async () => (await save()) && onClose()}>
            Save budget
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
        <Meter value={spent(task)} max={spendLimit(task)} label="Spent so far" detail={spendLine(task)} />
        {spendLimit(task) > 0 && (
          <NumberField
            label="Spending"
            hint="Every model call the task makes counts at its model's rates, its scheduled runs' too."
            value={usd}
            onChange={setUsd}
            min={0}
            step={5}
            unit="USD"
            presets={[5, 20, 50, 100].map((v) => ({ label: fmtUsd(v), value: v }))}
          />
        )}
        <NumberField
          label="Hours"
          hint="Time the task's sessions run, summed over its starts."
          value={hours}
          onChange={setHours}
          min={0}
          step={0.5}
          unit="hours"
          presets={[1, 4, 8, 24].map((v) => ({ label: `${v} h`, value: v }))}
        />
      </div>
    </Dialog>
  );
}

function LogBody({ id }: { id: string }) {
  const log = useCall<string>("task.log", { id });
  if (log.error) return <Callout tone="danger">{log.error}</Callout>;
  if (log.data === undefined) return <Spinner />;
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([log.data ?? ""], { type: "text/markdown" }));
    a.download = `${id}-session.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <>
      <div className="flex flex-wrap items-center justify-end">
        <CopyButton text={log.data} label="Copy" showLabel />
        <Button size="sm" variant="ghost" icon="arrowDown" onClick={download}>
          Download
        </Button>
      </div>
      <Markdown text={log.data} className="text-sm!" />
    </>
  );
}

export const SessionLogDialog = ({ id, open, onClose }: { id: string; open: boolean; onClose: () => void }) => (
  <Dialog open={open} onClose={onClose} title="Session log" description="The whole conversation, every session." wide>
    <LogBody id={id} />
  </Dialog>
);

// ---------------------------------------------------------------------------------------------------------------------
// The list

export function Tasks() {
  const { query } = useLocation();
  const [page, setPage] = useState(0);
  const list = usePaged<Task, "open" | "closed">("task.list", page, ["tasks", "approvals"], PARTS, (t) => t.id);
  const [show, setShow] = useState<"open" | "closed" | "all">("open");
  const [kind, setKind] = useState(query.get("kind") ?? "all");
  const [q, setQ] = useState("");
  const { open, closed } = list.lists;
  // ponytail: kind and title filter the page shown, not the whole list; a server-side filter once lists grow past it
  const rows = [...(show === "closed" ? [] : open.rows), ...(show === "open" ? [] : closed.rows)].filter(
    (t) => (kind === "all" || t.kind === kind) && t.title.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const more = (show !== "closed" && open.more) || (show !== "open" && closed.more);
  return (
    <Page
      title="Tasks"
      description="Everything hortus works on: your chats, tasks the Planner opened from incoming messages, and scheduled runs."
      actions={
        <Link to="/" className={buttonVariants()}>
          <Icon name="plus" /> New chat
        </Link>
      }
      wide
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <Choice
          value={show}
          onChange={(v) => {
            setShow(v);
            setPage(0);
          }}
          options={[
            { value: "open", label: open.exact ? `Open · ${open.rows.length}` : "Open" },
            { value: "closed", label: "Closed" },
            { value: "all", label: "All" },
          ]}
        />
        <NativeSelect aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <NativeSelectOption value="all">All kinds</NativeSelectOption>
          <NativeSelectOption value="chat">Chats</NativeSelectOption>
          <NativeSelectOption value="unattended">From messages</NativeSelectOption>
          <NativeSelectOption value="run">Scheduled runs</NativeSelectOption>
        </NativeSelect>
        <label className="ml-auto flex h-8 max-w-80 min-w-44 flex-1 items-center gap-2 rounded-lg border border-input px-3 text-muted-foreground focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 max-sm:ml-0 max-sm:max-w-none [&_input]:min-w-0 [&_input]:flex-1 [&_input]:bg-transparent [&_input]:text-sm [&_input]:text-foreground [&_input]:outline-none">
          <Icon name="search" size={16} />
          <input
            placeholder="Filter by title"
            aria-label="Filter by title"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
      </div>
      {!list.ready ? (
        <div className="grid flex-1 place-items-center p-12 text-muted-foreground">
          <Spinner />
        </div>
      ) : rows.length ? (
        <>
          <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
            {rows.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </ul>
          <Pager page={page} more={more} onPage={setPage} />
        </>
      ) : page ? (
        <Pager page={page} more={more} onPage={setPage} />
      ) : (
        <Empty
          icon="tasks"
          title={q ? "No task matches" : show === "open" ? "Nothing is open" : "No tasks here"}
          action={
            !q && (
              <Link to="/" className={buttonVariants({ variant: "outline" })}>
                Start a chat
              </Link>
            )
          }
        >
          {!q &&
            "Start a chat, or connect a messenger in Settings › Sources: the Planner opens tasks from what arrives."}
        </Empty>
      )}
    </Page>
  );
}

function TaskRow({ task: t }: { task: Task }) {
  const k = KIND[t.kind] ?? { label: t.kind, icon: "tasks" };
  const pct = spendLimit(t) ? Math.min(100, (spent(t) / spendLimit(t)) * 100) : 0;
  return (
    <li>
      <Link
        to={taskHref(t)}
        className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 sm:grid-cols-[36px_minmax(0,1fr)_140px_110px] sm:gap-3.5 sm:px-4.5 sm:py-3.5 text-inherit no-underline hover:bg-muted/60"
      >
        <span
          className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground sm:size-9"
          title={k.label}
        >
          <Icon name={k.icon} size={18} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium">{t.title}</span>
          <span className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
            {k.label}
            {t.project && (
              <>
                {" · "}
                <Icon name="folder" size={13} /> {t.project}
              </>
            )}
            {" · "}
            {isOpen(t) ? "updated " : "closed "}
            <RelTime iso={isOpen(t) ? t.updated : t.closed} />
          </span>
          {t.error && isOpen(t) && !t.error.startsWith("budget_exceeded") && (
            <span className="truncate text-xs text-destructive">{errorLine(t.error)}</span>
          )}
        </span>
        <span className="flex flex-col gap-1.5 text-xs max-sm:hidden" title={spendLine(t)}>
          <span className="h-1 overflow-hidden rounded-full bg-muted [&>span]:block [&>span]:h-full [&>span]:rounded-full [&>span]:bg-brand">
            <span
              style={{ width: `${pct}%` }}
              className={pct >= 100 ? "bg-destructive!" : pct >= 80 ? "bg-warning!" : undefined}
            />
          </span>
          <span className="text-muted-foreground">
            {t.priced ? fmtUsd(spent(t)) : fmtTokens(used(t))}
            {spendLimit(t) > 0 && ` / ${fmtUsd(spendLimit(t))}`}
          </span>
        </span>
        <span className="justify-self-end">
          <TaskStatus task={t} />
        </span>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// One task

const FROM: Record<string, string> = {
  owner: "You",
  console: "Your note",
  planner: "Planner",
  approval: "Approval",
  merge: "Merge",
  rebase: "Rebase",
  cookies: "Login",
};

const ALL = { all: () => true };

/** A task's inbox or outbox, newest first, a page at a time (task.get has only the newest 50, for the tab counts). */
function MsgPages({ id, box, empty }: { id: string; box: "inbox" | "outbox"; empty: string }) {
  const [page, setPage] = useState(0);
  const list = usePaged<Msg, "all">("task.messages", page, ["tasks"], ALL, (m) => m.seq, { id, box });
  if (!list.ready)
    return (
      <div className="grid place-items-center p-6 text-muted-foreground">
        <Spinner />
      </div>
    );
  const { rows, more } = list.lists.all;
  return (
    <>
      <MsgList msgs={rows} empty={page ? "Nothing older." : empty} />
      <div className="px-4.5 pb-3 empty:hidden">
        <Pager page={page} more={more} onPage={setPage} />
      </div>
    </>
  );
}

function MsgList({ msgs, empty }: { msgs: Msg[]; empty: string }) {
  if (!msgs.length) return <p className="text-muted-foreground px-5 py-4">{empty}</p>;
  return (
    <ul className="divide-y py-1">
      {msgs.map((m) => {
        const from = m.body.from ?? m.body.type ?? "";
        const [dof, channel] = from.split(":");
        const label =
          FROM[from] ??
          (from.startsWith("schedule:")
            ? "Schedule"
            : m.body.type
              ? { reply: "Reply", result: "Result", budget_exceeded: "Budget" }[m.body.type]
              : channel
                ? `${dof} · ${channel}`
                : from);
        return (
          <li key={m.seq} className="px-4.5 py-3">
            <div className="flex flex-wrap items-center gap-2 text-[13px] [&_time]:ml-auto [&_time]:text-xs [&_time]:text-muted-foreground">
              <b>{label}</b>
              {m.body.author && <span className="text-muted-foreground">{m.body.author}</span>}
              {m.body.trusted === false && (
                <Pill tone="warning" title="Not from you or a trusted member: the task treats it as data">
                  untrusted
                </Pill>
              )}
              <RelTime iso={m.created} />
            </div>
            <p className="mt-1.5 text-sm wrap-anywhere whitespace-pre-wrap text-foreground/80">{m.body.text}</p>
          </li>
        );
      })}
    </ul>
  );
}

function NoteForm({ id }: { id: string }) {
  const [text, setText] = useState("");
  const [send, busy] = useAction(() => call("task.message", { id, text }), "Note sent");
  return (
    <Card
      title="Send a note"
      description="A note from you is trusted. The task reads it at its next step, or wakes for it."
    >
      <form
        className="flex flex-col gap-4 *:data-[slot=button]:self-start"
        onSubmit={async (e) => {
          e.preventDefault();
          if (text.trim() && (await send())) setText("");
        }}
      >
        <TextArea
          label="Note"
          value={text}
          onChange={setText}
          rows={3}
          placeholder="e.g. Use the staging bucket instead"
        />
        <div className="flex flex-wrap items-center justify-end">
          <Button type="submit" variant="primary" icon="send" loading={busy} disabled={!text.trim()}>
            Send note
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function TaskPage({ id }: { id: string }) {
  const d = useCall<TaskDetail>("task.get", { id }, ["tasks", "approvals"]);
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    setRows([]);
    return streamRows(id, (r) => setRows((p) => [...p, ...r]));
  }, [id]);
  const [tab, setTab] = useState<"activity" | "sent" | "inbox" | "console">("activity");
  const [budget, setBudget] = useState(false);
  const [log, setLog] = useState(false);
  const [stop, stopping] = useAction(() => call("task.stop", { id }));
  const [close] = useAction((outcome: "done" | "failed") => call("task.close", { id, outcome }), "Task closed");
  const back = { to: "/tasks", label: "Tasks" };
  if (d.error && !d.data)
    return (
      <Page title="Task not found" back={back}>
        <Callout tone="danger">{d.error}</Callout>
      </Page>
    );
  if (!d.data)
    return (
      <Page title="" back={back}>
        <div className="grid flex-1 place-items-center p-12 text-muted-foreground">
          <Spinner />
        </div>
      </Page>
    );
  const { task: t, approvals, inbox, outbox, schedules, origin, tainted } = d.data;
  const k = KIND[t.kind] ?? { label: t.kind, icon: "tasks" };
  const askClose = async (outcome: "done" | "failed") => {
    if (
      await confirmAction({
        title: outcome === "done" ? "Close this task?" : "Close this task as failed?",
        body: "It stops now and never runs again. Its schedules end with it.",
        confirm: outcome === "done" ? "Close task" : "Close as failed",
        danger: outcome === "failed",
      })
    )
      close(outcome);
  };
  return (
    <Page
      title={t.title}
      back={back}
      wide
      actions={
        <>
          {t.kind === "chat" && (
            <Link to={`/chat/${t.id}`} className={buttonVariants({ variant: "outline" })}>
              <Icon name="chat" /> Open chat
            </Link>
          )}
          {(t.status === "running" || t.status === "queued") && (
            <Button icon="stop" loading={stopping} onClick={() => stop()}>
              Stop
            </Button>
          )}
          {isOpen(t) && (
            <Button icon="check" onClick={() => askClose("done")}>
              Close task
            </Button>
          )}
        </>
      }
    >
      <div className="-mt-2 flex flex-wrap items-center gap-x-4.5 gap-y-2 text-[13px]">
        <TaskStatus task={t} />
        <span className="text-muted-foreground flex flex-wrap items-center gap-2">
          <Icon name={k.icon} size={15} /> {k.label}
        </span>
        {t.project && (
          <span className="text-muted-foreground flex flex-wrap items-center gap-2">
            <Icon name="folder" size={15} /> {t.project}
          </span>
        )}
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <TaskProblem task={t} onBudget={() => setBudget(true)} />
          {approvals.length > 0 && (
            <section className="flex flex-col gap-4 *:data-[slot=button]:self-start">
              <h2 className="text-[13px] font-semibold tracking-wide text-muted-foreground uppercase">
                Waiting for you
              </h2>
              {approvals.map((a) => (
                <ApprovalCard key={a.id} a={a} compact />
              ))}
            </section>
          )}
          <Card title="Summary">
            {t.summary ? (
              <Markdown text={t.summary} />
            ) : (
              <p className="text-muted-foreground">No summary yet. The task writes one as it goes.</p>
            )}
          </Card>
          <Card flush>
            <Tabs
              label="Task activity"
              value={tab}
              onChange={setTab}
              tabs={[
                { value: "activity", label: "Activity" },
                { value: "sent", label: "Sent", count: outbox.length },
                { value: "inbox", label: "Inbox", count: inbox.length },
                ...(d.data.console_log ? [{ value: "console" as const, label: "Console" }] : []),
              ]}
            />
            {tab === "activity" &&
              (rows.length ? (
                <div className="mx-auto flex max-w-[808px] flex-col gap-5.5 px-4 pt-3 pb-7 sm:gap-7 sm:px-6 sm:pt-4 sm:pb-10 max-w-none! gap-5.5! p-4! sm:p-5!">
                  <Thread id={id} rows={rows} live={t.status === "running"} />
                </div>
              ) : (
                <p className="text-muted-foreground px-5 py-4">Nothing yet.</p>
              ))}
            {tab === "sent" && <MsgPages id={id} box="outbox" empty="It hasn't sent anything yet." />}
            {tab === "inbox" && <MsgPages id={id} box="inbox" empty="Its inbox is empty." />}
            {tab === "console" && (
              <pre className="max-h-105 overflow-auto bg-muted/50 px-4.5 py-3.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                {d.data.console_log}
              </pre>
            )}
            <div className="flex gap-3 border-t px-4.5 py-2.5">
              <button
                type="button"
                className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-brand-text hover:underline"
                onClick={() => setLog(true)}
              >
                <Icon name="file" size={15} /> Session log
              </button>
            </div>
          </Card>
          {isOpen(t) && <NoteForm id={id} />}
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <Card title="Details">
            <dl className="mb-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px] last:mb-0 [&_dd]:min-w-0 [&_dd]:wrap-anywhere [&_dt]:text-muted-foreground">
              <dt>Runs on</dt>
              <dd>
                {t.runtime === "vm" ? "Its own VM" : "This machine, sandboxed"}
                {t.runtime === "vm" && t.status === "running" && t.started && (
                  <span className="text-muted-foreground">
                    {" "}
                    · up <RelTime iso={t.started} />
                  </span>
                )}
              </dd>
              <dt>Created</dt>
              <dd>
                <RelTime iso={t.created} />
              </dd>
              <dt>Updated</dt>
              <dd>
                <RelTime iso={t.updated} />
              </dd>
              {t.closed && (
                <>
                  <dt>Closed</dt>
                  <dd>
                    <RelTime iso={t.closed} />
                  </dd>
                </>
              )}
              <dt>ID</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <code className="truncate">{t.id}</code>
                <CopyButton text={t.id} label="Copy ID" />
              </dd>
            </dl>
            {isOpen(t) && (
              <button
                type="button"
                className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-brand-text hover:underline text-destructive!"
                onClick={() => askClose("failed")}
              >
                Close as failed
              </button>
            )}
          </Card>
          {origin && (
            <Card title="Came from">
              <div className="flex gap-3">
                <ServiceTile type={origin.dof} size={28} />
                <div>
                  <p>
                    <b>{origin.dof}</b> · {origin.channel}
                    {origin.author && <span className="text-muted-foreground"> · {origin.author}</span>}
                  </p>
                  <blockquote className="mt-1.5 border-l-[3px] pl-2.5 text-[13px] text-foreground/80">
                    {origin.summary}
                  </blockquote>
                </div>
              </div>
            </Card>
          )}
          {tainted.length > 0 && (
            <Callout tone="warning" title="It read untrusted text">
              {tainted.join("; ")}. You decide its requests, never the judge.
            </Callout>
          )}
          <Card
            title="Budget"
            actions={
              isOpen(t) && (
                <Button size="sm" onClick={() => setBudget(true)}>
                  Change
                </Button>
              )
            }
          >
            <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
              {!t.priced && isOpen(t) && (
                <Callout tone="warning" title="No spending limit">
                  Its model has no price, so only the hours limit stops this task. Add a price in Settings › Workers.
                </Callout>
              )}
              <Meter value={spent(t)} max={spendLimit(t)} label="Spending" detail={spendLine(t)} />
              <Meter
                value={t.hours}
                max={t.budget.hours}
                label="Hours"
                detail={`${+t.hours.toFixed(1)} of ${t.budget.hours} h`}
              />
            </div>
          </Card>
          {t.scope && (t.scope.credentials.length > 0 || t.scope.repos.length > 0 || t.scope.dofs) && (
            <Card title="What it can use">
              <dl className="mb-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px] last:mb-0 [&_dd]:min-w-0 [&_dd]:wrap-anywhere [&_dt]:text-muted-foreground">
                {t.scope.credentials.length > 0 && (
                  <>
                    <dt>Credentials</dt>
                    <dd className="flex flex-wrap gap-1.5 [&_code]:rounded-md [&_code]:border [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:text-xs">
                      {t.scope.credentials.map((c) => (
                        <code key={c}>{c}</code>
                      ))}
                    </dd>
                  </>
                )}
                {t.scope.repos.length > 0 && (
                  <>
                    <dt>Repositories</dt>
                    <dd className="flex flex-wrap gap-1.5 [&_code]:rounded-md [&_code]:border [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:text-xs">
                      {t.scope.repos.map((r) => (
                        <code key={r}>{r.split(":").at(-1)}</code>
                      ))}
                    </dd>
                  </>
                )}
                <dt>Reads</dt>
                <dd className="flex flex-wrap gap-1.5 [&_code]:rounded-md [&_code]:border [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:text-xs">
                  {t.scope.dofs ? (
                    t.scope.dofs.length ? (
                      t.scope.dofs.map((x) => <code key={x}>{x}</code>)
                    ) : (
                      <span className="text-muted-foreground">no mirrors</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">every mirror</span>
                  )}
                </dd>
              </dl>
            </Card>
          )}
          {schedules.length > 0 && (
            <Card title="Schedules">
              <ul className="flex flex-col gap-2 *:data-[slot=button]:self-start">
                {schedules.map((s) => (
                  <li key={s.id}>
                    <p>{s.text}</p>
                    <p className="text-muted-foreground text-[13px]">
                      <ScheduleWhen s={s} />
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {t.brief && (
            <Card title="Brief">
              <Markdown text={t.brief} />
            </Card>
          )}
        </aside>
      </div>
      <BudgetDialog task={t} open={budget} onClose={() => setBudget(false)} />
      <SessionLogDialog id={id} open={log} onClose={() => setLog(false)} />
    </Page>
  );
}
