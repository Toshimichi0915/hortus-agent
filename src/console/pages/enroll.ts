/** `GET /enroll?code=` on the remote listener with a live code: name this device, create its passkey. */
import { h } from "../html.ts";
import { bare } from "./login.ts";

export const enrollPage = (host: string, code: string): string =>
  bare(
    "enroll",
    "Enrol this device",
    h`<p class="hint">A passkey for ${host} is created on this device; it signs in here from then on.</p>
<form id="enroll" data-code="${code}"><p><label>Device name <input name="device" maxlength="100" required></label></p>
<p><button class="ok">Create passkey</button></p></form>
<p id="enrolled" hidden>This device can now sign in. <a href="/">Go to Tasks</a></p>`,
  );
