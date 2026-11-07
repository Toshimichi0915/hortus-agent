/**
 * Settings › Sources: the messengers and forges hortus mirrors (`dofs` in hortusd.json, their credentials in the
 * vault, their status from the gateway), and a guided way to add one without knowing either.
 */
import { useEffect, useState } from "react";
import { type Config, type Credential, type CredentialType, call, type Source, useCall } from "../api.ts";
import { DOF_NAME, DOF_NAME_HINT, type Draft } from "../schema.ts";
import {
  Button,
  Callout,
  Card,
  Choice,
  CopyButton,
  cn,
  confirmAction,
  Dialog,
  Empty,
  errorText,
  Icon,
  IconButton,
  ListInput,
  Pill,
  RelTime,
  SERVICES,
  SecretField,
  SectionHead,
  ServiceTile,
  Spinner,
  TextField,
  toast,
  useAction,
} from "../ui.tsx";

type DofConfig = Config["dofs"][string];

interface CredSpec {
  suffix: string;
  type: CredentialType;
  label: string;
  hint: string;
  placeholder?: string;
}

/** What each service needs, from the connectors and README › "What each service needs on its side". */
const SERVICE: Record<
  string,
  {
    blurb: string;
    owner: { label: string; hint: string; placeholder: string };
    members: string;
    creds: CredSpec[];
    setup: string[];
    forge?: boolean;
    selfHost?: boolean;
  }
> = {
  slack: {
    blurb: "Channels the bot is in, and your DMs with it.",
    owner: {
      label: "Your Slack member ID",
      hint: "In Slack: your profile › ⋯ › Copy member ID.",
      placeholder: "U0123ABCD",
    },
    members: "Everyone in the workspace",
    creds: [
      {
        suffix: "",
        type: "token",
        label: "Bot token",
        hint: "OAuth & Permissions › Bot User OAuth Token.",
        placeholder: "xoxb-…",
      },
      {
        suffix: "-app",
        type: "token",
        label: "App-level token",
        hint: "Basic Information › App-Level Tokens, with connections:write. hortusd keeps it to itself.",
        placeholder: "xapp-…",
      },
    ],
    setup: [
      "Create a Slack app at api.slack.com/apps and turn on Socket Mode.",
      "Bot token scopes: channels:history, channels:read, groups:history, groups:read, im:history, im:read, im:write, mpim:history, mpim:read, users:read, chat:write, reactions:read, files:read.",
      "Bot events: message.channels, message.groups, message.im, message.mpim, reaction_added, reaction_removed, member_joined_channel, member_left_channel, channel_rename, channel_created, channel_archive, channel_unarchive, group_rename, group_archive, group_unarchive.",
      "Install the app to the workspace, then invite the bot to each channel to mirror.",
    ],
  },
  discord: {
    blurb: "The servers and channels the bot can see.",
    owner: {
      label: "Your Discord user ID",
      hint: "Turn on Settings › Advanced › Developer Mode, then right-click your name › Copy User ID.",
      placeholder: "402938475610293847",
    },
    members: "People in servers you are in yourself",
    creds: [
      { suffix: "", type: "token", label: "Bot token", hint: "Developer Portal › your app › Bot › Reset Token." },
    ],
    setup: [
      "Create an application at discord.com/developers and add a bot.",
      "Under Bot › Privileged Gateway Intents, turn on Server Members and Message Content. Without them the gateway closes with 4014.",
      "Invite the bot with View Channels, Read Message History and Send Messages (and Send Messages in Threads).",
    ],
  },
  telegram: {
    blurb: "Your chats with the bot, and the groups it is in.",
    owner: {
      label: "Your Telegram user ID",
      hint: "A number: message @userinfobot to see yours.",
      placeholder: "51234987",
    },
    members: "People in chats you are in yourself",
    creds: [
      {
        suffix: "",
        type: "token",
        label: "Bot token",
        hint: "@BotFather gives it when you create the bot.",
        placeholder: "123456789:AA…",
      },
    ],
    setup: [
      "Message @BotFather, send /newbot and follow its questions.",
      "Send /setprivacy and choose Disable, or in groups the bot hears only commands and replies to it.",
      "Don't set a webhook on the bot: hortus reads it with getUpdates, and the two exclude each other.",
    ],
  },
  github: {
    blurb: "Issues, pull requests, reviews and CI of your repositories.",
    owner: { label: "Your GitHub login", hint: "The name in your profile's URL.", placeholder: "your-login" },
    members: "Collaborators on the repositories",
    forge: true,
    selfHost: true,
    creds: [
      {
        suffix: "",
        type: "github-app",
        label: "GitHub App",
        hint: "The App's ID, the installation's ID (the number at the end of its settings URL) and a private key.",
      },
      {
        suffix: "-webhook",
        type: "webhook-secret",
        label: "Webhook secret",
        hint: "The secret you set on the App's webhook.",
      },
    ],
    setup: [
      "Create a GitHub App (Settings › Developer settings › GitHub Apps) and install it on the repositories.",
      "Permissions: contents, issues and pull requests: write; checks and actions: read. Administration: write only if tasks create repositories.",
      "Events: Issues, Issue comment, Pull request, Pull request review, Pull request review comment, Check suite, Push, Repository.",
      "Set a webhook secret, and generate a private key: you enter both in a moment. The webhook URL is shown once the source is added.",
    ],
  },
  gitlab: {
    blurb: "Issues, merge requests, comments and pipelines.",
    owner: { label: "Your GitLab username", hint: "The name after @ on your profile.", placeholder: "your-login" },
    members: "Members of the projects",
    forge: true,
    selfHost: true,
    creds: [
      {
        suffix: "",
        type: "token",
        label: "Access token",
        hint: "A project or group access token with the api scope and the Developer role.",
        placeholder: "glpat-…",
      },
      {
        suffix: "-webhook",
        type: "webhook-secret",
        label: "Webhook secret",
        hint: "What you put in the webhook's “Secret token” field.",
      },
    ],
    setup: [
      "Create a project or group access token: scope api, role Developer.",
      "Add a project or group webhook with a secret token (not a signing-token-only hook). Its URL is shown once the source is added.",
      "Webhook events: issues, comments (notes), merge requests, pipelines, push.",
    ],
  },
  bitbucket: {
    blurb: "Issues, pull requests, pushes and build statuses.",
    owner: {
      label: "Your Bitbucket username",
      hint: "Personal settings › Account settings.",
      placeholder: "your-login",
    },
    members: "Members of the workspace",
    forge: true,
    creds: [
      {
        suffix: "",
        type: "token",
        label: "Access token",
        hint: "A workspace access token if you list repositories with * or trust members; a repository token works for exact names.",
      },
      { suffix: "-webhook", type: "webhook-secret", label: "Webhook secret", hint: "The webhook's Secret." },
    ],
    setup: [
      "Create an access token with repository:write, pullrequest:write, issue:write and webhook.",
      "Add a webhook with a secret. Its URL is shown once the source is added.",
      "Webhook events: issue, pull request, push, commit status.",
    ],
  },
};

/** A connector type this page does not describe: edited by its common keys. */
const GENERIC = {
  blurb: "",
  owner: { label: "Your user ID", hint: "Your user ID on the service.", placeholder: "" },
  members: "Members",
  creds: [] as CredSpec[],
  setup: [] as string[],
  forge: false,
  selfHost: false,
};

type Trust = "owner" | "members" | "anyone" | "people";
const trustOf = (t: DofConfig["trust"]): Trust => (Array.isArray(t) ? "people" : (t ?? "owner"));

function trustText(t: DofConfig["trust"]): string {
  if (Array.isArray(t)) return `you and ${t.length} other ${t.length === 1 ? "person" : "people"} trusted`;
  return { members: "members trusted", anyone: "everyone trusted", owner: "only you trusted" }[t ?? "owner"];
}

// ---------------------------------------------------------------------------------------------------------------------
// A source's card

function Webhook({ dof, path }: { dof: string; path: string }) {
  const url = `https://<your tunnel>${path}`;
  const cmd = "cloudflared tunnel --url http://127.0.0.1:7701";
  return (
    <div className="rounded-lg border border-dashed px-3.5 py-3 flex flex-col gap-2 *:data-[slot=button]:self-start">
      <p className="text-sm font-medium">Webhook</p>
      <p className="text-muted-foreground text-[13px]">
        Give the service this URL, through a tunnel to this machine (hortus installs none). The secret is the{" "}
        <code>{dof}-webhook</code> credential.
      </p>
      <div className="mt-1 flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/50 py-0.5 pr-0.5 pl-3 [&_code]:min-w-0 [&_code]:flex-1 [&_code]:overflow-x-auto [&_code]:text-xs [&_code]:whitespace-nowrap">
        <code>{url}</code>
        <CopyButton text={url} />
      </div>
      <div className="mt-1 flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/50 py-0.5 pr-0.5 pl-3 [&_code]:min-w-0 [&_code]:flex-1 [&_code]:overflow-x-auto [&_code]:text-xs [&_code]:whitespace-nowrap">
        <code>{cmd}</code>
        <CopyButton text={cmd} />
      </div>
    </div>
  );
}

function SourceCard({
  s,
  cfg,
  notify,
  onEdit,
  onRemove,
}: {
  s: Source;
  cfg: DofConfig | undefined;
  notify: boolean;
  onEdit: (step?: "creds") => void;
  onRemove: () => void;
}) {
  const [resync] = useAction((scope?: string) => call("source.resync", { dof: s.dof, ...(scope ? { scope } : {}) }));
  const label = SERVICES[s.type]?.label ?? s.type;
  return (
    <Card className="">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3">
        <ServiceTile type={s.type} size={40} />
        <div className="min-w-44 flex-1 [&_h3]:flex [&_h3]:flex-wrap [&_h3]:items-center [&_h3]:gap-2 [&_h3]:text-base [&_h3]:font-semibold [&_p]:mt-0.5">
          <h3>
            {s.dof}
            {notify && (
              <Pill tone="accent" title="hortus DMs you here">
                <Icon name="bell" size={12} /> notifies you
              </Pill>
            )}
          </h3>
          <p className="text-muted-foreground text-[13px]">
            {label}
            {cfg?.owner && (
              <>
                {" "}
                · you are <code>{cfg.owner}</code>
              </>
            )}{" "}
            · {trustText(cfg?.trust)}
          </p>
        </div>
        {s.connected ? (
          <Pill tone="ok" dot>
            Connected
          </Pill>
        ) : (
          <Pill tone={s.missing?.length || s.error ? "danger" : "neutral"} dot>
            {s.missing?.length ? "Needs credentials" : "Not connected"}
          </Pill>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon="edit" onClick={() => onEdit()}>
            Edit
          </Button>
          <IconButton label={`Remove ${s.dof}`} icon="trash" size="sm" onClick={onRemove} />
        </div>
      </div>
      {s.missing?.length ? (
        <Callout
          tone="warning"
          title="Missing credentials"
          action={
            <Button size="sm" variant="primary" onClick={() => onEdit("creds")}>
              Add them
            </Button>
          }
        >
          The connector cannot start without {s.missing.map((m) => `“${m}”`).join(" and ")}.
        </Callout>
      ) : (
        s.error && <Callout tone="danger">{s.error}</Callout>
      )}
      {s.delivery_warning && (
        <Callout tone="warning" title="Webhook deliveries go missing">
          {s.delivery_warning}
        </Callout>
      )}
      {s.notes?.map((n) => (
        <p key={n} className="text-muted-foreground text-[13px] flex flex-wrap items-center gap-2">
          <Icon name="info" size={14} /> {n}
        </p>
      ))}
      <div className="flex flex-wrap gap-x-4.5 gap-y-1 text-[13px] text-muted-foreground">
        <span>
          Last message <RelTime iso={s.lastEvent} empty="none yet" />
        </span>
        {s.size && <span>Mirror {s.size}</span>}
        {s.installation && <span>{s.installation}</span>}
        {s.deliveries_today !== undefined && (
          <span>
            {s.deliveries_today} webhook deliveries today, the last <RelTime iso={s.last_delivery} empty="never" />
          </span>
        )}
        {s.last_redelivery && (
          <span>
            Redelivery check <RelTime iso={s.last_redelivery} />
          </span>
        )}
      </div>
      {s.webhook && <Webhook dof={s.dof} path={s.webhook} />}
      {s.scopes.length > 0 && (
        <details className="[&>summary]:cursor-pointer [&>summary]:text-[13px] [&>summary]:font-medium [&>summary]:text-foreground/80 [&[open]>summary]:mb-2 [&>pre]:max-h-72 [&>pre]:overflow-auto [&>pre]:rounded-md [&>pre]:border [&>pre]:bg-muted/50 [&>pre]:p-2.5 [&>pre]:text-xs [&>pre]:wrap-anywhere [&>pre]:whitespace-pre-wrap">
          <summary>
            {s.scopes.length} {SERVICE[s.type]?.forge ? "repositories" : "conversations"} mirrored
          </summary>
          <ul className="divide-y [&_code]:flex-1 [&_li]:flex [&_li]:items-center [&_li]:gap-2.5 [&_li]:py-1.5">
            {s.scopes.map((sc) => (
              <li key={sc.scope}>
                <code>{sc.scope}</code>
                <span className="text-muted-foreground text-[13px]">
                  synced <RelTime iso={sc.last_sync} empty="live only" />
                </span>
                <Button size="sm" variant="ghost" icon="refresh" onClick={() => resync(sc.scope)}>
                  Resync
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Add or edit

type Step = "service" | "setup" | "details" | "creds";

function SourceDialog({
  open,
  onClose,
  d,
  editing,
  startAt,
  creds,
}: {
  open: boolean;
  onClose: () => void;
  d: Draft;
  /** the source's name when editing */
  editing: string | null;
  startAt?: Step | undefined;
  creds: Credential[];
}) {
  const existing = editing ? d.saved.dofs[editing] : undefined;
  const [step, setStep] = useState<Step>("service");
  const [type, setType] = useState("slack");
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [trust, setTrust] = useState<Trust>("owner");
  const [people, setPeople] = useState<string[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [host, setHost] = useState("");
  const [api, setApi] = useState("");
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [replace, setReplace] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!open) return;
    const e = editing ? d.saved.dofs[editing] : undefined;
    setStep(startAt ?? (e ? "details" : "service"));
    setType(e?.type ?? "slack");
    setName(editing ?? "");
    setOwner(e?.owner ?? "");
    setTrust(trustOf(e?.trust));
    setPeople(Array.isArray(e?.trust) ? e.trust : []);
    setRepos(e?.repos ?? []);
    setHost(e?.host ?? "");
    setApi(e?.api ?? "");
    setValues({});
    setReplace({});
  }, [open, editing, startAt, d.saved.dofs]);
  const info = SERVICE[type] ?? GENERIC;
  const svc = SERVICES[type] ?? { label: type, color: "", kind: "messenger" as const };
  const nameError = !name
    ? undefined
    : !DOF_NAME.test(name)
      ? DOF_NAME_HINT
      : !editing && name in d.saved.dofs
        ? "there is a source by this name"
        : undefined;
  const steps: Step[] = editing ? ["details", "creds"] : ["service", "setup", "details", "creds"];
  const at = steps.indexOf(step);
  const credName = (c: CredSpec) => `${name}${c.suffix}`;
  const has = (c: CredSpec) => creds.some((x) => x.name === credName(c));
  const FIELDS: Record<CredentialType, string[]> = {
    token: ["value"],
    "webhook-secret": ["value"],
    "github-app": ["appId", "installationId", "privateKey"],
    aws: ["keyId", "secret"],
  };
  const filled = (c: CredSpec) => FIELDS[c.type].every((f) => values[credName(c)]?.[f]?.trim());
  const detailsOk = !!name && !nameError && !!owner.trim() && (!info.forge || repos.length > 0);
  const [save, saving] = useAction(async () => {
    const entry: DofConfig = {
      ...(existing ?? {}),
      type,
      owner: owner.trim(),
      ...(info.forge ? { repos } : {}),
    };
    if (trust === "owner") delete entry.trust;
    else entry.trust = trust === "people" ? people : trust;
    for (const [k, v] of [
      ["host", host],
      ["api", api],
    ] as const)
      if (v.trim()) entry[k] = v.trim();
      else delete entry[k];
    if (
      !(await d.commit((c) => {
        c.dofs[name] = entry;
      }))
    )
      return undefined;
    // the values leave state now, whatever the vault answers: a retry types them again
    const typed = info.creds.filter(filled).map((c) => ({ c, v: values[credName(c)] ?? {} }));
    setValues({});
    setReplace({});
    onClose();
    const stored: string[] = [];
    for (const { c, v } of typed) {
      try {
        await call("credential.set", {
          name: credName(c),
          type: c.type,
          transform: type,
          ...Object.fromEntries(
            FIELDS[c.type].map((f) => [f, f === "appId" || f === "installationId" ? Number(v[f]) : v[f]]),
          ),
        });
        stored.push(c.label);
      } catch (e) {
        // the error is the vault's (zod paths and rules, never the value); the source itself is saved
        const left = typed.filter((x) => !stored.includes(x.c.label)).map((x) => x.c.label.toLowerCase());
        toast(
          `${editing ? `Saved ${name}` : `Added ${name}`} without its ${left.join(" and ")}: ${errorText(e)}. Add ${
            left.length === 1 ? "it" : "them"
          } from its card.`,
          "error",
        );
        return undefined;
      }
    }
    const missing = info.creds.filter((c) => !has(c) && !filled(c));
    if (missing.length)
      toast(
        `Saved. ${name} starts once its ${missing.map((c) => c.label.toLowerCase()).join(" and ")} are in.`,
        "info",
      );
    return { message: editing ? `Saved ${name}` : `Added ${name}: it connects and backfills in the background` };
  });
  const next = () => setStep(steps[at + 1] ?? step);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={editing ? `Edit ${editing}` : step === "service" ? "Add a source" : `Add ${svc.label}`}
      description={
        <span className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-xs">
          {steps.map((s, i) => (
            <span
              key={s}
              className={cn(
                "text-muted-foreground",
                i < at && "text-foreground/80",
                i === at && "font-semibold text-brand-text",
              )}
            >
              {i + 1}. {{ service: "Service", setup: `On ${svc.label}`, details: "About you", creds: "Credentials" }[s]}
            </span>
          ))}
        </span>
      }
      footer={
        <>
          {at > 0 && (
            <Button icon="arrowLeft" onClick={() => setStep(steps[at - 1] ?? step)}>
              Back
            </Button>
          )}
          <span className="grow" />
          {step === "creds" ? (
            <Button variant="primary" loading={saving} disabled={!detailsOk} onClick={() => save()}>
              {editing ? "Save" : "Add source"}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={step === "details" && !detailsOk}
              onClick={() => {
                if (step === "service" && !name) setName(type in d.saved.dofs ? `${type}-2` : type);
                next();
              }}
            >
              Next <Icon name="arrowRight" size={16} />
            </Button>
          )}
        </>
      }
    >
      {step === "service" && (
        <Choice
          cards
          value={type}
          onChange={(v) => {
            setType(v);
            setName("");
          }}
          options={Object.entries(SERVICE).map(([value, s]) => ({
            value,
            label: (
              <span className="flex flex-wrap items-center gap-2">
                <ServiceTile type={value} size={22} /> {SERVICES[value]?.label}
              </span>
            ),
            hint: s.blurb,
          }))}
        />
      )}
      {step === "setup" && (
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          <p>
            hortus connects as a bot or app you create on {svc.label}. Do this there first; the next steps ask for what
            it gives you.
          </p>
          <ol className="flex list-decimal flex-col gap-2.5 pl-5 leading-relaxed marker:font-semibold marker:text-brand">
            {info.setup.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ol>
        </div>
      )}
      {step === "details" && (
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          {!editing && (
            <TextField
              label="Name"
              hint="How hortus refers to this source: its mirror's folder, and the prefix of its credentials."
              value={name}
              onChange={setName}
              mono
              error={nameError}
            />
          )}
          <TextField
            label={info.owner.label}
            hint={`${info.owner.hint} Your own messages are the ones hortus trusts.`}
            value={owner}
            onChange={setOwner}
            mono
            placeholder={info.owner.placeholder}
            autoFocus={!!editing}
          />
          <Choice
            label="Whose messages are trusted"
            hint="Trusted text can direct a task. Anyone else's is read as data, and their tasks always ask you, never the judge."
            cards
            value={trust}
            onChange={setTrust}
            options={[
              { value: "owner", label: "Only mine", hint: "The safe default." },
              { value: "members", label: "Mine and members'", hint: info.members },
              { value: "people", label: "Mine and these people's", hint: "By their user IDs." },
              { value: "anyone", label: "Anyone's", hint: "Only for a space that is yours alone." },
            ]}
          />
          {trust === "people" && (
            <ListInput
              label="Trusted user IDs"
              values={people}
              onChange={setPeople}
              placeholder={info.owner.placeholder}
            />
          )}
          {info.forge && (
            <ListInput
              label="Repositories"
              hint="owner/name, or owner/* for all of an owner's."
              values={repos}
              onChange={setRepos}
              placeholder="you/your-repo"
              check={(v) => (/^[\w.-]+\/[\w.*-]+$/.test(v) ? undefined : "owner/name, like you/your-repo")}
            />
          )}
          {info.selfHost && (
            <details
              className="[&>summary]:cursor-pointer [&>summary]:text-[13px] [&>summary]:font-medium [&>summary]:text-foreground/80 [&[open]>summary]:mb-2 [&>pre]:max-h-72 [&>pre]:overflow-auto [&>pre]:rounded-md [&>pre]:border [&>pre]:bg-muted/50 [&>pre]:p-2.5 [&>pre]:text-xs [&>pre]:wrap-anywhere [&>pre]:whitespace-pre-wrap"
              open={!!(host || api)}
            >
              <summary>Self-hosted {svc.label}</summary>
              <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
                <TextField
                  label="Host"
                  optional
                  hint={`Empty: ${type}.com.`}
                  value={host}
                  onChange={setHost}
                  mono
                  placeholder={`${type}.example.com`}
                />
                <TextField
                  label="API address"
                  optional
                  hint="Empty: worked out from the host."
                  value={api}
                  onChange={setApi}
                  mono
                  placeholder={type === "gitlab" ? "gitlab.example.com/api/v4" : "github.example.com/api/v3"}
                />
              </div>
            </details>
          )}
        </div>
      )}
      {step === "creds" && (
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          <p className="text-muted-foreground">
            Stored in hortusd's vault, write-only. Leave one empty to add it later: the source starts once it is in.
          </p>
          {info.creds.map((c) => {
            const n = credName(c);
            const v = values[n] ?? {};
            const set = (f: string) => (x: string) => setValues({ ...values, [n]: { ...v, [f]: x } });
            return (
              <fieldset
                key={c.suffix}
                className="m-0 flex flex-col gap-2.5 rounded-lg border px-3.5 pt-3 pb-3.5 [&_legend]:px-1.5 [&_legend]:text-sm [&_legend]:font-semibold"
              >
                <legend>
                  {c.label} <code>{n}</code>
                </legend>
                <p className="text-muted-foreground text-[13px]">{c.hint}</p>
                {has(c) && !replace[n] ? (
                  <p className="flex flex-wrap items-center gap-2">
                    <Pill tone="ok">
                      <Icon name="check" size={13} /> saved
                    </Pill>
                    <button
                      type="button"
                      className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-brand-text hover:underline"
                      onClick={() => setReplace({ ...replace, [n]: true })}
                    >
                      Replace it
                    </button>
                  </p>
                ) : c.type === "github-app" ? (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <TextField
                        label="App ID"
                        value={v.appId ?? ""}
                        onChange={set("appId")}
                        mono
                        placeholder="1234567"
                      />
                      <TextField
                        label="Installation ID"
                        value={v.installationId ?? ""}
                        onChange={set("installationId")}
                        mono
                        placeholder="89012345"
                      />
                    </div>
                    <SecretField
                      label="Private key"
                      value={v.privateKey ?? ""}
                      onChange={set("privateKey")}
                      multiline
                      placeholder="-----BEGIN RSA PRIVATE KEY-----"
                    />
                  </>
                ) : (
                  <SecretField
                    label={c.label}
                    value={v.value ?? ""}
                    onChange={set("value")}
                    placeholder={c.placeholder}
                  />
                )}
              </fieldset>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

export function Sources({ d }: { d: Draft }) {
  const list = useCall<Source[]>("source.list", {}, ["settings"]);
  const creds = useCall<Credential[]>("credential.list", {}, ["settings"]);
  const [dialog, setDialog] = useState<{ editing: string | null; startAt?: Step } | null>(null);
  const remove = async (name: string) => {
    const notify = d.saved.owner.notify === name;
    if (
      !(await confirmAction({
        title: `Remove ${name}?`,
        body: (
          <>
            hortus stops mirroring it, and its messages no longer reach the Planner. The mirror stays on disk; its
            credentials stay in Credentials.
            {notify && " hortus notifies you there: that stops too."}
          </>
        ),
        confirm: "Remove",
        danger: true,
      }))
    )
      return;
    if (
      await d.commit((c) => {
        delete c.dofs[name];
        if (c.owner.notify === name) delete c.owner.notify;
      })
    )
      toast(`Removed ${name}`);
  };
  return (
    <>
      <SectionHead
        title="Sources"
        description="The messengers and forges hortus mirrors. What arrives can wake the Planner, and tasks can search it."
        action={
          <Button variant="primary" icon="plus" onClick={() => setDialog({ editing: null })}>
            Add a source
          </Button>
        }
      />
      {!list.data ? (
        <Spinner />
      ) : list.data.length ? (
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          {list.data.map((s) => (
            <SourceCard
              key={s.dof}
              s={s}
              cfg={d.saved.dofs[s.dof]}
              notify={d.saved.owner.notify === s.dof}
              onEdit={(startAt) => setDialog({ editing: s.dof, startAt })}
              onRemove={() => remove(s.dof)}
            />
          ))}
        </div>
      ) : (
        <Card>
          <Empty
            icon="plug"
            title="No sources yet"
            action={
              <Button variant="primary" icon="plus" onClick={() => setDialog({ editing: null })}>
                Add a source
              </Button>
            }
          >
            Connect Slack, Discord or Telegram to talk to hortus there, and GitHub, GitLab or Bitbucket for issues and
            pull requests.
          </Empty>
        </Card>
      )}
      <SourceDialog
        open={!!dialog}
        onClose={() => setDialog(null)}
        d={d}
        editing={dialog?.editing ?? null}
        startAt={dialog?.startAt}
        creds={creds.data ?? []}
      />
    </>
  );
}
