/** Settings › Credentials: the vault's entries (write-only), the add/replace dialog, and stored website logins. */
import { useEffect, useState } from "react";
import { type Captured, type Credential, type CredentialType, call, useCall } from "../api.ts";
import { CREDENTIAL_NAME, CREDENTIAL_NAME_HINT, checkHost, type Draft } from "../schema.ts";
import {
  Button,
  Card,
  Choice,
  confirmAction,
  Dialog,
  Empty,
  Icon,
  IconButton,
  ListInput,
  Pill,
  RelTime,
  SecretField,
  SectionHead,
  SelectField,
  Spinner,
  Switch,
  Tabs,
  TextField,
  useAction,
  useLocation,
} from "../ui.tsx";

/**
 * The shipped transforms and the hosts their manifests send credentials to.
 * ponytail: a copy of transforms/<name>/manifest.json; read `transforms.list` when Workers' own transforms should show
 */
export const TRANSFORMS: Record<string, { label: string; hosts: string[]; provider?: boolean }> = {
  anthropic: { label: "Anthropic", hosts: ["api.anthropic.com"], provider: true },
  openai: { label: "OpenAI-compatible API", hosts: ["api.openai.com"], provider: true },
  openrouter: { label: "OpenRouter", hosts: ["openrouter.ai"], provider: true },
  slack: { label: "Slack", hosts: ["slack.com", "files.slack.com"] },
  discord: { label: "Discord", hosts: ["discord.com", "gateway.discord.gg"] },
  telegram: { label: "Telegram", hosts: ["api.telegram.org"] },
  github: { label: "GitHub", hosts: ["api.github.com", "github.com", "uploads.github.com"] },
  gitlab: { label: "GitLab", hosts: ["gitlab.com"] },
  bitbucket: { label: "Bitbucket", hosts: ["api.bitbucket.org", "bitbucket.org"] },
  aws: { label: "AWS", hosts: ["sts.amazonaws.com", "iam.amazonaws.com", "s3.amazonaws.com"] },
  cookie: { label: "Website cookies", hosts: [] },
};

const KINDS: { value: CredentialType; label: string; hint: string }[] = [
  { value: "token", label: "API key or token", hint: "One secret string" },
  { value: "github-app", label: "GitHub App", hint: "App ID, installation ID and a private key" },
  { value: "webhook-secret", label: "Webhook secret", hint: "Checks deliveries; hortusd keeps it to itself" },
  { value: "aws", label: "AWS keys", hint: "An access key ID and its secret" },
];

export const kindLabel = (t: string) => KINDS.find((k) => k.value === t)?.label ?? t;

/** hortusd's own: never offered to a session (webhook secrets, Slack's Socket Mode token). */
export const coreOnly = (c: Pick<Credential, "name" | "type">) =>
  c.type === "webhook-secret" || c.name.endsWith("-app");

export interface Preset {
  name?: string;
  type?: CredentialType;
  transform?: string;
  /** a model provider: the dialog asks which one first */
  provider?: boolean;
  /** replace the value of an existing entry */
  replace?: boolean;
}

export function CredentialDialog({
  open,
  onClose,
  preset = {},
  existing,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  preset?: Preset;
  existing: string[];
  onSaved?: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<CredentialType>("token");
  const [transform, setTransform] = useState("");
  const [hosts, setHosts] = useState<string[]>([]);
  const [v, setV] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setName(preset.name ?? (preset.provider ? "anthropic" : ""));
    setType(preset.type ?? "token");
    setTransform(preset.transform ?? (preset.provider ? "anthropic" : ""));
    setHosts([]);
    setV({});
  }, [open, preset.name, preset.type, preset.transform, preset.provider]);
  const nameError =
    name && !CREDENTIAL_NAME.test(name)
      ? CREDENTIAL_NAME_HINT
      : name.startsWith("c-")
        ? "c- is kept for captured logins"
        : !preset.replace && existing.includes(name)
          ? "there is one by this name: saving replaces its value"
          : undefined;
  const fields: Record<CredentialType, string[]> = {
    token: ["value"],
    "webhook-secret": ["value"],
    "github-app": ["appId", "installationId", "privateKey"],
    aws: ["keyId", "secret"],
  };
  const complete = fields[type].every((f) => v[f]?.trim());
  const [save, busy] = useAction(async () => {
    const body: Record<string, unknown> = {
      name,
      type,
      ...(transform ? { transform } : {}),
      ...(hosts.length ? { hosts } : {}),
    };
    for (const f of fields[type]) body[f] = f === "appId" || f === "installationId" ? Number(v[f]) : v[f];
    await call("credential.set", body);
    setV({}); // write-only: the values leave the page once the vault has them
    onSaved?.(name);
    onClose();
    return { message: `Saved ${name}` };
  });
  const set = (k: string) => (x: string) => setV({ ...v, [k]: x });
  const t = TRANSFORMS[transform];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={preset.replace ? `Replace ${name}` : preset.provider ? "Add a model provider" : "Add a credential"}
      description="Values are write-only: hortus never shows them again, not even to you."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name || (!!nameError && !nameError.startsWith("there is")) || !complete}
            onClick={() => save()}
          >
            {preset.replace ? "Replace value" : "Save"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4 *:data-[slot=button]:self-start"
        onSubmit={(e) => {
          e.preventDefault();
          if (complete) save();
        }}
      >
        {preset.provider && (
          <Choice
            label="Which provider?"
            cards
            value={transform}
            onChange={(x) => {
              setTransform(x);
              if (!name || Object.keys(TRANSFORMS).includes(name)) setName(x);
            }}
            options={Object.entries(TRANSFORMS)
              .filter(([, x]) => x.provider)
              .map(([value, x]) => ({ value, label: x.label, hint: x.hosts.join(", ") }))}
          />
        )}
        {!preset.replace && (
          <TextField
            label="Name"
            hint="How settings refer to it: a source's credential carries the source's name (slack, slack-app, github-webhook)."
            value={name}
            onChange={(x) => setName(x.toLowerCase())}
            mono
            error={nameError && !nameError.startsWith("there is") ? nameError : undefined}
            autoFocus
          />
        )}
        {nameError?.startsWith("there is") && <p className="text-muted-foreground text-[13px]">{nameError}.</p>}
        {!preset.replace && !preset.provider && (
          <>
            <Choice label="Kind" value={type} onChange={setType} options={KINDS} />
            <SelectField
              label="Used with"
              hint="The transform that puts it into requests, and knows which hosts it belongs to."
              value={transform}
              onChange={setTransform}
              options={[
                { value: "", label: "Choose…" },
                ...Object.entries(TRANSFORMS).map(([value, x]) => ({ value, label: x.label })),
              ]}
            />
          </>
        )}
        {!preset.replace &&
          (preset.provider ? (
            <details className="[&>summary]:cursor-pointer [&>summary]:text-[13px] [&>summary]:font-medium [&>summary]:text-foreground/80 [&[open]>summary]:mb-2 [&>pre]:max-h-72 [&>pre]:overflow-auto [&>pre]:rounded-md [&>pre]:border [&>pre]:bg-muted/50 [&>pre]:p-2.5 [&>pre]:text-xs [&>pre]:wrap-anywhere [&>pre]:whitespace-pre-wrap">
              <summary>Another endpoint (self-hosted, a proxy)</summary>
              <ListInput
                label="Only send it to"
                optional
                hint={
                  t?.hosts.length
                    ? `Empty: the transform's own hosts (${t.hosts.join(", ")}). For another endpoint, like a self-hosted server, list it.`
                    : "Empty: the transform's own hosts."
                }
                values={hosts}
                onChange={setHosts}
                check={checkHost}
                placeholder="api.example.com"
              />
            </details>
          ) : (
            <ListInput
              label="Only send it to"
              optional
              hint={
                t?.hosts.length
                  ? `Empty: the transform's own hosts (${t.hosts.join(", ")}). For another endpoint, like a self-hosted server, list it.`
                  : "Empty: the transform's own hosts."
              }
              values={hosts}
              onChange={setHosts}
              check={checkHost}
              placeholder="api.example.com"
            />
          ))}
        {type === "token" || type === "webhook-secret" ? (
          <SecretField
            label={type === "token" ? "Token" : "Secret"}
            value={v.value ?? ""}
            onChange={set("value")}
            placeholder={transform === "slack" ? "xoxb-… or xapp-…" : "Paste it here"}
          />
        ) : type === "github-app" ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="App ID" value={v.appId ?? ""} onChange={set("appId")} mono placeholder="1234567" />
              <TextField
                label="Installation ID"
                hint="The number at the end of the installation's settings URL."
                value={v.installationId ?? ""}
                onChange={set("installationId")}
                mono
                placeholder="89012345"
              />
            </div>
            <SecretField
              label="Private key"
              hint="The .pem file GitHub gave you when you generated a key."
              value={v.privateKey ?? ""}
              onChange={set("privateKey")}
              multiline
              placeholder="-----BEGIN RSA PRIVATE KEY-----"
            />
          </>
        ) : (
          <>
            <SecretField label="Access key ID" value={v.keyId ?? ""} onChange={set("keyId")} placeholder="AKIA…" />
            <SecretField label="Secret access key" value={v.secret ?? ""} onChange={set("secret")} />
          </>
        )}
      </form>
    </Dialog>
  );
}

function SiteLogins() {
  const sites = useCall<Captured[]>("captured.list", {}, ["settings"]);
  const [all, setAll] = useState(false);
  const [forget] = useAction((origin: string) => call("captured.forget", { origin }), "Forgotten");
  const [reset] = useAction(() => call("captured.reset", {}), "Every site forgotten");
  const shown = sites.data?.filter((s) => all || s.login);
  return (
    <Card
      title="Website logins"
      description="Cookies and tokens sites set: when you signed in through the login view, and what Workers picked up browsing. Forgetting a site signs every task out of it."
      actions={
        <Button
          size="sm"
          variant="quiet-danger"
          disabled={!sites.data?.length}
          onClick={async () => {
            if (
              await confirmAction({
                title: "Forget every site?",
                body: `All ${sites.data?.length ?? 0} sites' cookies and tokens go, and every task is signed out. The next one that needs a site asks you to sign in again.`,
                confirm: "Forget all",
                danger: true,
              })
            )
              reset();
          }}
        >
          Reset all
        </Button>
      }
    >
      <Switch
        checked={all}
        onChange={setAll}
        label="Show every site"
        hint="Off: only sites that may hold a login. On: also the cookies Workers got browsing anonymously (ad networks, visitor sessions)."
      />
      {!shown ? (
        <Spinner />
      ) : shown.length ? (
        <ul className="divide-y">
          {shown.map((s) => (
            <li
              key={s.origin}
              className="flex items-center gap-3 px-1 py-3 first:pt-1 last:pb-1 [&>svg]:text-muted-foreground"
            >
              <Icon name="globe" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {s.origin}
                  {all && !s.login && <Pill title="Only what a Worker got browsing anonymously">anonymous</Pill>}
                </p>
                <p className="text-muted-foreground text-[13px]">
                  {s.cookies} cookies{s.tokens ? `, ${s.tokens} token${s.tokens === 1 ? "" : "s"}` : ""} · last used{" "}
                  <RelTime iso={s.last_use} empty="never" />
                </p>
              </div>
              <Button
                size="sm"
                variant="quiet-danger"
                onClick={async () => {
                  if (
                    await confirmAction({
                      title: `Forget ${s.origin}?`,
                      body: "Every task is signed out of it. The next one that needs it asks you to sign in again.",
                      confirm: "Forget",
                      danger: true,
                    })
                  )
                    forget(s.origin);
                }}
              >
                Forget
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">
          {sites.data?.length
            ? `No site holds a login. ${sites.data.length} only have cookies from anonymous browsing: show every site to see them.`
            : "None yet. When a task needs to sign in to a site, you do it in a live view and it shows up here."}
        </p>
      )}
    </Card>
  );
}

export function Credentials({ d }: { d: Draft }) {
  const list = useCall<Credential[]>("credential.list", {}, ["settings"]);
  const { query } = useLocation();
  const [dialog, setDialog] = useState<Preset | null>(query.get("add") === "provider" ? { provider: true } : null);
  const [tab, setTab] = useState<"vault" | "sites">(query.get("tab") === "sites" ? "sites" : "vault");
  const [remove] = useAction((name: string) => call("credential.delete", { name }), "Deleted");
  const c = d.saved;
  const usedBy = (name: string) =>
    [
      c.planner.provider === name && "Planner",
      c.worker.provider === name && "Workers",
      Object.keys(c.dofs).some((s) => name === s || name.startsWith(`${s}-`)) && "a source",
    ].filter(Boolean) as string[];
  return (
    <>
      <SectionHead
        title="Credentials"
        description="API keys and tokens live only in hortusd's vault. Workers see placeholders; the proxy puts the real value in only where its transform says it goes, and only after the Approval Gate."
        action={
          tab === "vault" && (
            <div className="flex flex-wrap items-center gap-2">
              <Button icon="sparkle" onClick={() => setDialog({ provider: true })}>
                Add a model provider
              </Button>
              <Button variant="primary" icon="plus" onClick={() => setDialog({})}>
                Add a credential
              </Button>
            </div>
          )
        }
      />
      <Tabs
        label="Credentials"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "vault", label: "Credentials", count: list.data?.length },
          { value: "sites", label: "Website logins" },
        ]}
      />
      {tab === "sites" && <SiteLogins />}
      {tab === "vault" && (
        <Card flush>
          {!list.data ? (
            <div className="px-5 py-4">
              <Spinner />
            </div>
          ) : list.data.length ? (
            <ul className="divide-y px-4 py-1">
              {list.data.map((x) => {
                const users = usedBy(x.name);
                return (
                  <li
                    key={x.name}
                    className="flex items-center gap-3 px-1 py-3 first:pt-1 last:pb-1 [&>svg]:text-muted-foreground"
                  >
                    <Icon name="key" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium [&_code]:rounded-md [&_code]:border [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:text-xs">
                        <code>{x.name}</code>
                        {x.enabled && (
                          <Pill tone="accent" title="Its durable grant is given: the judge passes its routine requests">
                            judge enabled
                          </Pill>
                        )}
                        {coreOnly(x) && (
                          <Pill title="Used by hortusd itself, never offered to a task">hortusd only</Pill>
                        )}
                      </p>
                      <p className="text-muted-foreground text-[13px]">
                        {kindLabel(x.type)}
                        {x.transform && <> · {TRANSFORMS[x.transform]?.label ?? x.transform}</>}
                        {x.hosts && <> · to {x.hosts.join(", ")}</>}
                        {users.length > 0 && <> · used by {users.join(", ")}</>} · last used{" "}
                        <RelTime iso={x.last_use} empty="never" />
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" onClick={() => setDialog({ name: x.name, type: x.type, replace: true })}>
                        Replace
                      </Button>
                      <IconButton
                        label={`Delete ${x.name}`}
                        icon="trash"
                        size="sm"
                        onClick={async () => {
                          if (
                            await confirmAction({
                              title: `Delete ${x.name}?`,
                              body: users.length
                                ? `It is in use by ${users.join(" and ")}: change that first, or hortus refuses.`
                                : "Tasks can no longer use it. Values cannot be recovered.",
                              confirm: "Delete",
                              danger: true,
                            })
                          )
                            remove(x.name);
                        }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty
              icon="key"
              title="No credentials yet"
              action={
                <Button variant="primary" onClick={() => setDialog({ provider: true })}>
                  Add a model provider
                </Button>
              }
            >
              Start with a model provider's API key: the Planner and Workers need one.
            </Empty>
          )}
        </Card>
      )}
      <CredentialDialog
        open={!!dialog}
        preset={dialog ?? {}}
        existing={list.data?.map((x) => x.name) ?? []}
        onClose={() => setDialog(null)}
      />
    </>
  );
}
