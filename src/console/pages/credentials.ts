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

export const credentials: Page = async (ctx) => {
  const r = await tryCall<Cred[]>("credential.list", {});
  const list = r.ok ? r.value : [];
  return layout(
    ctx,
    "credentials",
    "Credentials",
    h`<div data-refresh id="list">${
      r.ok
        ? list.length
          ? h`<table><thead><tr><th>Name</th><th>Type</th><th>Transform</th><th>Hosts</th><th>Last use</th><th></th></tr></thead><tbody>${list.map(
              (c) =>
                h`<tr><td>${c.name}</td><td>${c.type}</td><td>${c.transform ?? ""}</td><td>${(c.hosts ?? []).join(", ")}</td><td>${time(
                  c.last_use,
                )}</td><td>${button("Delete", "credential.delete", { name: c.name }, { confirm: true })}</td></tr>`,
            )}</tbody></table>`
          : h`<p class="empty">no credentials</p>`
        : error(r.error)
    }</div><h2>Add or replace</h2><p class="hint">Values are write-only: they are never shown again.</p>${form}`,
  );
};
