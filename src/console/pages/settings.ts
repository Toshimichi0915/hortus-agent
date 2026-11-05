import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../../ctx.ts";
import { button, details, h, layout, PAUSED, type Page, type Params, raw, time } from "../html.ts";
import { svg } from "../qr.ts";
import { certSource, liveEnroll, passkeyList, sessions } from "../remote.ts";

export const settings: Page = (ctx, p) => {
  const c = ctx.config;
  const paused = existsSync(ctx.paths.paused());
  const notes = c.judge_notes ?? {};
  const policy = Object.entries(c.policy).filter(([k]) => !["deny", "cache", "read"].includes(k));
  return layout(
    ctx,
    "settings",
    "Settings",
    h`<section data-refresh id="pause"><h2>Pause</h2>
<p class="hint">While paused, ${PAUSED}</p>
<p>${paused ? "Paused." : "Running."} ${button(paused ? "Resume" : "Pause", "pause.set", { paused: !paused })}</p></section>
${remote(ctx, p)}
<section data-refresh id="policy"><h2>Policy</h2>${
      policy.length
        ? h`<table><thead><tr><th>Category</th><th>Mode</th><th>Judge notes</th></tr></thead><tbody>${policy.map(
            ([k, v]) => h`<tr><td>${k}</td><td>${String(v)}</td><td>${notes[k] ?? ""}</td></tr>`,
          )}</tbody></table>`
        : h`<p class="empty">no policy</p>`
    }<p class="hint">Edit policy and judge_notes in the JSON below.</p></section>
<h2>hortusd.json</h2><form data-call="settings.set" class="editor">
<textarea name="config" data-json rows="24" spellcheck="false">${JSON.stringify(c, null, 2)}</textarea>
<button>Save and reload</button><p class="hint">The console's own <code>console</code> keys and the <code>proxy</code> ports apply at the next start of hortusd.</p></form>${c.dev ? h`<h2>Development</h2>${details("dev", c.dev)}` : ""}`,
  );
};

/** Settings › Remote (10-remote-console.md): listener, enrolment code + QR (loopback only), sessions. */
function remote(ctx: Ctx, p: Params) {
  const c = ctx.config.console;
  if (!c?.listen)
    return h`<section id="remote"><h2>Remote</h2><p class="hint">Off. Set <code>console.listen</code> and <code>console.host</code> in hortusd.json and restart hortusd to sign in from other devices with a passkey.</p></section>`;
  const at = p.caller?.remote;
  const code = at ? undefined : liveEnroll(ctx.db);
  const rows = sessions(ctx.db, p.caller?.session);
  const keys = passkeyList(ctx.db);
  return h`<section data-refresh id="remote"><h2>Remote</h2>
<p>Listening on <code>${c.listen}</code> as <code>${c.host ?? ""}</code>; certificate ${certSource() ?? "not loaded"}.</p>${
    c.tls
      ? ""
      : h`<p class="hint">Each device must trust <code>${join(ctx.paths.ca(), "ca.crt")}</code> first: a passkey needs a certificate the device accepts. Or set <code>console.tls</code>.</p>`
  }
<h3>Enrol a device</h3>${
    at
      ? h`<p class="hint">Enrolment codes are made at the machine, on the loopback console.</p>`
      : h`${
          code
            ? h`<p>Open on the device, or scan: <a href="${code.url}"><code>${code.url}</code></a>
<span class="hint" data-expires="${code.expires_at}">expires ${time(code.expires_at)}</span></p><p class="qr">${raw(svg(code.url))}</p>`
            : h`<p class="hint">A code is single use and lasts 10 minutes.</p>`
        }<p>${button(code ? "New code" : "Make an enrolment code", "enroll.code", {})}</p>`
  }
<h3>Sessions</h3>${
    rows.length
      ? h`<table><thead><tr><th>Device</th><th>Created</th><th>Last seen</th><th>Address</th><th></th></tr></thead><tbody>${rows.map(
          (r) =>
            h`<tr><td>${r.device}${r.current ? h` <span class="badge">this one</span>` : ""}</td><td>${time(r.created)}</td><td>${time(r.last_seen)}</td><td>${r.address}</td><td>${
              r.current
                ? h`<button type="button" data-call="session.revoke" data-input="${JSON.stringify({ id: r.id })}" data-go="/">Log out</button>`
                : button("Revoke", "session.revoke", { id: r.id }, { confirm: true, cls: "bad" })
            }</td></tr>`,
        )}</tbody></table>`
      : h`<p class="empty">no remote sessions</p>`
  }
<h3>Passkeys</h3>${
    keys.length
      ? h`<table><thead><tr><th>Device</th><th>Enrolled</th><th>Last used</th><th></th></tr></thead><tbody>${keys.map(
          (k) =>
            h`<tr><td>${k.device}</td><td>${time(k.created)}</td><td>${time(k.last_use)}</td><td>${button("Delete", "passkey.delete", { id: k.id }, { confirm: true, cls: "bad" })}</td></tr>`,
        )}</tbody></table>
<p class="hint">Lost a device? Delete its passkey: it cannot sign in again, and its sessions end. With the last one gone, a device enrols again from the machine.</p>`
      : h`<p class="empty">no passkeys</p>`
  }</section>`;
}
