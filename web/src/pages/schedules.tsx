/** Schedules: what tasks set to run later or again, in words rather than cron. */
import { type ReactNode, useState } from "react";
import { call, type Schedule, type ScheduleRun, useCall } from "../api.ts";
import { Markdown } from "../markdown.tsx";
import {
  absTime,
  buttonVariants,
  Card,
  cn,
  confirmAction,
  Empty,
  Icon,
  IconButton,
  Link,
  Page,
  Pill,
  RelTime,
  Spinner,
  useAction,
} from "../ui.tsx";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const n = (v: number, unit: string) => (v === 1 ? unit : `${v} ${unit}s`);

function every(sec: number): string {
  if (sec % 86400 === 0) return n(sec / 86400, "day");
  if (sec % 3600 === 0) return n(sec / 3600, "hour");
  if (sec % 60 === 0) return n(sec / 60, "minute");
  return n(sec, "second");
}

/** The common shapes in words; anything else as the cron line itself. */
export function cronText(cron: string): string {
  const [m = "", h = "", dom, mon, dow = ""] = cron.trim().split(/\s+/);
  const time = /^\d+$/.test(m) && /^\d+$/.test(h) ? `${h.padStart(2, "0")}:${m.padStart(2, "0")}` : null;
  if (time && dom === "*" && mon === "*") {
    if (dow === "*") return `Every day at ${time}`;
    if (dow === "1-5") return `Weekdays at ${time}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends at ${time}`;
    if (/^[0-6]$/.test(dow)) return `Every ${DAYS[Number(dow)]} at ${time}`;
  }
  if (/^\d+$/.test(m) && dom === "*" && mon === "*" && dow === "*") {
    const at = m === "0" ? "on the hour" : `at :${m.padStart(2, "0")}`;
    if (h === "*") return `Every hour, ${at}`;
    if (/^\*\/\d+$/.test(h)) return `Every ${n(Number(h.slice(2)), "hour")}, ${at}`;
  }
  return `cron ${cron}`;
}

export function describe(s: Schedule): string {
  if (s.cron) return `${cronText(s.cron)}${s.tz ? ` (${s.tz})` : ""}`;
  if (s.every_sec) return `Every ${every(s.every_sec)}`;
  return s.fire_at ? `Once, ${absTime(s.fire_at)}` : "Once";
}

export const ScheduleWhen = ({ s }: { s: Schedule }) => (
  <>
    {describe(s)}
    {s.fire_at && (
      <>
        {" · next "}
        <RelTime iso={s.fire_at} />
      </>
    )}
  </>
);

function RunStatus({ r }: { r: ScheduleRun }) {
  if (r.status === "queued") return <Pill dot>Queued</Pill>;
  if (r.status === "running" || r.status === "waiting")
    return (
      <Pill tone="info" dot pulse>
        Running
      </Pill>
    );
  if (r.status === "failed") return <Pill tone="danger">Failed</Pill>;
  return r.tokens > 0 ? (
    <Pill tone="ok">Done · model called</Pill>
  ) : (
    <Pill title="Its script decided there was nothing to do">Done · no model call</Pill>
  );
}

function Runs({ id }: { id: number }) {
  const runs = useCall<ScheduleRun[]>("schedule.runs", { id }, ["tasks"]);
  if (!runs.data) return runs.error ? <p className="text-xs text-destructive">{runs.error}</p> : <Spinner />;
  if (!runs.data.length) return <p className="text-[13px] text-muted-foreground">No runs yet.</p>;
  return (
    <ul className="max-h-72 divide-y overflow-auto rounded-md border bg-background text-[13px]">
      {runs.data.map((r) => (
        <li key={r.task_id} className="flex items-center justify-between gap-3 px-3 py-2">
          {/* a run that never reached the model is deleted; one that did (or still runs) has a task to open */}
          {r.status && (r.tokens > 0 || r.status !== "done") ? (
            <Link to={`/tasks/${r.task_id}`} title={r.task_id}>
              {absTime(r.fired)}
            </Link>
          ) : (
            <span className="text-muted-foreground">{absTime(r.fired)}</span>
          )}
          <RunStatus r={r} />
        </li>
      ))}
    </ul>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-1.5">
    <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
    {children}
  </section>
);

function Item({ s }: { s: Schedule }) {
  const [unset, busy] = useAction(() => call("schedule.unset", { id: s.id }), "Unscheduled");
  const [fire, firing] = useAction(() => call("schedule.fire", { id: s.id }), "Run started");
  const [open, setOpen] = useState(false);
  const recurring = Boolean(s.cron || s.every_sec);
  // text is the run's whole brief (it can be pages): its first line is the title, the whole of it folds away
  const head = s.text.trim().split("\n")[0] ?? "";
  const panel = `schedule-${s.id}`;
  return (
    <li className="group/item">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5">
        <span
          className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand"
          title={recurring ? "Recurring" : "Once"}
        >
          <Icon name={recurring ? "refresh" : "calendar"} size={18} />
        </span>
        <div className="min-w-0 flex-[1_1_240px]">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panel}
            onClick={() => setOpen(!open)}
            className="flex max-w-full items-center gap-1 text-left font-medium hover:underline"
            title={head}
          >
            <span className="truncate">{head}</span>
            <Icon
              name="chevronDown"
              size={16}
              className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
            />
          </button>
          <p className="mt-0.5 text-[13px] text-foreground/80">{describe(s)}</p>
          <p className="truncate text-xs text-muted-foreground">
            from{" "}
            <Link to={`/tasks/${s.task_id}`} className="text-inherit underline-offset-2">
              {s.title ?? s.task_id}
            </Link>
          </p>
        </div>
        <div className="ml-13 flex items-center gap-3 sm:ml-0">
          <div className="text-[13px] leading-tight sm:min-w-28 sm:text-right">
            {s.fire_at ? (
              <>
                <p className="font-medium">
                  <RelTime iso={s.fire_at} />
                </p>
                <p className="text-xs text-muted-foreground">next run</p>
              </>
            ) : (
              <p className="text-muted-foreground">Not planned</p>
            )}
          </div>
          <div className="flex gap-0.5">
            {recurring && <IconButton size="sm" icon="play" label="Run now" loading={firing} onClick={() => fire()} />}
            <IconButton
              size="sm"
              icon="trash"
              label="Unschedule"
              variant="quiet-danger"
              loading={busy}
              onClick={async () => {
                if (
                  await confirmAction({
                    title: "Unschedule this?",
                    body: `“${head}” will not run again. The task that set it stays open.`,
                    confirm: "Unschedule",
                    danger: true,
                  })
                )
                  unset();
              }}
            />
          </div>
        </div>
      </div>
      {open && (
        <div id={panel} className="flex flex-col gap-4 border-t bg-muted/40 px-4 py-4 sm:pr-5 sm:pl-18">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px] [&>dt]:text-muted-foreground">
            <dt>Next run</dt>
            <dd>{s.fire_at ? absTime(s.fire_at) : "Not planned"}</dd>
            <dt>Last run</dt>
            <dd>
              <RelTime iso={s.last_run} empty="Never" />
            </dd>
            <dt>Ends</dt>
            <dd>{s.expires_at ? <RelTime iso={s.expires_at} /> : "No end date"}</dd>
          </dl>
          <Section title="Instructions">
            <div className="max-h-72 overflow-auto rounded-md border bg-background p-3 text-[13px] wrap-anywhere">
              <Markdown text={s.text} />
            </div>
          </Section>
          {s.summary && (
            <Section title="What the last run said">
              <div className="max-h-72 overflow-auto rounded-md border bg-background p-3 text-[13px] wrap-anywhere">
                <Markdown text={s.summary} />
              </div>
            </Section>
          )}
          {recurring && (
            <Section title="Run history">
              <Runs id={s.id} />
            </Section>
          )}
        </div>
      )}
    </li>
  );
}

/** Soonest first; nothing planned last. */
const byNext = (a: Schedule, b: Schedule) =>
  (a.fire_at ? Date.parse(a.fire_at) : Infinity) - (b.fire_at ? Date.parse(b.fire_at) : Infinity) || a.id - b.id;

export function Schedules() {
  const list = useCall<Schedule[]>("schedule.list", {}, ["tasks"]);
  const items = [...(list.data ?? [])].sort(byNext);
  const recurring = items.filter((s) => s.cron || s.every_sec).length;
  return (
    <Page
      title="Schedules"
      description="Runs that tasks set up for later, once or again and again. Each run spends the budget of the task that set it."
    >
      {!list.data ? (
        <div className="grid flex-1 place-items-center p-12 text-muted-foreground">
          <Spinner />
        </div>
      ) : items.length ? (
        <Card
          flush
          title={`${items.length} schedule${items.length === 1 ? "" : "s"}`}
          description={[
            recurring && `${recurring} recurring`,
            items.length - recurring && `${items.length - recurring} once`,
            "soonest first",
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <ul className="mt-3 divide-y border-t">
            {items.map((s) => (
              <Item key={s.id} s={s} />
            ))}
          </ul>
        </Card>
      ) : (
        <Empty
          icon="clock"
          title="No schedules yet"
          action={
            <Link to="/" className={buttonVariants({ variant: "outline" })}>
              Start a chat
            </Link>
          }
        >
          Ask in a chat, for example “Every weekday at 9, DM me a digest of new GitHub issues”, and the Worker sets one
          up.
        </Empty>
      )}
    </Page>
  );
}
