/**
 * A task's stream as a conversation: the owner's messages as bubbles, the Worker's text as Markdown, and the steps in
 * between (thinking, tool calls and their output, status lines) folded into one "activity" line per run of them.
 */
import { type ReactNode, useEffect, useState } from "react";
import type { Row } from "./api.ts";
import { Markdown } from "./markdown.tsx";
import { CopyButton, cn, Icon, type IconName, Logo, RelTime, Spinner } from "./ui.tsx";

interface Tool {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
}

type Part =
  | { kind: "text"; text: string; closed?: boolean }
  | { kind: "thinking"; text: string }
  | Tool
  | { kind: "status"; text: string }
  | { kind: "error"; text: string };

interface Turn {
  role: "user" | "assistant";
  key: number;
  at: string;
  parts: Part[];
}

/** Text and thinking arrive as deltas, a row each: a run of them is one part; a `message` row ends a text part. */
export function toTurns(rows: Row[]): Turn[] {
  const turns: Turn[] = [];
  for (const r of rows) {
    const b = r.body;
    if (b.type === "owner") {
      turns.push({ role: "user", key: r.seq, at: r.created, parts: [{ kind: "text", text: b.text }] });
      continue;
    }
    let t = turns.at(-1);
    if (!t || t.role === "user") {
      t = { role: "assistant", key: r.seq, at: r.created, parts: [] };
      turns.push(t);
    }
    t.at = r.created;
    const last = t.parts.at(-1);
    switch (b.type) {
      case "message":
        if (last?.kind === "text") last.closed = true;
        break;
      case "text":
        if (last?.kind === "text" && !last.closed) last.text += b.text;
        else t.parts.push({ kind: "text", text: b.text });
        break;
      case "thinking":
        if (last?.kind === "thinking") last.text += b.text;
        else t.parts.push({ kind: "thinking", text: b.text });
        break;
      case "tool_call":
        t.parts.push({ kind: "tool", id: b.id, name: b.name, input: b.input });
        break;
      case "tool_result": {
        const call = t.parts.find((p): p is Tool => p.kind === "tool" && p.id === b.id);
        if (call) Object.assign(call, { output: b.output, isError: b.isError });
        else t.parts.push({ kind: "tool", id: b.id, name: "tool", input: {}, output: b.output, isError: b.isError });
        break;
      }
      case "status":
        t.parts.push({ kind: "status", text: b.text });
        break;
      case "error":
        t.parts.push({ kind: "error", text: b.message });
        break;
    }
  }
  return turns;
}

export function Thread({ rows, live }: { rows: Row[]; live: boolean }) {
  const turns = toTurns(rows);
  return (
    <>
      {turns.map((t, i) =>
        t.role === "user" ? (
          <UserTurn key={t.key} turn={t} />
        ) : (
          <AssistantTurn key={t.key} turn={t} live={live && i === turns.length - 1} />
        ),
      )}
    </>
  );
}

const textOf = (t: Turn) =>
  t.parts
    .filter((p) => p.kind === "text")
    .map((p) => p.text)
    .join("\n\n");

function UserTurn({ turn }: { turn: Turn }) {
  const text = textOf(turn);
  return (
    <article className="group flex flex-col gap-1 max-w-[min(85%,620px)] items-end self-end" aria-label="You said">
      <div className="rounded-[20px] rounded-br-md bg-muted px-4 py-2.5 text-[15.5px] leading-relaxed wrap-anywhere whitespace-pre-wrap">
        {text}
      </div>
      <div className="flex min-h-7 items-center gap-0.5 text-xs text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
        <CopyButton text={text} label="Copy message" />
        <RelTime iso={turn.at} />
      </div>
    </article>
  );
}

function AssistantTurn({ turn, live }: { turn: Turn; live: boolean }) {
  const segs: (Part | Part[])[] = [];
  for (const p of turn.parts) {
    if (p.kind === "text" || p.kind === "error") segs.push(p);
    else {
      const last = segs.at(-1);
      if (Array.isArray(last)) last.push(p);
      else segs.push([p]);
    }
  }
  const text = textOf(turn);
  return (
    <article
      className="group flex flex-col gap-1 grid grid-cols-[minmax(0,1fr)] gap-3.5 sm:grid-cols-[28px_minmax(0,1fr)]"
      aria-label="hortus said"
    >
      <span className="mt-px grid size-7 place-items-center rounded-full bg-brand/10 max-sm:hidden" aria-hidden="true">
        <Logo size={16} />
      </span>
      <div className="flex min-w-0 flex-col gap-3">
        {segs.map((s, i) => {
          const end = i === segs.length - 1;
          const key = `${turn.key}.${i}`;
          if (Array.isArray(s)) return <Activity key={key} steps={s} live={live && end} />;
          if (s.kind === "text")
            return (
              <Markdown
                key={key}
                text={s.text}
                className={
                  live && end
                    ? "[&>:last-child]:after:ml-1 [&>:last-child]:after:inline-block [&>:last-child]:after:h-[1em] [&>:last-child]:after:w-1.5 [&>:last-child]:after:rounded-sm [&>:last-child]:after:bg-brand [&>:last-child]:after:align-text-bottom [&>:last-child]:after:content-[''] motion-safe:[&>:last-child]:after:animate-blink"
                    : undefined
                }
              />
            );
          return (
            <div
              key={key}
              className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
              role="alert"
            >
              <Icon name="alert" size={16} /> {s.kind === "error" ? s.text : ""}
            </div>
          );
        })}
        {!live && text && (
          <div className="flex min-h-7 items-center gap-0.5 text-xs text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
            <CopyButton text={text} label="Copy reply" />
            <RelTime iso={turn.at} />
          </div>
        )}
      </div>
    </article>
  );
}

/** The owner waits on the Worker: no line of its turn yet. */
export function Pending({ text = "Thinking" }: { text?: string }) {
  return (
    <article
      className="group flex flex-col gap-1 grid grid-cols-[minmax(0,1fr)] gap-3.5 sm:grid-cols-[28px_minmax(0,1fr)]"
      aria-label="hortus is working"
    >
      <span className="mt-px grid size-7 place-items-center rounded-full bg-brand/10 max-sm:hidden" aria-hidden="true">
        <Logo size={16} />
      </span>
      <div className="flex min-w-0 flex-col gap-3">
        <p className="w-fit bg-[linear-gradient(90deg,var(--muted-foreground)_30%,var(--foreground)_50%,var(--muted-foreground)_70%)] bg-[length:220%_100%] bg-clip-text pt-1 text-[15px] text-transparent motion-safe:animate-shimmer">
          {text}…
        </p>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Activity

function label(p: Tool): { icon: IconName; text: ReactNode } {
  const i = (p.input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  if (p.name === "bash") return { icon: "terminal", text: <code className="whitespace-pre-wrap">{s("command")}</code> };
  if (p.name === "read")
    return {
      icon: "file",
      text: (
        <>
          Read <code>{s("path")}</code>
        </>
      ),
    };
  if (p.name === "edit" || p.name === "write")
    return {
      icon: "edit",
      text: (
        <>
          {p.name === "edit" ? "Edited" : "Wrote"} <code>{s("path")}</code>
        </>
      ),
    };
  if (p.name.startsWith("browser_"))
    return {
      icon: "globe",
      text: s("url") ? (
        <>
          Opened <code>{s("url")}</code>
        </>
      ) : (
        `Browser: ${p.name.slice(8)}`
      ),
    };
  if (p.name === "merge") return { icon: "merge", text: "Asked to merge into main" };
  if (p.name === "send")
    return {
      icon: "send",
      text: (
        <>
          Sent a message
          {s("to") && (
            <>
              {" "}
              to <code>{s("to")}</code>
            </>
          )}
        </>
      ),
    };
  if (p.name === "schedule") return { icon: "clock", text: "Set a schedule" };
  if (p.name === "unschedule") return { icon: "clock", text: "Removed a schedule" };
  if (p.name === "done") return { icon: "check", text: "Finished the task" };
  return {
    icon: "wrench",
    text: (
      <>
        {p.name} <code>{JSON.stringify(p.input)}</code>
      </>
    ),
  };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));

function summarize(steps: Part[]): string {
  const tools = steps.filter((p): p is Tool => p.kind === "tool");
  const count = (f: (t: Tool) => boolean) => tools.filter(f).length;
  const bits: string[] = [];
  if (steps.some((p) => p.kind === "thinking")) bits.push("thought");
  const cmd = count((t) => t.name === "bash");
  if (cmd) bits.push(plural(cmd, "ran a command", "ran # commands"));
  const read = count((t) => t.name === "read");
  if (read) bits.push(plural(read, "read a file", "read # files"));
  const edit = count((t) => t.name === "edit" || t.name === "write");
  if (edit) bits.push(plural(edit, "edited a file", "edited # files"));
  if (count((t) => t.name.startsWith("browser_"))) bits.push("used the browser");
  if (count((t) => t.name === "merge")) bits.push("asked to merge");
  if (count((t) => t.name === "send")) bits.push("sent a message");
  if (count((t) => t.name === "schedule")) bits.push("set a schedule");
  const s = bits.join(", ") || "worked";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function liveText(steps: Part[]): ReactNode {
  const last = steps.at(-1);
  if (!last) return "Working";
  if (last.kind === "status") return last.text;
  if (last.kind === "thinking") return "Thinking";
  if (last.kind === "tool") return last.output === undefined ? label(last).text : "Working";
  return "Working";
}

function Activity({ steps, live }: { steps: Part[]; live: boolean }) {
  const [open, setOpen] = useState(live);
  // a run that finishes folds away, as a finished one starts folded
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);
  const failed = steps.filter((p) => p.kind === "tool" && p.isError).length;
  return (
    <div
      className={cn(
        "max-w-full self-start rounded-lg border border-transparent",
        open && "self-stretch border-border bg-card",
      )}
    >
      <button
        type="button"
        className={cn(
          "flex max-w-full cursor-pointer items-center gap-2 rounded-lg py-1 pr-2.5 pl-2 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground",
          open && "w-full rounded-b-none border-b",
        )}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {live ? <Spinner size={14} /> : <Icon name="sparkle" size={16} />}
        <span
          className={cn(
            "min-w-0 truncate",
            live &&
              "w-fit bg-[linear-gradient(90deg,var(--muted-foreground)_30%,var(--foreground)_50%,var(--muted-foreground)_70%)] bg-[length:220%_100%] bg-clip-text pt-1 text-[15px] text-transparent motion-safe:animate-shimmer pt-0! text-[13px]!",
          )}
        >
          {live ? liveText(steps) : summarize(steps)}
        </span>
        {!live && failed > 0 && (
          <span className="text-xs whitespace-nowrap text-destructive">
            {plural(failed, "1 step failed", "# steps failed")}
          </span>
        )}
        <Icon name="chevronDown" size={16} className={cn("transition-transform", open && "ml-auto rotate-180")} />
      </button>
      {open && (
        <ol className="py-1.5">
          {steps.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps only ever append
            <Step key={i} step={s} live={live && i === steps.length - 1} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Step({ step, live }: { step: Part; live: boolean }) {
  if (step.kind === "thinking")
    return (
      <li className="grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 px-3.5 py-1.5 text-[13px] [&>svg]:mt-0.5 [&>svg]:text-muted-foreground">
        <Icon name="sparkle" size={16} />
        <div className="min-w-0">
          <p className="wrap-anywhere text-foreground/80 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:text-xs">
            Thinking
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{step.text}</p>
        </div>
      </li>
    );
  if (step.kind === "status")
    return (
      <li className="grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 px-3.5 py-1.5 text-[13px] [&>svg]:mt-0.5 [&>svg]:text-muted-foreground [&_p]:text-muted-foreground [&_p]:italic">
        <Icon name="info" size={16} />
        <div className="min-w-0">
          <p className="wrap-anywhere text-foreground/80 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:text-xs">
            {step.text}
          </p>
        </div>
      </li>
    );
  if (step.kind !== "tool") return null;
  const l = label(step);
  return (
    <li
      className={cn(
        "grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 px-3.5 py-1.5 text-[13px] [&>svg]:mt-0.5 [&>svg]:text-muted-foreground",
        step.isError && "[&>svg]:text-destructive!",
      )}
    >
      {live && step.output === undefined ? <Spinner size={14} /> : <Icon name={l.icon} size={16} />}
      <div className="min-w-0">
        <p className="wrap-anywhere text-foreground/80 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:text-xs">
          {l.text}
        </p>
        {step.output !== undefined && (
          <details className="mt-1 [&>summary]:w-fit [&>summary]:cursor-pointer [&>summary]:text-xs [&>summary]:text-muted-foreground [&>pre]:mt-1.5 [&>pre]:max-h-64 [&>pre]:overflow-auto [&>pre]:rounded-md [&>pre]:border [&>pre]:bg-muted/50 [&>pre]:px-3 [&>pre]:py-2.5 [&>pre]:text-xs">
            <summary>{step.isError ? "Output (failed)" : "Output"}</summary>
            <pre>{step.output || "(no output)"}</pre>
          </details>
        )}
      </div>
    </li>
  );
}
