/** The remote listener's login page: the only thing an unauthenticated request sees (no nav, no counts). */
import { h, type Raw } from "../html.ts";

/** A page without the console's nav: login and enrolment, driven by `/static/webauthn.js`. */
export function bare(page: string, title: string, body: Raw): string {
  return `<!doctype html>${h`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,">
<title>${title} · hortus</title><link rel="stylesheet" href="/static/app.css"><script src="/static/webauthn.js" defer></script></head>
<body data-page="${page}"><main><h1>${title}</h1>${body}<output id="msg" role="status"></output></main></body></html>`}`;
}

export const loginPage = (host: string): string =>
  bare(
    "login",
    "hortus",
    h`<p class="hint">${host}</p><p><button type="button" id="signin" class="ok">Sign in with passkey</button></p>`,
  );
