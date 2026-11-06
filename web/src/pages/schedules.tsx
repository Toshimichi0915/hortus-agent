/** Schedules: what tasks set to run later or again, in words rather than cron. */
import { type Schedule, call, useCall } from "../api.ts";
import { Markdown } from "../markdown.tsx";
import {
  buttonVariants,
  absTime,
  Button,
  Card,
  confirmAction,
  Empty,
  Icon,
  Link,
  Page,
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
  if (m === "0" && h === "*" && dom === "*" && mon === "*" && dow === "*") return "Every hour, on the hour";
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

function Item({ s }: { s: Schedule }) {
  const [unset, busy] = useAction(() => call("schedule.unset", { id: s.id }), "Unscheduled");
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)] items-start gap-3.5 py-3.5 first:pt-0.5 last:pb-0 sm:grid-cols-[36px_minmax(0,1fr)_auto] max-sm:[&>button]:col-start-2 max-sm:[&>button]:justify-self-start">
      <span className="grid size-8 place-items-center rounded-lg bg-brand/10 text-brand sm:size-9" aria-hidden="true">
        <Icon name={s.cron || s.every_sec ? "refresh" : "calendar"} size={18} />
      </span>
      <div className="min-w-0">
        <p className="font-medium">{s.text}</p>
        <p className="mt-0.5 text-[13px] text-foreground/80">{describe(s)}</p>
        <div className="mt-1.5 mb-1 flex flex-wrap gap-x-4.5 gap-y-1 text-xs text-muted-foreground">
          <span>
            Next: <RelTime iso={s.fire_at} empty="not planned" />
          </span>
          <span>
            Last run: <RelTime iso={s.last_run} empty="never" />
          </span>
          <span>
            {s.expires_at ? (
              <>
                Ends <RelTime iso={s.expires_at} />
              </>
            ) : (
              "No end date"
            )}
          </span>
        </div>
        {s.summary && (
          <details className="[&>summary]:cursor-pointer [&>summary]:text-[13px] [&>summary]:font-medium [&>summary]:text-foreground/80 [&[open]>summary]:mb-2 [&>pre]:max-h-72 [&>pre]:overflow-auto [&>pre]:rounded-md [&>pre]:border [&>pre]:bg-muted/50 [&>pre]:p-2.5 [&>pre]:text-xs [&>pre]:wrap-anywhere [&>pre]:whitespace-pre-wrap">
            <summary>What the last run said</summary>
            <Markdown text={s.summary} />
          </details>
        )}
      </div>
      <Button
        size="sm"
        variant="quiet-danger"
        loading={busy}
        onClick={async () => {
          if (
            await confirmAction({
              title: "Unschedule this?",
              body: `“${s.text}” will not run again. The task that set it stays open.`,
              confirm: "Unschedule",
              danger: true,
            })
          )
            unset();
        }}
      >
        Unschedule
      </Button>
    </li>
  );
}

export function Schedules() {
  const list = useCall<Schedule[]>("schedule.list", {}, ["tasks"]);
  const groups = new Map<string, Schedule[]>();
  for (const s of list.data ?? []) groups.set(s.task_id, [...(groups.get(s.task_id) ?? []), s]);
  return (
    <Page
      title="Schedules"
      description="Runs that tasks set up for later, once or again and again. Each run spends the budget of the task that set it."
    >
      {!list.data ? (
        <div className="grid flex-1 place-items-center p-12 text-muted-foreground">
          <Spinner />
        </div>
      ) : groups.size ? (
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          {[...groups].map(([task, items]) => (
            <Card
              key={task}
              title={<Link to={`/tasks/${task}`}>{items[0]?.title ?? task}</Link>}
              description={`${items.length} schedule${items.length === 1 ? "" : "s"}`}
            >
              <ul className="divide-y">
                {items.map((s) => (
                  <Item key={s.id} s={s} />
                ))}
              </ul>
            </Card>
          ))}
        </div>
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
