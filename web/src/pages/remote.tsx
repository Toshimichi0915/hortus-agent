/**
 * Remote access: the HTTPS listener for other devices (`console` in hortusd.json), enrolling a device by code and QR,
 * its sessions and passkeys; and the two pages a device sees before it is signed in.
 */
import { useEffect, useState } from "react";
import { encode } from "../../../src/console/qr.ts";
import { call, type Passkey, type RemoteSession, type RemoteStatus, useCall } from "../api.ts";
import { type Draft, splitListen } from "../schema.ts";
import {
  Button,
  Callout,
  Card,
  Choice,
  CopyButton,
  confirmAction,
  Icon,
  Logo,
  NumberField,
  Pill,
  RelTime,
  SectionHead,
  Spinner,
  Switch,
  TextField,
  toast,
  useAction,
  useTitle,
} from "../ui.tsx";

/** The repo's own encoder (src/console/qr.ts), drawn as one path. */
function Qr({ text }: { text: string }) {
  const m = encode(text);
  const n = m.length;
  const d = m.flatMap((row, y) => row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : ""))).join("");
  return (
    <svg
      className="size-36 flex-none rounded-lg border [shape-rendering:crispEdges] sm:size-42"
      viewBox={`-4 -4 ${n + 8} ${n + 8}`}
      role="img"
      aria-label="QR code of the enrolment link"
    >
      <rect x={-4} y={-4} width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

function Countdown({ until, onEnd }: { until: string; onEnd: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Date.parse(until) - now);
  useEffect(() => {
    if (!left) onEnd();
  }, [left, onEnd]);
  const s = Math.round(left / 1000);
  return (
    <span className="font-mono">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

function Enrol({ remote }: { remote: boolean }) {
  const [code, setCode] = useState<{ url: string; expires_at: string } | null>(null);
  const [make, busy] = useAction(
    async () => {
      const c = await call<{ url: string; expires_at: string }>("enroll.code");
      setCode(c);
      return c;
    },
    () => undefined,
  );
  return (
    <Card
      title="Add a device"
      description="Open a one-time link on the phone or computer, and it makes a passkey for this hortus."
    >
      {remote ? (
        <p className="text-muted-foreground">
          Enrolment codes are made on the machine running hortus, at http://127.0.0.1:7700.
        </p>
      ) : code ? (
        <div className="flex flex-wrap items-start gap-5 [&>div]:min-w-55 [&>div]:flex-1">
          <Qr text={code.url} />
          <div className="flex flex-col gap-2 *:data-[slot=button]:self-start">
            <p>Scan this with the device, or open the link on it:</p>
            <div className="mt-1 flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/50 py-0.5 pr-0.5 pl-3 [&_code]:min-w-0 [&_code]:flex-1 [&_code]:overflow-x-auto [&_code]:text-xs [&_code]:whitespace-nowrap">
              <code className="truncate">{code.url}</code>
              <CopyButton text={code.url} />
            </div>
            <p className="text-muted-foreground text-[13px]">
              Works once, for <Countdown until={code.expires_at} onEnd={() => setCode(null)} />.
            </p>
            <Button size="sm" icon="refresh" loading={busy} onClick={() => make()}>
              New code
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="primary" icon="phone" loading={busy} onClick={() => make()}>
          Make an enrolment code
        </Button>
      )}
    </Card>
  );
}

export function Remote({ d }: { d: Draft }) {
  const c = d.draft.console;
  const st = useCall<RemoteStatus>("remote.status", {}, ["settings"]);
  const sessions = useCall<RemoteSession[]>("session.list", {}, ["settings"]);
  const keys = useCall<Passkey[]>("passkey.list", {}, ["settings"]);
  const [revoke] = useAction((id: number) => call("session.revoke", { id }), "Signed out");
  const [drop] = useAction((id: number) => call("passkey.delete", { id }), "Passkey deleted");
  const { address, port } = splitListen(c?.listen ?? "0.0.0.0:7443");
  const setListen = (a: string, p: number) =>
    d.set((x) => {
      x.console = { ...(x.console ?? { host: "" }), listen: `${a.includes(":") ? `[${a}]` : a}:${p}` };
    });
  const pendingRestart = JSON.stringify(d.saved.console) !== JSON.stringify(c);
  return (
    <>
      <SectionHead
        title="Remote access"
        description="Use hortus from your phone or another computer, signed in with a passkey. Off, the console answers only on this machine."
      />
      <Card>
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          <Switch
            label="Allow other devices"
            hint="hortus listens on HTTPS for them, behind a passkey sign-in."
            checked={!!c}
            onChange={(on) =>
              d.set((x) => {
                if (on) x.console = d.saved.console ?? { listen: "0.0.0.0:7443", host: "" };
                else delete x.console;
              })
            }
          />
          {c && (
            <>
              <TextField
                label="This machine's name"
                hint="What devices type to reach it, and the name on its certificate: a DNS name like hortus.home.arpa, or a tailnet name."
                value={c.host ?? ""}
                onChange={(v) =>
                  d.set((x) => {
                    x.console = { ...(x.console ?? { listen: c.listen }), host: v };
                  })
                }
                mono
                placeholder="hortus.home.arpa"
                restart
                error={d.errors["console.host"]}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Listen on"
                  hint="0.0.0.0 is every network of this machine; or one of its addresses."
                  value={address}
                  onChange={(v) => setListen(v, port)}
                  mono
                  restart
                />
                <NumberField
                  label="Port"
                  def="7443"
                  value={Number.isFinite(port) ? port : 7443}
                  min={1}
                  max={65535}
                  onChange={(v) => setListen(address, v)}
                  restart
                  error={d.errors["console.listen"]}
                />
              </div>
              <Choice
                label="Certificate"
                cards
                value={c.tls ? "own" : "ca"}
                onChange={(v) =>
                  d.set((x) => {
                    if (!x.console) return;
                    if (v === "own") x.console.tls = { cert: "", key: "" };
                    else delete x.console.tls;
                  })
                }
                options={[
                  {
                    value: "ca",
                    label: "hortus's own",
                    icon: "shield",
                    hint: "Each device must trust ~/.hortus/ca/ca.crt first: a passkey does not work past a certificate warning.",
                  },
                  {
                    value: "own",
                    label: "My certificate",
                    icon: "file",
                    hint: "One for the name above, from Let's Encrypt or your tailnet, say. Re-read hourly when it changes.",
                  },
                ]}
              />
              {c.tls && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="Certificate file"
                    value={c.tls.cert}
                    onChange={(v) =>
                      d.set((x) => {
                        if (x.console?.tls) x.console.tls.cert = v;
                      })
                    }
                    mono
                    placeholder="/etc/ssl/hortus/fullchain.pem"
                    error={d.errors["console.tls"]}
                  />
                  <TextField
                    label="Key file"
                    value={c.tls.key}
                    onChange={(v) =>
                      d.set((x) => {
                        if (x.console?.tls) x.console.tls.key = v;
                      })
                    }
                    mono
                    placeholder="/etc/ssl/hortus/privkey.pem"
                  />
                </div>
              )}
            </>
          )}
          {pendingRestart && (
            <Callout tone="info" title="Applies when hortusd restarts">
              Save, then restart it:
              <div className="mt-1 flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/50 py-0.5 pr-0.5 pl-3 [&_code]:min-w-0 [&_code]:flex-1 [&_code]:overflow-x-auto [&_code]:text-xs [&_code]:whitespace-nowrap">
                <code>sudo systemctl restart hortusd</code>
                <CopyButton text="sudo systemctl restart hortusd" />
              </div>
            </Callout>
          )}
        </div>
      </Card>
      {c && st.data?.listening && (
        <>
          <p className="text-muted-foreground text-[13px] flex flex-wrap items-center gap-2">
            <Icon name="check" size={14} /> Listening at <code>{st.data.url}</code> with {st.data.cert}.
          </p>
          <Enrol remote={st.data.remote} />
          <Card title="Signed-in devices">
            {!sessions.data ? (
              <Spinner />
            ) : sessions.data.length ? (
              <ul className="divide-y">
                {sessions.data.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-3 px-1 py-3 first:pt-1 last:pb-1 [&>svg]:text-muted-foreground"
                  >
                    <Icon name="phone" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium [&_code]:rounded-md [&_code]:border [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:text-xs">
                        {s.device} {s.current && <Pill tone="accent">this device</Pill>}
                      </p>
                      <p className="text-muted-foreground text-[13px]">
                        Seen <RelTime iso={s.last_seen} /> from {s.address} · signed in <RelTime iso={s.created} />
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="quiet-danger"
                      onClick={async () => {
                        if (
                          s.current ||
                          (await confirmAction({
                            title: `Sign ${s.device} out?`,
                            body: "It can sign in again with its passkey.",
                            confirm: "Sign out",
                            danger: true,
                          }))
                        )
                          revoke(s.id);
                      }}
                    >
                      {s.current ? "Sign out" : "Revoke"}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No device is signed in.</p>
            )}
          </Card>
          <Card
            title="Passkeys"
            description="Lost a device? Delete its passkey: it cannot sign in again, and its sessions end. With the last one gone, devices enrol again from this machine."
          >
            {!keys.data ? (
              <Spinner />
            ) : keys.data.length ? (
              <ul className="divide-y">
                {keys.data.map((k) => (
                  <li
                    key={k.id}
                    className="flex items-center gap-3 px-1 py-3 first:pt-1 last:pb-1 [&>svg]:text-muted-foreground"
                  >
                    <Icon name="key" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium [&_code]:rounded-md [&_code]:border [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:text-xs">
                        {k.device}
                      </p>
                      <p className="text-muted-foreground text-[13px]">
                        Added <RelTime iso={k.created} /> · last used <RelTime iso={k.last_use} empty="never" />
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="quiet-danger"
                      onClick={async () => {
                        if (
                          await confirmAction({
                            title: `Delete the passkey of ${k.device}?`,
                            body: "It can no longer sign in, and its sessions end now.",
                            confirm: "Delete",
                            danger: true,
                          })
                        )
                          drop(k.id);
                      }}
                    >
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No passkeys yet.</p>
            )}
          </Card>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Before sign-in (the remote listener only)

export function SignIn() {
  useTitle("Sign in");
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-3.5 rounded-2xl bg-card px-7 py-9 text-center shadow-md ring-1 ring-foreground/10 [&_h1]:text-[22px] [&_h1]:font-semibold [&_form]:w-full [&_form]:text-left">
        <span className="grid size-14 place-items-center rounded-2xl bg-brand/10">
          <Logo size={34} />
        </span>
        <h1>Sign in to hortus</h1>
        <p className="text-muted-foreground">{location.host}</p>
        <Button
          variant="primary"
          size="lg"
          icon="key"
          onClick={() => toast("Passkey sign-in starts working once the console API is connected", "info")}
        >
          Sign in with a passkey
        </Button>
        <p className="text-muted-foreground text-[13px]">
          No passkey on this device yet? On the machine running hortus, open Settings › Remote access and make an
          enrolment code.
        </p>
      </div>
    </main>
  );
}

const guess = (): string => {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android phone"
        : /Mac/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows PC"
            : "This device";
};

export function Enroll({ code }: { code: string | null }) {
  useTitle("Add this device");
  const [device, setDevice] = useState(guess);
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-3.5 rounded-2xl bg-card px-7 py-9 text-center shadow-md ring-1 ring-foreground/10 [&_h1]:text-[22px] [&_h1]:font-semibold [&_form]:w-full [&_form]:text-left">
        <span className="grid size-14 place-items-center rounded-2xl bg-brand/10">
          <Logo size={34} />
        </span>
        <h1>Add this device</h1>
        <p className="text-muted-foreground">
          It gets a passkey for {location.host}, and signs in with it from then on.
        </p>
        {code ? (
          <form
            className="flex flex-col gap-4 *:data-[slot=button]:self-start"
            onSubmit={(e) => {
              e.preventDefault();
              toast("Creating the passkey starts working once the console API is connected", "info");
            }}
          >
            <TextField
              label="Name this device"
              hint="So you can tell it apart under Remote access."
              value={device}
              onChange={setDevice}
            />
            <Button type="submit" variant="primary" size="lg" icon="key" disabled={!device.trim()}>
              Create passkey
            </Button>
          </form>
        ) : (
          <Callout tone="danger" title="This link has no code">
            Make a new one on the machine running hortus: Settings › Remote access.
          </Callout>
        )}
      </div>
    </main>
  );
}
