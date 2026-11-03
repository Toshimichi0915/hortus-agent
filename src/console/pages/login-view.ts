/** `/approvals/<id>/login`: the live view of a `login` entry (14-browser.md › Login view); app.js drives the canvas. */
import { h, layout, type Page, parse } from "../html.ts";
import type { ApprovalRow } from "./approvals.ts";

export const loginView: Page = (ctx, { m }) => {
  const id = Number(m[1]);
  const a = ctx.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  if (a?.kind !== "login") return layout(ctx, "approvals", "Login", h`<p>no login entry ${id}</p>`);
  const s = parse<{ url?: string; why?: string; origin?: string }>(a.summary) ?? {};
  const head = h`<p class="req">sign in to <b>${s.origin ?? ""}</b> for task <a href="/tasks/${a.task_id ?? ""}">${a.task_id ?? ""}</a>: <code>${s.url ?? ""}</code></p>
<p class="why">${s.why ?? ""}</p>`;
  if (a.status !== "pending")
    return layout(
      ctx,
      "approvals",
      `Login #${id}`,
      h`${head}<p class="decided">${a.status}: <a href="/approvals/${id}">entry</a></p>`,
    );
  return layout(
    ctx,
    "approvals",
    `Login #${id}`,
    h`${head}<section class="login-view" data-login="${id}">
<p class="lv-bar"><span data-lv-status>starting the browser…</span> <span data-idle></span></p>
<canvas tabindex="0" width="1280" height="900" aria-label="the site, live: click and type here"></canvas>
<label class="lv-keys">Type <input autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="text goes to the focused field"></label>
<p class="hint">What you type goes to the site; the task only ever gets placeholders for the cookies it sets.</p>
<div class="actions"><button type="button" class="ok" data-call="login.done" data-input="${JSON.stringify({ id })}" data-go="/approvals/{id}">Done</button><button type="button" class="bad" data-call="login.reject" data-input="${JSON.stringify({ id })}" data-go="/approvals/{id}">Reject</button></div>
</section>`,
  );
};
