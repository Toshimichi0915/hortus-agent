import { existsSync } from "node:fs";
import { button, details, h, layout, type Page } from "../html.ts";

export const settings: Page = (ctx) => {
  const c = ctx.config;
  const paused = existsSync(ctx.paths.paused());
  const notes = c.judge_notes ?? {};
  const policy = Object.entries(c.policy).filter(([k]) => k !== "deny" && k !== "cache");
  return layout(
    ctx,
    "settings",
    "Settings",
    h`<section data-refresh id="pause"><h2>Pause</h2>
<p class="hint">Pausing stops the dispatcher from starting queued tasks; running ones finish their turn.</p>
<p>${paused ? "Paused." : "Running."} ${button(paused ? "Resume" : "Pause", "pause.set", { paused: !paused })}</p></section>
<h2>Policy</h2>${
      policy.length
        ? h`<table><thead><tr><th>Category</th><th>Mode</th><th>Judge notes</th></tr></thead><tbody>${policy.map(
            ([k, v]) => h`<tr><td>${k}</td><td>${String(v)}</td><td>${notes[k] ?? ""}</td></tr>`,
          )}</tbody></table>`
        : h`<p class="empty">no policy</p>`
    }<p class="hint">Edit policy and judge_notes in the JSON below.</p>
<h2>hortusd.json</h2><form data-call="settings.set" class="editor">
<textarea name="config" data-json rows="24" spellcheck="false">${JSON.stringify(c, null, 2)}</textarea>
<button>Save and reload</button></form>${c.dev ? h`<h2>Development</h2>${details("dev", c.dev)}` : ""}`,
  );
};
