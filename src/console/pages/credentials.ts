import { button, error, h, layout, type Page, time, tryCall } from "../html.ts";

/** `credential.list` rows (vault/index.ts) */
interface Cred {
  name: string;
  type: string;
  transform: string | null;
  hosts: string[] | null;
  last_use: string | null;
}

const pw = (name: string, label: string) =>
  h`<label>${label} <input type="password" name="${name}" autocomplete="off"></label>`;

/** Fields per type are shown by CSS (`form:has(option[value=…]:checked)`); empty fields are not sent. */
const form = h`<form class="cred" data-call="credential.set" data-reset>
<label>Name <input name="name" required pattern="[A-Za-z0-9_.\\-]+"></label>
<label>Type <select name="type"><option value="token">token</option><option value="github-app">github-app</option><option value="webhook-secret">webhook-secret</option><option value="aws">aws</option></select></label>
<label>Transform <input name="transform"></label>
<label>Hosts <input name="hosts" data-list placeholder="comma-separated" pattern="[A-Za-z0-9.\\-]+(\\s*,\\s*[A-Za-z0-9.\\-]+)*"></label>
<fieldset class="f-token f-webhook-secret">${pw("value", "Value")}</fieldset>
<fieldset class="f-github-app"><label>App id <input type="number" name="appId"></label><label>Installation id <input type="number" name="installationId"></label><label>Private key (PEM) <textarea name="privateKey" rows="4" autocomplete="off" spellcheck="false"></textarea></label></fieldset>
<fieldset class="f-aws">${pw("keyId", "Key id")}${pw("secret", "Secret")}</fieldset>
<button>Save</button></form>`;

/** `captured.list` rows (browser/login-view.ts): cookies and tokens the proxy captured, per site */
interface Origin {
  origin: string;
  cookies: number;
  tokens: number;
  last_use: string | null;
}

export const credentials: Page = async (ctx) => {
  const r = await tryCall<Cred[]>("credential.list", {});
  const o = await tryCall<Origin[]>("captured.list", {});
  const sites = o.ok
    ? o.value.length
      ? h`<table><thead><tr><th>Site</th><th>Cookies</th><th>Tokens</th><th>Last use</th><th></th></tr></thead><tbody>${o.value.map(
          (s) =>
            h`<tr><td>${s.origin}</td><td>${s.cookies}</td><td>${s.tokens}</td><td>${time(s.last_use)}</td><td>${button(
              "Forget",
              "captured.forget",
              { origin: s.origin },
              { confirm: true },
            )}</td></tr>`,
        )}</tbody></table>`
      : h`<p class="empty">no captured logins</p>`
    : error(o.error);
  const list = r.ok ? r.value : [];
  // durable grants (the `auto` gate's one click per credential)
  const enabled = new Set(
    (
      ctx.db
        .prepare("SELECT category FROM approvals WHERE kind = 'grant' AND task_id IS NULL AND status = 'approved'")
        .all() as { category: string }[]
    ).map((g) => g.category),
  );
  return layout(
    ctx,
    "credentials",
    "Credentials",
    h`<div data-refresh id="list">${
      r.ok
        ? list.length
          ? h`<table><thead><tr><th>Name</th><th>Type</th><th>Transform</th><th>Hosts</th><th>Gate</th><th>Last use</th><th></th></tr></thead><tbody>${list.map(
              (c) =>
                h`<tr><td>${c.name}</td><td>${c.type}</td><td>${c.transform ?? ""}</td><td>${(c.hosts ?? []).join(", ")}</td><td>${
                  enabled.has(`credential:${c.name}`) ? "enabled" : ""
                }</td><td>${time(
                  c.last_use,
                )}</td><td>${button("Delete", "credential.delete", { name: c.name }, { confirm: true })}</td></tr>`,
            )}</tbody></table>`
          : h`<p class="empty">no credentials</p>`
        : error(r.error)
    }<h2>Captured logins</h2><p class="hint">Cookies and tokens sites set for the browsers; forgetting a site logs every task out of it.</p>${sites}</div><h2>Add or replace</h2><p class="hint">Values are write-only: they are never shown again.</p>${form}`,
  );
};
