/** Chat: the home page (a new chat) and a conversation, in the manner of Claude's and ChatGPT's. */

import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Kbd } from "@/components/ui/kbd";
import { tokens as fmt } from "../../../src/console/text.ts";
import { contextOf } from "../../../src/console/turns.ts";
import {
  type Approval,
  type Config,
  type Credential,
  call,
  type Row,
  reconnecting,
  streamRows,
  type Task,
  type TaskDetail,
  useCall,
} from "../api.ts";
import { Pending, Thread } from "../thread.tsx";
import {
  Button,
  buttonVariants,
  Card,
  ComboboxField,
  confirmAction,
  Icon,
  IconButton,
  Link,
  Logo,
  Meter,
  navigate,
  RelTime,
  useAction,
  useStore,
  useTitle,
} from "../ui.tsx";
import { ApprovalCard, approvalTitle } from "./approvals.tsx";
import { TRANSFORMS } from "./credentials.tsx";
import { ScheduleWhen } from "./schedules.tsx";
import { asOptions, CLAUDE, credentialLabel } from "./settings.tsx";
import {
  BudgetDialog,
  isOpen,
  SessionLogDialog,
  spendLine,
  spent,
  TaskProblem,
  TaskStatus,
  taskHref,
} from "./tasks.tsx";

/** Asks, then deletes the chat (its rows and its `logs` DOF entry); off its page if that is where the owner is. */
export async function deleteChat(id: string): Promise<void> {
  const ok = await confirmAction({
    title: "Delete this chat?",
    body: "Its messages, its decided approvals and its session log in the logs DOF are deleted for good.",
    confirm: "Delete chat",
    danger: true,
  });
  if (!ok) return;
  await call("task.delete", { id });
  if (location.pathname === `/chat/${id}`) navigate("/");
}

/** Unsent text per chat ("" is the new chat), kept across navigation. */
const touch = () => matchMedia("(pointer: coarse)").matches;

const drafts = new Map<string, string>();

function Composer({
  draftKey,
  onSend,
  onStop,
  running,
  busy,
  blocked,
  placeholder,
  autoFocus,
  tools,
}: {
  draftKey: string;
  onSend: (text: string) => Promise<unknown>;
  onStop?: () => void;
  running?: boolean;
  busy?: boolean;
  /** a half-made pick in `tools`: what is typed waits for it */
  blocked?: boolean;
  placeholder: string;
  autoFocus?: boolean;
  tools?: ReactNode;
}) {
  const [value, setValue] = useState(drafts.get(draftKey) ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    drafts.set(draftKey, value);
  }, [draftKey, value]);
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 320)}px`;
  });
  const submit = async () => {
    const text = value.trim();
    if (!text || busy || blocked) return;
    setValue("");
    drafts.delete(draftKey);
    // a failed send gives the text back
    if ((await onSend(text)) === undefined) setValue(text);
  };
  const showStop = running && !value.trim() && onStop;
  return (
    <form
      className="mx-auto w-full max-w-[760px] rounded-3xl border border-input bg-card pt-3 pr-3 pb-2.5 pl-4.5 shadow-md transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 [&_textarea]:block [&_textarea]:max-h-80 [&_textarea]:w-full [&_textarea]:resize-none [&_textarea]:bg-transparent [&_textarea]:py-1 [&_textarea]:text-base [&_textarea]:outline-none [&_textarea]:placeholder:text-muted-foreground"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor={id} className="sr-only">
        Message
      </label>
      <textarea
        ref={ref}
        id={id}
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // an IME's Enter commits a word, and a touch keyboard's Enter is a new line: neither sends
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touch()) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-1.5 flex items-center gap-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{tools}</div>
        {running && value.trim() && (
          <span className="text-xs text-muted-foreground">It reads this after its current step</span>
        )}
        {showStop ? (
          <IconButton
            label="Stop"
            icon="stop"
            className="size-9 rounded-full bg-foreground text-background hover:bg-foreground/80 hover:text-background"
            onClick={onStop}
          />
        ) : (
          <Button
            type="submit"
            variant="primary"
            icon="arrowUp"
            className="size-9 rounded-full"
            aria-label="Send"
            title="Send (Enter)"
            loading={busy}
            disabled={!value.trim() || blocked}
          />
        )}
      </div>
    </form>
  );
}

interface ModelPick {
  provider: string;
  /** "": the provider changed and its model is not picked yet */
  model: string;
}

/** A chat's credential and model; a name can be typed, as a provider's list is never sure to be whole. */
function ModelPicker({
  provider,
  model,
  fallback,
  onChange,
  disabled,
}: {
  provider: string | undefined;
  model: string | undefined;
  /** the Workers' provider: offered whatever its transform, as the config already runs on it */
  fallback: string | undefined;
  onChange: (pick: ModelPick) => void;
  disabled?: boolean | undefined;
}) {
  const creds = useCall<Credential[]>("credential.list", {}, ["settings"]);
  const list = useCall<{ models: string[] }>(provider ? "provider.models" : null, { provider });
  const named = (x: Credential) => x.transform ?? x.name;
  // the server refuses the rest (task.open): a model call skips the gate, so no other credential may be one
  const offered = (creds.data ?? []).filter(
    (x) => x.type === "token" && (x.name === fallback || TRANSFORMS[named(x)]?.provider),
  );
  const claude = creds.data?.some((x) => x.name === provider && named(x) === "anthropic");
  return (
    <>
      <ComboboxField
        label={<span className="sr-only">Provider</span>}
        className="w-40 gap-0 sm:w-48"
        value={provider ?? ""}
        onChange={(p) => p !== provider && onChange({ provider: p, model: "" })}
        options={offered.map((x) => ({ value: x.name, label: credentialLabel(x) }))}
        placeholder="Provider"
        disabled={disabled}
      />
      <ComboboxField
        label={<span className="sr-only">Model</span>}
        className="w-full gap-0 sm:w-48"
        value={model ?? ""}
        onChange={(m) => provider && onChange({ provider, model: m })}
        options={asOptions([...((list.current && list.data?.models) || []), ...(claude ? CLAUDE : [])])}
        placeholder="Pick a model"
        typed
        disabled={disabled || !provider}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Home: a new chat, what needs the owner, and setup for a newcomer

function greeting(tz?: string): string {
  const h = Number(new Intl.DateTimeFormat("en", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format());
  return h < 5 ? "Working late?" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const PROVIDERS = new Set(["anthropic", "openai", "openrouter"]);

function setupSteps(c: Config, creds: Credential[]) {
  return [
    {
      done: creds.some((x) => x.transform && PROVIDERS.has(x.transform)),
      title: "Add a model provider",
      text: "An API key for Anthropic, OpenAI or OpenRouter.",
      to: "/settings/credentials?add=provider",
    },
    {
      done: !!(c.worker.provider && c.worker.model && c.planner.provider && c.planner.model),
      title: "Choose the models",
      text: "One for the Planner, which routes messages, and one for the Workers that do tasks.",
      to: "/settings/planner",
    },
    {
      done: Object.keys(c.dofs).length > 0,
      title: "Connect a messenger or forge",
      text: "Slack, Discord, Telegram, GitHub, GitLab or Bitbucket.",
      to: "/settings/sources",
    },
    {
      done: !!c.owner.notify,
      title: "Choose where hortus reaches you",
      text: "A DM for new approvals and failed tasks.",
      to: "/settings/general",
    },
    {
      done: Object.keys(c.projects).length > 0,
      title: "Add a project",
      text: "A repository or folder Workers may change. Optional.",
      to: "/settings/projects",
    },
  ];
}

function Setup({ config, creds }: { config: Config; creds: Credential[] }) {
  const steps = setupSteps(config, creds);
  const done = steps.filter((s) => s.done).length;
  if (steps.slice(0, 4).every((s) => s.done)) return null;
  return (
    <Card
      className="mt-4"
      title="Set up hortus"
      description={`${done} of ${steps.length} done. Each step is a form: no config file to edit.`}
    >
      <div data-x="" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done}>
        <span style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol className="flex flex-col divide-y">
        {steps.map((s) => (
          <li
            key={s.title}
            data-done={s.done || undefined}
            className="group flex items-center gap-3 py-2.5 [&>div]:min-w-0 [&>div]:flex-1"
          >
            <span
              className="grid size-5.5 flex-none place-items-center rounded-full border-[1.5px] border-input text-primary-foreground group-data-done:border-brand group-data-done:bg-brand"
              aria-hidden="true"
            >
              {s.done && <Icon name="check" size={14} />}
            </span>
            <div>
              <p className="font-medium group-data-done:text-muted-foreground">{s.title}</p>
              <p className="text-muted-foreground text-[13px]">{s.text}</p>
            </div>
            {!s.done && (
              <Link to={s.to} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Set up
              </Link>
            )}
            {s.done && <span className="sr-only">done</span>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function Home() {
  useTitle("New chat");
  const cfg = useCall<{ config: Config }>("settings.get", {}, ["settings"]);
  const creds = useCall<Credential[]>("credential.list", {}, ["settings"]);
  const tasks = useCall<Task[]>("task.list", {}, ["tasks"]);
  const pending = useCall<Approval[]>("approval.list", {}, ["approvals"]);
  const [cwd, setCwd] = useState("");
  // none: the chat follows the Workers' model in Settings
  const [pick, setPick] = useState<ModelPick | null>(null);
  const [open, opening] = useAction(async (text: string) => {
    const r = await call<{ id: string }>("task.open", { text, ...(cwd ? { cwd } : {}), ...pick });
    navigate(`/chat/${r.id}`);
    return r;
  });
  const config = cfg.data?.config;
  const projects = Object.entries(config?.projects ?? {});
  const waiting = (pending.data ?? []).filter((a) => a.status === "pending");
  const working = (tasks.data ?? []).filter((t) => t.status === "running" || t.status === "queued");
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 pt-[7vh] pb-12 sm:px-6 sm:pt-[11vh] sm:pb-18">
        <div className="mb-3.5 flex flex-col items-center gap-1.5 text-center [&_h1]:mt-2.5 [&_h1]:text-[25px] [&_h1]:font-semibold [&_h1]:tracking-tight sm:[&_h1]:text-3xl">
          <span className="grid size-14 place-items-center rounded-2xl bg-brand/10">
            <Logo size={34} />
          </span>
          <h1>{greeting(config?.owner.tz)}</h1>
          <p className="text-muted-foreground">What should hortus work on?</p>
        </div>
        <Composer
          draftKey=""
          autoFocus
          busy={opening}
          blocked={!!pick && !pick.model}
          onSend={open}
          placeholder="Ask hortus to do something…"
          tools={
            <>
              <div className="flex items-center gap-1.5 text-muted-foreground" title="The project the chat works in">
                <Icon name="folder" size={16} />
                <ComboboxField
                  label={<span className="sr-only">Project</span>}
                  className="w-40 gap-0 text-foreground sm:w-48"
                  value={cwd}
                  onChange={setCwd}
                  options={[
                    { value: "", label: "No project" },
                    ...projects.map(([name, p]) => ({ value: p.path, label: name })),
                  ]}
                  placeholder="No project"
                />
              </div>
              <ModelPicker
                provider={(pick ?? config?.worker)?.provider}
                model={(pick ?? config?.worker)?.model}
                fallback={config?.worker.provider}
                onChange={setPick}
              />
            </>
          }
        />
        <p className="-mt-1 text-center text-xs text-muted-foreground">
          <span className="pointer-coarse:hidden">
            <Kbd>Enter</Kbd> sends, <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> adds a line.{" "}
          </span>
          Anything that uses a credential asks you first.
        </p>
        {config && creds.data && <Setup config={config} creds={creds.data} />}
        {(waiting.length > 0 || working.length > 0) && (
          <div className="mt-4.5 grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
            {waiting.length > 0 && (
              <Card
                title={
                  <>
                    <Icon name="shield" size={17} /> Needs you
                  </>
                }
                actions={
                  <Link to="/approvals" className="font-medium text-brand-text hover:underline text-[13px]">
                    All {waiting.length}
                  </Link>
                }
              >
                <ul className="divide-y [&_a]:flex [&_a]:items-center [&_a]:text-foreground [&_a]:no-underline [&_a]:justify-between [&_a]:gap-3 [&_a]:py-2 [&_a]:text-sm [&_a:hover_.truncate]:text-brand-text [&_time]:flex-none [&_time]:text-xs [&_time]:text-muted-foreground">
                  {waiting.slice(0, 4).map((a) => (
                    <li key={a.id}>
                      <Link to={a.kind === "login" ? `/approvals/${a.id}/login` : `/approvals/${a.id}`}>
                        <span className="truncate">{approvalTitle(a)}</span>
                        <RelTime iso={a.requested_at} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {working.length > 0 && (
              <Card
                title={
                  <>
                    <Icon name="sparkle" size={17} /> Working now
                  </>
                }
                actions={
                  <Link to="/tasks" className="font-medium text-brand-text hover:underline text-[13px]">
                    Tasks
                  </Link>
                }
              >
                <ul className="divide-y [&_a]:flex [&_a]:items-center [&_a]:text-foreground [&_a]:no-underline [&_a]:justify-between [&_a]:gap-3 [&_a]:py-2 [&_a]:text-sm [&_a:hover_.truncate]:text-brand-text [&_time]:flex-none [&_time]:text-xs [&_time]:text-muted-foreground">
                  {working.slice(0, 4).map((t) => (
                    <li key={t.id}>
                      <Link to={taskHref(t)}>
                        <span className="truncate">{t.title}</span>
                        <TaskStatus task={t} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// A conversation

/** How full the session's context is, colored as `Meter` is. */
function ContextRing({ tokens, window }: { tokens: number; window: number }) {
  const pct = Math.min(100, (tokens / window) * 100);
  const text = `Context: ${fmt(tokens)} / ${fmt(window)} tokens (${Math.round(pct)}%)`;
  return (
    <svg viewBox="0 0 20 20" className="size-4.5 flex-none -rotate-90" role="img" aria-label={text}>
      <title>{text}</title>
      <circle cx="10" cy="10" r="8" fill="none" strokeWidth="3" className="stroke-muted" />
      <circle
        cx="10"
        cy="10"
        r="8"
        fill="none"
        strokeWidth="3"
        pathLength={100}
        strokeDasharray={`${pct} 100`}
        className={pct >= 100 ? "stroke-destructive" : pct >= 80 ? "stroke-warning" : "stroke-brand"}
      />
    </svg>
  );
}

export function Conversation({ id }: { id: string }) {
  const d = useCall<TaskDetail>("task.get", { id }, ["tasks", "approvals"]);
  const paused = useCall<{ paused: boolean }>("pause.get", {}, ["tasks"]);
  const cfg = useCall<{ config: Config }>("settings.get", {}, ["settings"]);
  const [pick, setPick] = useState<ModelPick | null>(null);
  const down = useStore(reconnecting);
  const [rows, setRows] = useState<Row[]>([]);
  const [panel, setPanel] = useState(false);
  const [budget, setBudget] = useState(false);
  const [log, setLog] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [earlier] = useState(() => ({ scroller, setRows }));
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  useEffect(() => {
    setRows([]);
    setPick(null);
    stick.current = true;
    return streamRows(id, (r) => setRows((p) => [...p, ...r]));
  }, [id]);
  // pinned to the newest line unless the owner scrolled up to read
  useLayoutEffect(() => {
    const s = scroller.current;
    if (s && stick.current) s.scrollTop = s.scrollHeight;
  });
  const [send] = useAction(
    async (text: string) => {
      stick.current = true;
      return call("task.send", { id, text });
    },
    () => undefined,
  );
  const [stop] = useAction(() => call("task.stop", { id }));
  const [switchModel] = useAction(async (p: ModelPick) => {
    try {
      await call("task.model", { id, ...p });
      await d.reload();
    } finally {
      setPick(null); // refused: back to what it still runs on
    }
  });
  const t = d.data?.task;
  useTitle(t?.title ?? "Chat");
  if (d.error && !t)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-9 sm:px-8">
          <p className="text-muted-foreground">{d.error}</p>
          <Link to="/">Start a new chat</Link>
        </div>
      </div>
    );
  const running = t?.status === "running" || t?.status === "queued";
  // a context row lands right after the owner's, when the Worker starts: not yet an answer
  const lastIsOwner = rows.findLast((r) => r.body.type !== "context")?.body.type === "owner";
  const approvals = d.data?.approvals ?? [];
  const context = contextOf(rows);
  return (
    <div className="flex min-h-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center justify-between gap-3 py-2 pr-2 pl-4 sm:pr-4 sm:pl-6 [&>div:last-child]:flex-none [&>div:last-child]:flex-nowrap">
          <div className="flex min-w-0 items-center gap-2.5 [&_h1]:text-[15px] [&_h1]:font-semibold">
            <h1 className="truncate" title={t?.title}>
              {t?.title ?? ""}
            </h1>
            {context && <ContextRing {...context} />}
            {t && (t.status !== "waiting" || t.pending || t.error) && <TaskStatus task={t} />}
            {down && (
              <span className="flex-none text-xs text-muted-foreground" role="status">
                Reconnecting…
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {t?.project && (
              <span
                className="inline-flex h-5 items-center gap-1 rounded-full border px-2 text-xs font-medium bg-muted text-foreground/80 max-sm:hidden"
                title={t.cwd ?? undefined}
              >
                <Icon name="folder" size={14} /> {t.project}
              </span>
            )}
            <IconButton
              label={panel ? "Hide details" : "Details"}
              icon="sidebar"
              aria-pressed={panel}
              onClick={() => setPanel(!panel)}
            />
          </div>
        </header>
        <div
          className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]"
          ref={scroller}
          onScroll={() => {
            const s = scroller.current;
            if (!s) return;
            stick.current = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
            setAway(!stick.current);
          }}
        >
          <div
            className="mx-auto flex max-w-[808px] flex-col gap-5.5 px-4 pt-3 pb-7 sm:gap-7 sm:px-6 sm:pt-4 sm:pb-10"
            aria-live="off"
          >
            <Thread key={id} id={id} rows={rows} live={running} earlier={earlier} />
            {running && lastIsOwner && (
              <Pending
                text={
                  t?.status === "queued"
                    ? paused.data?.paused
                      ? "Paused: it starts when you resume"
                      : "Waiting for a free Worker"
                    : "Thinking"
                }
              />
            )}
            {approvals.length > 0 && (
              <section className="flex flex-col gap-2.5" aria-label="Waiting for your approval">
                <p className="flex items-center gap-2 text-[13px] font-semibold text-warning">
                  <Icon name="shield" size={16} /> Waiting for your approval
                </p>
                {approvals.map((a) => (
                  <ApprovalCard key={a.id} a={a} compact />
                ))}
              </section>
            )}
            {t && <TaskProblem task={t} onBudget={() => setBudget(true)} />}
          </div>
        </div>
        {away && (
          <button
            type="button"
            className="absolute bottom-[118px] left-1/2 z-5 grid size-9 -translate-x-1/2 cursor-pointer place-items-center rounded-full border bg-card shadow-md"
            aria-label="Jump to the newest message"
            onClick={() => {
              stick.current = true;
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
            }}
          >
            <Icon name="arrowDown" size={18} />
          </button>
        )}
        <div className="px-2.5 pb-2.5 sm:px-6 sm:pb-4.5">
          {t && !isOpen(t) ? (
            <div className="mx-auto flex max-w-[760px] items-center justify-between gap-3 rounded-2xl border bg-card py-3 pr-3 pl-4.5 text-muted-foreground">
              <p>This chat is closed.</p>
              <Link to="/" className={buttonVariants()}>
                <Icon name="plus" /> New chat
              </Link>
            </div>
          ) : (
            <Composer
              key={id}
              draftKey={id}
              running={running}
              blocked={!!pick && !pick.model}
              onSend={send}
              onStop={() => stop()}
              placeholder="Reply to hortus…"
              autoFocus
              tools={
                <ModelPicker
                  provider={(pick ?? t)?.provider}
                  model={(pick ?? t)?.model}
                  fallback={cfg.data?.config.worker.provider}
                  disabled={running}
                  onChange={(p) => {
                    setPick(p);
                    if (p.model) switchModel(p);
                  }}
                />
              }
            />
          )}
          <span className="sr-only" role="status">
            {running ? "hortus is working" : t ? "hortus is waiting for you" : ""}
          </span>
        </div>
      </div>
      {panel && t && d.data && (
        <aside
          className="flex flex-none flex-col overflow-y-auto border-l bg-card max-md:fixed max-md:inset-0 max-md:z-60 md:w-85"
          aria-label="Chat details"
        >
          <header className="sticky top-0 flex items-center justify-between border-b bg-card py-2.5 pr-3 pl-4.5 [&_h2]:text-[15px] [&_h2]:font-semibold">
            <h2>Details</h2>
            <IconButton label="Close details" icon="x" onClick={() => setPanel(false)} />
          </header>
          <div className="p-4.5 flex flex-col gap-4 *:data-[slot=button]:self-start">
            <dl className="mb-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px] last:mb-0 [&_dd]:min-w-0 [&_dd]:wrap-anywhere [&_dt]:text-muted-foreground">
              <dt>Status</dt>
              <dd>
                <TaskStatus task={t} />
              </dd>
              <dt>Works in</dt>
              <dd>{t.cwd ? <code>{t.cwd}</code> : <span className="text-muted-foreground">a scratch folder</span>}</dd>
              <dt>Started</dt>
              <dd>
                <RelTime iso={t.created} />
              </dd>
            </dl>
            {/* a chat has no budget: what it spent, no limit */}
            <Meter value={spent(t)} max={0} label="Spending" detail={spendLine(t)} />
            <Meter value={t.hours} max={0} label="Hours" detail={`${+t.hours.toFixed(1)} h, no limit`} />
            {d.data.schedules.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Schedules</p>
                <ul className="flex flex-col gap-2 *:data-[slot=button]:self-start">
                  {d.data.schedules.map((s) => (
                    <li key={s.id}>
                      <p className="text-[13px]">{s.text}</p>
                      <p className="text-muted-foreground text-[13px]">
                        <ScheduleWhen s={s} />
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-col gap-2 *:data-[slot=button]:self-start">
              <Link
                to={`/tasks/${id}`}
                className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-brand-text hover:underline"
              >
                <Icon name="tasks" size={15} /> Task page
              </Link>
              <button
                type="button"
                className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-brand-text hover:underline"
                onClick={() => setLog(true)}
              >
                <Icon name="file" size={15} /> Session log
              </button>
            </div>
            {isOpen(t) && (
              <Button
                variant="quiet-danger"
                icon="x"
                onClick={async () => {
                  if (
                    await confirmAction({
                      title: "Close this chat?",
                      body: "It stops now and cannot be reopened. Its history stays under Tasks.",
                      confirm: "Close chat",
                      danger: true,
                    })
                  )
                    await call("task.close", { id, outcome: "done" });
                }}
              >
                Close chat
              </Button>
            )}
            <Button variant="quiet-danger" icon="trash" onClick={() => deleteChat(id)}>
              Delete chat
            </Button>
          </div>
        </aside>
      )}
      {t && <BudgetDialog task={t} open={budget} onClose={() => setBudget(false)} />}
      <SessionLogDialog id={id} open={log} onClose={() => setLog(false)} />
    </div>
  );
}
