/**
 * Settings: every key of hortusd.json as a form, so nobody needs to learn its syntax. The sections share one draft;
 * the Save bar sends it whole (`settings.set` validates, writes and reloads). Sources, Projects and Credentials save
 * as they go, through their own RPCs.
 */
import { NativeSelect, NativeSelectOption, NativeSelectOptGroup } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Config, type Credential, call, type PlannerStatus, useCall } from "../api.ts";
import {
  ALWAYS_ASKS,
  checkCidr,
  checkHost,
  checkPath,
  DEFAULTS,
  type Draft,
  EFFORTS,
  validateConfig,
} from "../schema.ts";
import {
  Button,
  Callout,
  Card,
  Choice,
  CopyButton,
  confirmAction,
  cn,
  errorText,
  fmtNum,
  fmtTokens,
  Icon,
  type IconName,
  IconButton,
  Link,
  ListInput,
  Meter,
  navigate,
  NumberField,
  RelTime,
  SectionHead,
  SelectField,
  SERVICES,
  Spinner,
  Switch,
  setLeaveGuard,
  TextArea,
  TextField,
  theme,
  toast,
  useAction,
  useStore,
  useTitle,
} from "../ui.tsx";
import { CredentialDialog, Credentials, coreOnly, TRANSFORMS } from "./credentials.tsx";
import { Projects } from "./projects.tsx";
import { Remote } from "./remote.tsx";
import { Sources } from "./sources.tsx";

const SECTIONS: { group: string; items: { id: string; label: string; icon: IconName }[] }[] = [
  { group: "You", items: [{ id: "general", label: "General", icon: "user" }] },
  {
    group: "Agents",
    items: [
      { id: "planner", label: "Planner", icon: "compass" },
      { id: "workers", label: "Workers", icon: "wrench" },
      { id: "approvals", label: "Approvals", icon: "shield" },
    ],
  },
  {
    group: "Connections",
    items: [
      { id: "sources", label: "Sources", icon: "plug" },
      { id: "projects", label: "Projects", icon: "folder" },
      { id: "credentials", label: "Credentials", icon: "key" },
    ],
  },
  {
    group: "System",
    items: [
      { id: "sandbox", label: "Sandbox", icon: "box" },
      { id: "network", label: "Network", icon: "network" },
      { id: "vms", label: "Worker VMs", icon: "server" },
      { id: "remote", label: "Remote access", icon: "phone" },
      { id: "advanced", label: "Advanced", icon: "code" },
    ],
  },
];

/** The section a config path is edited in. */
function sectionOf(path: string): string {
  const [top = "", sub = ""] = path.split(".");
  if (top === "policy") return ["read", "cache", "deny"].includes(sub) ? "sandbox" : "approvals";
  return (
    {
      owner: "general",
      planner: "planner",
      worker: "workers",
      judge_notes: "approvals",
      dofs: "sources",
      projects: "projects",
      origins: "network",
      chat: "network",
      proxy: "network",
      vm: "vms",
      console: "remote",
    }[top] ?? "advanced"
  );
}

/** The sections where the draft differs from what hortusd has. */
function changed(a: Config, b: Config): Set<string> {
  const out = new Set<string>();
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (k === "policy") {
      const pa = a.policy as Record<string, unknown>;
      const pb = b.policy as Record<string, unknown>;
      for (const p of new Set([...Object.keys(pa), ...Object.keys(pb)]))
        if (JSON.stringify(pa[p]) !== JSON.stringify(pb[p])) out.add(sectionOf(`policy.${p}`));
    } else if (JSON.stringify(ra[k]) !== JSON.stringify(rb[k])) out.add(sectionOf(k));
  }
  return out;
}

const RESTART = ["console", "proxy"];

export function Settings({ section }: { section: string }) {
  const cfg = useCall<{ config: Config }>("settings.get", {}, ["settings"]);
  const saved = cfg.data?.config;
  const [draft, setDraft] = useState<Config>();
  const [server, setServer] = useState<Record<string, string>>({});
  const base = useRef("");
  // a newer copy from hortusd replaces an untouched draft; an edited one is kept
  useEffect(() => {
    if (!saved) return;
    setDraft((d) => (!d || JSON.stringify(d) === base.current ? structuredClone(saved) : d));
    base.current = JSON.stringify(saved);
  }, [saved]);
  const diff = useMemo(() => (draft && saved ? changed(draft, saved) : new Set<string>()), [draft, saved]);
  const dirty = diff.size > 0;
  const errors = useMemo(() => (draft ? { ...validateConfig(draft), ...server } : {}), [draft, server]);
  const nErrors = Object.keys(errors).length;
  const erred = new Set(Object.keys(errors).map(sectionOf));
  useEffect(() => {
    if (!dirty) return;
    setLeaveGuard((to) =>
      to.startsWith("/settings")
        ? true
        : confirmAction({
            title: "Leave without saving?",
            body: "Your changes to the settings are not saved yet.",
            confirm: "Leave",
            danger: true,
          }),
    );
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => {
      setLeaveGuard(null);
      removeEventListener("beforeunload", warn);
    };
  }, [dirty]);
  const [save, saving] = useAction(async () => {
    try {
      const r = await call<{ message?: string }>("settings.set", { config: draft });
      setServer({});
      const was = saved as Record<string, unknown>;
      const now = draft as Record<string, unknown>;
      if (RESTART.some((k) => JSON.stringify(now[k]) !== JSON.stringify(was[k])))
        toast("Restart hortusd for the remote access and proxy changes: sudo systemctl restart hortusd", "info");
      return { message: r.message ?? "Saved. hortusd reloaded its settings." };
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.data))
        setServer(
          Object.fromEntries(
            (e.data as { path: string[]; message: string }[]).map((i) => [i.path.join("."), i.message]),
          ),
        );
      throw e;
    }
  });
  useTitle("Settings");
  if (cfg.error && !saved)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-9 sm:px-8">
          <Callout tone="danger" title="Could not read the settings">
            {cfg.error}
          </Callout>
        </div>
      </div>
    );
  if (!draft || !saved)
    return (
      <div className="grid flex-1 place-items-center p-12 text-muted-foreground">
        <Spinner />
      </div>
    );
  const set: Draft["set"] = (change) => {
    setDraft((c) => {
      const n = structuredClone(c ?? saved);
      change(n);
      return n;
    });
    setServer({});
  };
  const commit: Draft["commit"] = async (change) => {
    const next = structuredClone(saved);
    change(next);
    try {
      await call("settings.set", { config: next });
    } catch (e) {
      toast(errorText(e), "error");
      return false;
    }
    set(change);
    return true;
  };
  const d: Draft = { saved, draft, errors, set, commit };
  const Section = {
    general: General,
    planner: Planner,
    workers: Workers,
    approvals: Approvals,
    sources: Sources,
    projects: Projects,
    credentials: Credentials,
    sandbox: Sandbox,
    network: Network,
    vms: Vms,
    remote: Remote,
    advanced: Advanced,
  }[section];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl items-start gap-4 px-4 pt-5 pb-12 md:grid-cols-[220px_minmax(0,1fr)] md:gap-10 md:px-8 md:pt-8 md:pb-16">
        <nav className="sticky top-6 flex flex-col gap-4.5 max-md:hidden" aria-label="Settings">
          <h1 className="mb-0.5 ml-3 text-xl font-semibold tracking-tight">Settings</h1>
          {SECTIONS.map((g) => (
            <div key={g.group} className="flex flex-col gap-px">
              <p className="mb-1 px-3 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                {g.group}
              </p>
              {g.items.map((it) => (
                <Link
                  key={it.id}
                  to={`/settings/${it.id}`}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm text-foreground/80 hover:bg-muted hover:text-foreground",
                    it.id === section &&
                      "bg-brand/10 font-medium text-brand-text hover:bg-brand/10 hover:text-brand-text",
                  )}
                  aria-current={it.id === section ? "page" : undefined}
                >
                  <Icon name={it.icon} size={17} />
                  <span>{it.label}</span>
                  {erred.has(it.id) ? (
                    <span className="ml-auto size-1.5 rounded-full bg-brand bg-destructive!" title="Needs a fix" />
                  ) : (
                    diff.has(it.id) && (
                      <span className="ml-auto size-1.5 rounded-full bg-brand" title="Unsaved changes" />
                    )
                  )}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <label className="block md:hidden [&_[data-slot=native-select-wrapper]]:w-full">
          <span className="sr-only">Section</span>
          <NativeSelect value={section} onChange={(e) => navigate(`/settings/${e.target.value}`)}>
            {SECTIONS.map((g) => (
              <NativeSelectOptGroup key={g.group} label={g.group}>
                {g.items.map((it) => (
                  <NativeSelectOption key={it.id} value={it.id}>
                    {it.label}
                    {diff.has(it.id) ? " •" : ""}
                  </NativeSelectOption>
                ))}
              </NativeSelectOptGroup>
            ))}
          </NativeSelect>
        </label>
        <div className="flex min-w-0 flex-col gap-4 *:data-[slot=button]:self-start">
          {Section ? (
            <Section d={d} />
          ) : (
            <Callout tone="warning" title={`No section ${section}`}>
              <Link to="/settings/general">Go to General</Link>
            </Callout>
          )}
        </div>
      </div>
      {dirty && (
        <section
          className="sticky bottom-0 z-20 border-t bg-background/85 px-4 py-2.5 backdrop-blur md:px-8"
          aria-label="Unsaved changes"
        >
          <div className="mx-auto flex max-w-[1088px] flex-wrap items-center justify-between gap-3 text-sm">
            <span className="flex flex-wrap items-center gap-2">
              <Icon name={nErrors ? "alert" : "info"} size={17} />
              {nErrors
                ? `${nErrors} field${nErrors === 1 ? " needs" : "s need"} a fix before saving`
                : `Unsaved changes in ${[...diff].map((s) => SECTIONS.flatMap((g) => g.items).find((i) => i.id === s)?.label ?? s).join(", ")}`}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => {
                  setDraft(structuredClone(saved));
                  setServer({});
                }}
              >
                Discard
              </Button>
              <Button variant="primary" loading={saving} disabled={nErrors > 0} onClick={() => save()}>
                Save changes
              </Button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// General

function General({ d }: { d: Draft }) {
  const c = d.draft;
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  const messengers = Object.entries(c.dofs).filter(([, x]) => SERVICES[x.type]?.kind === "messenger");
  const t = useStore(theme);
  const pause = useCall<{ paused: boolean }>("pause.get", {}, ["tasks"]);
  const [setPause] = useAction(
    (paused: boolean) => call("pause.set", { paused }),
    (r) => ((r as { paused: boolean }).paused ? "Paused" : "Resumed"),
  );
  let now = "";
  try {
    now = new Intl.DateTimeFormat(undefined, { timeStyle: "short", timeZone: c.owner.tz }).format();
  } catch {}
  return (
    <>
      <SectionHead title="General" />
      <Card title="You">
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          <TextField
            label="Time zone"
            hint={
              <>
                Your day: the Planner's daily cap, schedules and times follow it.
                {now && <> It is {now} there now.</>}
              </>
            }
            value={c.owner.tz}
            onChange={(v) =>
              d.set((x) => {
                x.owner.tz = v;
              })
            }
            list="tz-list"
            error={d.errors["owner.tz"]}
          />
          <datalist id="tz-list">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <SelectField
            label="Where hortus reaches you"
            hint="A DM there about new approvals, failed tasks, and tasks that stopped with nothing left to wake them."
            value={c.owner.notify ?? ""}
            onChange={(v) =>
              d.set((x) => {
                if (v) x.owner.notify = v;
                else delete x.owner.notify;
              })
            }
            options={[
              { value: "", label: "Nowhere: I'll check the console" },
              ...messengers.map(([n, x]) => ({ value: n, label: `${n} (${SERVICES[x.type]?.label} DM)` })),
            ]}
            error={d.errors["owner.notify"]}
          />
          {!messengers.length && (
            <p className="text-muted-foreground text-[13px]">
              Connect Slack, Discord or Telegram in <Link to="/settings/sources">Sources</Link> to get DMs.
            </p>
          )}
        </div>
      </Card>
      <Card title="Pause" description="Saved at once.">
        <Switch
          label="Pause hortus"
          hint="Queued tasks, schedules and the Planner wait until you resume. Running tasks go on."
          checked={!!pause.data?.paused}
          onChange={(v) => setPause(v)}
        />
      </Card>
      <Card title="Appearance" description="Saved at once, for this browser.">
        <Choice
          label="Theme"
          value={t}
          onChange={(v) => theme.set(v)}
          options={[
            { value: "system", label: "Match my device" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Planner and Workers

const CLAUDE = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

function ModelFields({
  provider,
  model,
  onProvider,
  onModel,
  errorProvider,
}: {
  provider: string | undefined;
  model: string | undefined;
  onProvider: (v: string) => void;
  onModel: (v: string) => void;
  errorProvider?: string | undefined;
}) {
  const creds = useCall<Credential[]>("credential.list", {}, ["settings"]);
  const [adding, setAdding] = useState(false);
  const tokens = (creds.data ?? []).filter((x) => x.type === "token" && !coreOnly(x));
  const ranked = [
    ...tokens.filter((x) => x.transform && TRANSFORMS[x.transform]?.provider),
    ...tokens.filter((x) => !(x.transform && TRANSFORMS[x.transform]?.provider)),
  ];
  const transform = creds.data?.find((x) => x.name === provider)?.transform;
  const missing = provider && creds.data && !creds.data.some((x) => x.name === provider);
  return (
    <>
      <div className="flex items-end gap-2 max-sm:flex-col max-sm:items-stretch [&>div]:flex-1">
        <SelectField
          label="Provider"
          hint="The credential its model calls go out with. Its transform says which API it speaks."
          value={provider ?? ""}
          onChange={onProvider}
          options={[
            { value: "", label: "Not set" },
            ...ranked.map((x) => ({
              value: x.name,
              label: `${x.name}${x.transform ? ` (${TRANSFORMS[x.transform]?.label ?? x.transform})` : ""}`,
            })),
            ...(missing ? [{ value: provider, label: `${provider} (no such credential)` }] : []),
          ]}
          error={missing ? `there is no credential ${provider}: add it, or pick another` : errorProvider}
        />
        <Button icon="plus" onClick={() => setAdding(true)}>
          Add a provider
        </Button>
      </div>
      <TextField
        label="Model"
        hint="Exactly as the provider names it."
        value={model ?? ""}
        onChange={onModel}
        mono
        placeholder={transform === "anthropic" ? "claude-sonnet-5-5" : "the provider's model name"}
        list={transform === "anthropic" ? "claude-models" : undefined}
      />
      <datalist id="claude-models">
        {CLAUDE.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <CredentialDialog
        open={adding}
        preset={{ provider: true }}
        existing={creds.data?.map((x) => x.name) ?? []}
        onClose={() => setAdding(false)}
        onSaved={onProvider}
      />
    </>
  );
}

const efforts = EFFORTS.map((e) => ({ value: e, label: e === "xhigh" ? "x-high" : e[0]?.toUpperCase() + e.slice(1) }));
const tokenPresets = (vs: number[]) => vs.map((v) => ({ label: fmtTokens(v), value: v }));

function Planner({ d }: { d: Draft }) {
  const p = d.draft.planner;
  const ps = useCall<PlannerStatus>("planner.status", {}, ["settings"]);
  const unset = !d.saved.planner.provider || !d.saved.planner.model;
  return (
    <>
      <SectionHead
        title="Planner"
        description="The Planner reads what arrives from your sources, in batches, and decides: open a task, add to one, tell you, or leave it."
      />
      <Card title="Today">
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          {unset && (
            <Callout tone="warning" title="The Planner is not running">
              Choose its provider and model below: until then, no batch runs and nothing is routed.
            </Callout>
          )}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
            <div>
              <p className="text-xs text-muted-foreground">Last batch</p>
              <p className="mt-0.5 text-lg font-semibold">
                <RelTime iso={ps.data?.last} empty="none yet" />
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Messages routed today</p>
              <p className="mt-0.5 text-lg font-semibold">{ps.data ? fmtNum(ps.data.routed) : "—"}</p>
            </div>
          </div>
          {ps.data && (
            <Meter
              value={ps.data.tokens}
              max={ps.data.cap}
              label="Tokens today"
              detail={`${fmtTokens(ps.data.tokens)} of ${fmtTokens(ps.data.cap)}`}
            />
          )}
          {ps.data && ps.data.tokens >= ps.data.cap && (
            <p className="text-muted-foreground text-[13px]">
              The cap is reached: batches wait until tomorrow, in your time zone.
            </p>
          )}
        </div>
      </Card>
      <Card title="Model">
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          <ModelFields
            provider={p.provider}
            model={p.model}
            onProvider={(v) =>
              d.set((x) => {
                x.planner.provider = v || undefined;
              })
            }
            onModel={(v) =>
              d.set((x) => {
                x.planner.model = v || undefined;
              })
            }
          />
          <Choice
            label="Thinking effort"
            hint="More thinking routes better, and costs more tokens."
            def="Low"
            value={p.effort}
            onChange={(v) =>
              d.set((x) => {
                x.planner.effort = v;
              })
            }
            options={efforts}
            onReset={
              p.effort !== DEFAULTS.planner.effort
                ? () =>
                    d.set((x) => {
                      x.planner.effort = "low";
                    })
                : undefined
            }
          />
        </div>
      </Card>
      <Card title="Limits">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Messages per batch"
            hint="The most one Planner session reads at once."
            def="50"
            value={p.batch_max}
            min={1}
            onChange={(v) =>
              d.set((x) => {
                x.planner.batch_max = v;
              })
            }
            error={d.errors["planner.batch_max"]}
            onReset={
              p.batch_max !== DEFAULTS.planner.batch_max
                ? () =>
                    d.set((x) => {
                      x.planner.batch_max = 50;
                    })
                : undefined
            }
          />
          <NumberField
            label="Tokens per day"
            hint="Past it, batches wait until tomorrow."
            def="5M"
            unit="tokens"
            value={p.daily_tokens}
            min={0}
            step={500_000}
            presets={tokenPresets([1e6, 5e6, 10e6, 20e6])}
            onChange={(v) =>
              d.set((x) => {
                x.planner.daily_tokens = v;
              })
            }
            error={d.errors["planner.daily_tokens"]}
          />
        </div>
      </Card>
      <Card title="Where it runs">
        <Choice
          cards
          value={p.runtime ?? "auto"}
          onChange={(v) =>
            d.set((x) => {
              if (v === "auto") delete x.planner.runtime;
              else x.planner.runtime = v;
            })
          }
          options={[
            { value: "auto", label: "Automatic", hint: "Its own VM once the image is built, this machine until then." },
            { value: "vm", label: "Always a VM", icon: "server", hint: "Batches wait while there is no image." },
            { value: "host", label: "This machine", icon: "box", hint: "In the sandbox, as host Workers run." },
          ]}
        />
      </Card>
    </>
  );
}

function Workers({ d }: { d: Draft }) {
  const w = d.draft.worker;
  const creds = useCall<Credential[]>("credential.list", {}, ["settings"]);
  const offered = (creds.data ?? []).filter((x) => !coreOnly(x));
  return (
    <>
      <SectionHead
        title="Workers"
        description="A Worker is the agent that does one task: a chat with you, a task the Planner opened, or a scheduled run."
      />
      <Card title="Model">
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          <ModelFields
            provider={w.provider}
            model={w.model}
            onProvider={(v) =>
              d.set((x) => {
                x.worker.provider = v || undefined;
              })
            }
            onModel={(v) =>
              d.set((x) => {
                x.worker.model = v || undefined;
              })
            }
          />
          {(w.provider !== d.draft.planner.provider || w.model !== d.draft.planner.model) && d.draft.planner.model && (
            <button
              type="button"
              className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-brand-text hover:underline"
              onClick={() =>
                d.set((x) => {
                  x.worker.provider = x.planner.provider;
                  x.worker.model = x.planner.model;
                })
              }
            >
              Use the Planner's model ({d.draft.planner.model})
            </button>
          )}
          <Choice
            label="Thinking effort"
            value={w.effort ?? ""}
            onChange={(v) =>
              d.set((x) => {
                if (v) x.worker.effort = v;
                else delete x.worker.effort;
              })
            }
            options={[{ value: "" as const, label: "Model default" }, ...efforts]}
          />
          <NumberField
            label="Context window"
            hint="How much the model reads at once, when the provider does not say."
            def="131,072"
            unit="tokens"
            value={w.context_window}
            min={1}
            step={1024}
            presets={[
              { label: "32k", value: 32_768 },
              { label: "128k", value: 131_072 },
              { label: "200k", value: 200_000 },
              { label: "1M", value: 1_000_000 },
            ]}
            onChange={(v) =>
              d.set((x) => {
                x.worker.context_window = v;
              })
            }
            error={d.errors["worker.context_window"]}
          />
        </div>
      </Card>
      <Card
        title="Budget for each task"
        description="A task stops itself at its budget. You can raise one task's on its page."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Tokens"
            def="2M"
            unit="tokens"
            value={w.budget.tokens}
            min={0}
            step={100_000}
            presets={tokenPresets([1e6, 2e6, 5e6, 10e6])}
            onChange={(v) =>
              d.set((x) => {
                x.worker.budget.tokens = v;
              })
            }
            error={d.errors["worker.budget.tokens"]}
          />
          <NumberField
            label="Hours"
            def="4"
            unit="hours"
            value={w.budget.hours}
            min={0}
            step={0.5}
            presets={[1, 4, 8, 24].map((v) => ({ label: `${v} h`, value: v }))}
            onChange={(v) =>
              d.set((x) => {
                x.worker.budget.hours = v;
              })
            }
            error={d.errors["worker.budget.hours"]}
          />
        </div>
      </Card>
      <Card
        title="Credentials tasks may use"
        description="What a new task is offered. The Planner narrows it per task; a task asks you for anything else."
      >
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          <Choice
            cards
            value={w.credentials.length ? "some" : "all"}
            onChange={(v) =>
              d.set((x) => {
                x.worker.credentials = v === "all" ? [] : offered.map((o) => o.name);
              })
            }
            options={[
              {
                value: "all",
                label: "All of them",
                hint: "Every credential but hortusd's own (webhook secrets, Slack's app token).",
              },
              { value: "some", label: "Only the ones I check" },
            ]}
          />
          {w.credentials.length > 0 && (
            <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
              <legend className="sr-only">Credentials offered to tasks</legend>
              {offered.map((o) => (
                <label
                  key={o.name}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] has-checked:border-brand has-checked:bg-brand/10"
                >
                  <input
                    type="checkbox"
                    checked={w.credentials.includes(o.name)}
                    onChange={(e) =>
                      d.set((x) => {
                        x.worker.credentials = e.target.checked
                          ? [...x.worker.credentials, o.name]
                          : x.worker.credentials.filter((n) => n !== o.name);
                      })
                    }
                  />
                  <code>{o.name}</code>
                </label>
              ))}
              <p className="text-muted-foreground text-[13px]">With none checked, tasks are offered all of them.</p>
            </fieldset>
          )}
        </div>
      </Card>
      <Card title="Plugins" description="Folders copied into every Worker as @hortus/core plugins.">
        <ListInput
          label="Plugin folders"
          optional
          values={w.plugins}
          onChange={(v) =>
            d.set((x) => {
              x.worker.plugins = v;
            })
          }
          check={checkPath}
          placeholder="/home/you/hortus-plugins/linear"
          error={d.errors["worker.plugins"]}
        />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Approvals: policy and judge notes

const MODES = [
  {
    value: "human" as const,
    label: "Ask me every time",
    icon: "user" as const,
    hint: "Every request that uses a credential waits for you. Safest, and many clicks: a pull request from issue to merge took 25–55.",
  },
  {
    value: "auto" as const,
    label: "Let the judge pass routine ones",
    icon: "scale" as const,
    hint: "A judge model passes routine requests; pushes, merges, deletes and whatever it doubts still come to you. The same pull request took 4–11.",
  },
];

function Approvals({ d }: { d: Draft }) {
  const c = d.draft;
  const policy = c.policy as Record<string, unknown>;
  const notes = c.judge_notes ?? {};
  const creds = useCall<Credential[]>("credential.list", {}, ["settings"]);
  const list = (creds.data ?? []).filter((x) => !coreOnly(x));
  const def = (policy["*"] as "human" | "auto" | undefined) ?? "human";
  const setNote = (k: string, v: string) =>
    d.set((x) => {
      const n = { ...(x.judge_notes ?? {}) };
      if (v) n[k] = v;
      else delete n[k];
      x.judge_notes = n;
    });
  const unnoted = list.filter((x) => !(`credential:${x.name}` in notes));
  return (
    <>
      <SectionHead
        title="Approvals"
        description="When a Worker's request uses a credential, the Approval Gate holds it. Here you choose who decides."
      />
      <Card title="By default">
        <Choice
          cards
          value={def}
          onChange={(v) =>
            d.set((x) => {
              (x.policy as Record<string, unknown>)["*"] = v;
            })
          }
          options={MODES}
        />
      </Card>
      <Card
        title="Per credential"
        description="Let the judge handle a credential you trust Workers with, or keep asking for one even when the default is the judge."
      >
        {list.length ? (
          <ul className="divide-y">
            {list.map((x) => {
              const key = `credential:${x.name}`;
              const v = policy[key] as "human" | "auto" | undefined;
              const mode = v ?? def;
              return (
                <li
                  key={x.name}
                  className="flex items-center gap-3 px-1 py-3 first:pt-1 last:pb-1 [&>svg]:text-muted-foreground"
                >
                  <Icon name="key" />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium [&_code]:rounded-md [&_code]:border [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:text-xs">
                      <code>{x.name}</code>
                    </p>
                    <p className="text-muted-foreground text-[13px]">
                      {mode === "human"
                        ? "Every request asks you."
                        : x.enabled
                          ? "The judge passes routine requests."
                          : "Its first request asks you once to enable it; then the judge takes the routine ones."}
                      {!v && " (the default)"}
                    </p>
                  </div>
                  <NativeSelect
                    aria-label={`Who decides for ${x.name}`}
                    value={v ?? ""}
                    onChange={(e) =>
                      d.set((y) => {
                        const p = y.policy as Record<string, unknown>;
                        if (e.target.value) p[key] = e.target.value;
                        else delete p[key];
                      })
                    }
                  >
                    <NativeSelectOption value="">Default ({def === "human" ? "ask me" : "judge"})</NativeSelectOption>
                    <NativeSelectOption value="human">Ask me</NativeSelectOption>
                    <NativeSelectOption value="auto">Judge</NativeSelectOption>
                  </NativeSelect>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-muted-foreground">
            No credentials yet. <Link to="/settings/credentials">Add one</Link>.
          </p>
        )}
      </Card>
      <Card title="Always asks you" description="These never go to the judge, whatever you choose above.">
        <ul className="flex flex-col gap-3 [&_li]:flex [&_li]:items-start [&_li]:gap-3 [&_svg]:mt-0.5 [&_svg]:text-muted-foreground">
          {[
            ...ALWAYS_ASKS,
            {
              what: "Anything from a task that read untrusted text",
              why: "A stranger's message, a web page or an untrusted search hit could be steering it.",
            },
          ].map((x) => (
            <li key={x.what}>
              <Icon name="lock" size={16} />
              <div>
                <p>{x.what}</p>
                <p className="text-muted-foreground text-[13px]">{x.why}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <Card
        title="Notes for the judge"
        description="Plain words the judge reads after its fixed rules, never instead of them: what is routine for you, and what never is."
      >
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          <TextArea
            label="For every request"
            value={notes["*"] ?? ""}
            onChange={(v) => setNote("*", v)}
            rows={3}
            placeholder="e.g. Reading my own repositories is routine. Posting anywhere public is not."
          />
          {Object.keys(notes)
            .filter((k) => k !== "*")
            .map((k) => (
              <div key={k} className="flex items-end gap-2 [&>div]:flex-1">
                <TextArea
                  label={
                    <>
                      For <code>{k.replace(/^credential:/, "")}</code>
                    </>
                  }
                  value={notes[k] ?? ""}
                  onChange={(v) => setNote(k, v)}
                  rows={2}
                />
                <IconButton label="Remove this note" icon="trash" size="sm" onClick={() => setNote(k, "")} />
              </div>
            ))}
          {unnoted.length > 0 && (
            <label className="inline-flex items-center gap-2 text-muted-foreground">
              <Icon name="plus" size={16} />
              <span className="sr-only">Add a note for a credential</span>
              <NativeSelect value="" onChange={(e) => e.target.value && setNote(`credential:${e.target.value}`, " ")}>
                <NativeSelectOption value="">Add a note for one credential…</NativeSelectOption>
                {unnoted.map((x) => (
                  <NativeSelectOption key={x.name} value={x.name}>
                    {x.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          )}
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Sandbox, Network, VMs

function Sandbox({ d }: { d: Draft }) {
  const p = d.draft.policy;
  const set = (k: "read" | "cache" | "deny") => (v: string[]) =>
    d.set((x) => {
      if (v.length) x.policy[k] = v;
      else delete x.policy[k];
    });
  return (
    <>
      <SectionHead
        title="Sandbox"
        description="Workers on this machine see their project's checkout, the toolchains in your home and little else: your dotfiles, ~/.ssh, other projects and your other programs stay out of reach."
      />
      <Card
        title="Extra folders Workers can read"
        description="Read-only. A program linked from an allowed folder needs its target listed too."
      >
        <ListInput
          label="Folders"
          optional
          values={p.read ?? []}
          onChange={set("read")}
          check={checkPath}
          placeholder="/home/you/tools"
          error={d.errors["policy.read"]}
        />
      </Card>
      <Card
        title="Shared writable folders"
        description="Every task can write here, so tasks see each other's files. For tooling that insists on /tmp, or a device like /dev/ttyUSB0."
      >
        <ListInput
          label="Folders and devices"
          optional
          values={p.cache ?? []}
          onChange={set("cache")}
          check={checkPath}
          placeholder="/tmp"
          error={d.errors["policy.cache"]}
        />
      </Card>
      <Card title="Always hidden" description="Hidden from every Worker, even inside a folder allowed above.">
        <ListInput
          label="Folders and files"
          optional
          values={p.deny ?? []}
          onChange={set("deny")}
          check={checkPath}
          placeholder="/home/you/.config/secrets"
          error={d.errors["policy.deny"]}
        />
      </Card>
    </>
  );
}

function Network({ d }: { d: Draft }) {
  const c = d.draft;
  const ports = [
    ["https", "HTTPS", "8443"],
    ["http", "HTTP", "8080"],
    ["dns", "DNS", "8053"],
  ] as const;
  return (
    <>
      <SectionHead
        title="Network"
        description="Every request a Worker makes goes through hortusd's proxy. This is where it may go."
      />
      <Card title="Websites Workers can reach">
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          <Choice
            cards
            value={c.origins === "*" ? "any" : "list"}
            onChange={(v) =>
              d.set((x) => {
                x.origins = v === "any" ? "*" : [];
              })
            }
            options={[
              {
                value: "any",
                label: "Any public website",
                icon: "globe",
                hint: "Private and local addresses stay blocked.",
              },
              {
                value: "list",
                label: "Only the sites I list",
                icon: "lock",
                hint: "Each project can add its own (Projects).",
              },
            ]}
          />
          {c.origins !== "*" && (
            <ListInput
              label="Sites"
              values={c.origins}
              onChange={(v) =>
                d.set((x) => {
                  x.origins = v;
                })
              }
              check={checkHost}
              placeholder="registry.npmjs.org"
              error={d.errors.origins}
            />
          )}
          <p className="text-muted-foreground text-[13px]">
            A session's own model provider is always reachable. A change reaches open tasks at their next request.
          </p>
        </div>
      </Card>
      <Card
        title="Your local network"
        description="Private, loopback and link-local addresses are blocked unless listed here, like a NAS or a dev server on your LAN."
      >
        <ListInput
          label="Addresses"
          optional
          values={c.chat.allow}
          onChange={(v) =>
            d.set((x) => {
              x.chat.allow = v;
            })
          }
          check={checkCidr}
          placeholder="192.168.1.20 or 192.168.1.0/24"
        />
      </Card>
      <Card
        title="Proxy ports"
        description="Where the proxy listens; nftables sends the sessions' 443, 80 and 53 there."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          {ports.map(([k, label, def]) => (
            <NumberField
              key={k}
              label={label}
              restart
              def={def}
              value={c.proxy[k]}
              min={0}
              max={65535}
              onChange={(v) =>
                d.set((x) => {
                  x.proxy[k] = v;
                })
              }
              error={d.errors[`proxy.${k}`]}
            />
          ))}
        </div>
      </Card>
    </>
  );
}

function Vms({ d }: { d: Draft }) {
  const v = d.draft.vm;
  const img = useCall<{ present: boolean; built?: string; dir: string }>("vm.image");
  const set = (f: (vm: Config["vm"]) => void) => d.set((x) => f(x.vm));
  return (
    <>
      <SectionHead
        title="Worker VMs"
        description="A project set to run in a VM gives each task its own QEMU machine: for builds that need root, containers, or a clean system."
      />
      <Card title="Image">
        {!img.data ? (
          <Spinner />
        ) : img.data.present ? (
          <div className="flex flex-col gap-2 *:data-[slot=button]:self-start">
            <p className="flex flex-wrap items-center gap-2">
              <Icon name="check" /> Built <RelTime iso={img.data.built} />, in <code>{img.data.dir}</code>.
            </p>
            <p className="text-muted-foreground text-[13px]">
              Rebuild it after updating hortus: the VMs run the image's copy.
            </p>
            <div className="mt-1 flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/50 py-0.5 pr-0.5 pl-3 [&_code]:min-w-0 [&_code]:flex-1 [&_code]:overflow-x-auto [&_code]:text-xs [&_code]:whitespace-nowrap">
              <code>hortus image build</code>
              <CopyButton text="hortus image build" />
            </div>
          </div>
        ) : (
          <Callout tone="warning" title="No image yet">
            Build it on this machine (it needs sudo):
            <div className="mt-1 flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/50 py-0.5 pr-0.5 pl-3 [&_code]:min-w-0 [&_code]:flex-1 [&_code]:overflow-x-auto [&_code]:text-xs [&_code]:whitespace-nowrap">
              <code>hortus image build</code>
              <CopyButton text="hortus image build" />
            </div>
          </Callout>
        )}
      </Card>
      <Card title="Each VM">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="CPUs"
            def="2"
            value={v.cpus}
            min={1}
            onChange={(n) =>
              set((x) => {
                x.cpus = n;
              })
            }
            error={d.errors["vm.cpus"]}
          />
          <NumberField
            label="Memory"
            def="4096 MB"
            unit="MB"
            value={v.mem_mb}
            min={256}
            step={512}
            presets={[2048, 4096, 8192, 16384].map((n) => ({ label: `${n / 1024} GB`, value: n }))}
            onChange={(n) =>
              set((x) => {
                x.mem_mb = n;
              })
            }
            error={d.errors["vm.mem_mb"]}
          />
          <NumberField
            label="At most at once"
            hint="More wait in the queue."
            def="4"
            unit="VMs"
            value={v.max_concurrent}
            min={1}
            onChange={(n) =>
              set((x) => {
                x.max_concurrent = n;
              })
            }
            error={d.errors["vm.max_concurrent"]}
          />
          <NumberField
            label="Boot timeout"
            hint="A VM that has not booted by then is stopped, and its task fails."
            def="120 s"
            unit="seconds"
            value={v.boot_timeout_s}
            min={1}
            onChange={(n) =>
              set((x) => {
                x.boot_timeout_s = n;
              })
            }
            error={d.errors["vm.boot_timeout_s"]}
          />
        </div>
      </Card>
      <Card title="While there is no image">
        <Choice
          cards
          value={v.fallback_host ? "host" : "queue"}
          onChange={(x) =>
            set((vm) => {
              vm.fallback_host = x === "host";
            })
          }
          options={[
            { value: "host", label: "Run them on this machine", icon: "box", hint: "In the sandbox, unattended." },
            { value: "queue", label: "Keep them queued", icon: "clock", hint: "They start once the image is built." },
          ]}
        />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Advanced: the file itself, development upstreams

const KNOWN = [
  "owner",
  "dofs",
  "planner",
  "worker",
  "origins",
  "vm",
  "chat",
  "proxy",
  "console",
  "projects",
  "policy",
  "judge_notes",
  "dev",
];

function Advanced({ d }: { d: Draft }) {
  const text = JSON.stringify(d.draft, null, 2);
  const [value, setValue] = useState(text);
  const [bad, setBad] = useState<string>();
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setValue(text);
  }, [text]);
  const unknown = Object.keys(d.draft).filter((k) => !KNOWN.includes(k));
  const ups = Object.entries(d.draft.dev?.upstreams ?? {});
  const setUps = (rows: [string, string][]) =>
    d.set((x) => {
      if (rows.length) x.dev = { ...(x.dev ?? {}), upstreams: Object.fromEntries(rows) };
      else delete x.dev;
    });
  return (
    <>
      <SectionHead
        title="Advanced"
        description="The same settings as the file hortusd reads, ~/.hortus/hortusd.json. Edits here and in the forms are one draft; Save applies both."
      />
      <Card
        title="hortusd.json"
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon="arrowDown"
            onClick={() => {
              const a = document.createElement("a");
              a.href = URL.createObjectURL(new Blob([`${text}\n`], { type: "application/json" }));
              a.download = "hortusd.json";
              a.click();
              URL.revokeObjectURL(a.href);
            }}
          >
            Download
          </Button>
        }
      >
        <div className="flex flex-col gap-2 *:data-[slot=button]:self-start">
          <Textarea
            className="min-h-105 text-xs leading-relaxed whitespace-pre font-mono"
            aria-label="hortusd.json"
            spellCheck={false}
            rows={22}
            value={value}
            onFocus={() => {
              editing.current = true;
            }}
            onBlur={() => {
              editing.current = false;
              if (!bad) setValue(text);
            }}
            onChange={(e) => {
              setValue(e.target.value);
              try {
                const v = JSON.parse(e.target.value);
                if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("the file is one JSON object");
                setBad(undefined);
                d.set((x) => {
                  for (const k of Object.keys(x)) delete (x as Record<string, unknown>)[k];
                  Object.assign(x, v);
                });
              } catch (err) {
                setBad(errorText(err));
              }
            }}
          />
          {bad && (
            <p className="flex items-start gap-1.5 text-[13px] text-destructive">
              <Icon name="alert" size={14} /> Not valid JSON yet: {bad}
            </p>
          )}
          {unknown.length > 0 && (
            <Callout tone="warning" title="Keys hortusd does not know">
              {unknown.map((k) => (
                <code key={k}>{k} </code>
              ))}
              are kept as they are, but nothing reads them. A typo?
            </Callout>
          )}
          {Object.entries(d.errors).length > 0 && (
            <ul className="flex items-start gap-1.5 text-[13px] text-destructive flex flex-col gap-2 *:data-[slot=button]:self-start">
              {Object.entries(d.errors).map(([k, v]) => (
                <li key={k}>
                  <code>{k}</code>: {v}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      <Card
        title="Development upstreams"
        description="For tests: a host, and where the proxy really connects for it. hortusd refuses these unless HORTUS_HOME is set."
      >
        <KeyValues
          rows={ups}
          onChange={setUps}
          keyLabel="Host"
          valueLabel="Connect to"
          placeholder={["api.github.com", "127.0.0.1:9101"]}
        />
      </Card>
    </>
  );
}

function KeyValues({
  rows,
  onChange,
  keyLabel,
  valueLabel,
  placeholder,
}: {
  rows: [string, string][];
  onChange: (r: [string, string][]) => void;
  keyLabel: string;
  valueLabel: string;
  placeholder: [string, string];
}): ReactNode {
  const [k, setK] = useState("");
  const [v, setV] = useState("");
  return (
    <div className="flex flex-col gap-2 *:data-[slot=button]:self-start">
      {rows.map(([a, b], i) => (
        <div
          key={a}
          className="flex items-center gap-2 [&>input]:min-w-0 [&>input]:flex-1 [&>svg]:text-muted-foreground"
        >
          <Input className="font-mono" aria-label={keyLabel} value={a} readOnly />
          <Icon name="arrowRight" size={16} />
          <Input
            className="font-mono"
            aria-label={`${valueLabel} for ${a}`}
            value={b}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? [a, e.target.value] : r)))}
          />
          <IconButton
            label={`Remove ${a}`}
            icon="trash"
            size="sm"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          />
        </div>
      ))}
      <form
        className="flex items-center gap-2 [&>input]:min-w-0 [&>input]:flex-1 [&>svg]:text-muted-foreground"
        onSubmit={(e) => {
          e.preventDefault();
          if (!k.trim() || !v.trim() || rows.some(([a]) => a === k.trim())) return;
          onChange([...rows, [k.trim(), v.trim()]]);
          setK("");
          setV("");
        }}
      >
        <Input
          className="font-mono"
          aria-label={keyLabel}
          placeholder={placeholder[0]}
          value={k}
          onChange={(e) => setK(e.target.value)}
        />
        <Icon name="arrowRight" size={16} />
        <Input
          className="font-mono"
          aria-label={valueLabel}
          placeholder={placeholder[1]}
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
        <Button type="submit" size="sm" icon="plus" disabled={!k.trim() || !v.trim()}>
          Add
        </Button>
      </form>
    </div>
  );
}
