# Step 3d — Remote console: `console.listen`, TLS, passkeys, sessions

Spec: v6 › Console › Remote, Security › Console. Depends on step 3 (console pages). Parallel with 3b, 3c, 3e–3h.

## Implementation

### Listener (`src/console/remote.ts`)

- `console.listen` set → `https.createServer` on it with `console.tls` (cert, key; reloaded on `SIGHUP`-free: re-read when the files change, checked hourly) or a cert minted from the hortus CA for `console.host` (F3's `ca.hostContext`). Plain HTTP is never served there. Same page code; a `remote: true` flag on the request context.
- Every remote request without a valid `__Host-hortus` cookie gets the login page (`200`, no other content, no RPC, no SSE), except `GET /enroll?code=…` with a live code and the two WebAuthn endpoints the login and enrolment pages call.
- Guards (06) apply with `Host` = `console.host`; `Sec-Fetch-Site` as before. The nftables session rule set (F4) adds `tcp dport <listen port> drop` on every address for session cgroups.

### Passkeys (`@simplewebauthn/server`)

- RP: `rpID = console.host`, `rpName = "hortus"`, `origin = https://console.host[:port]`.
- Enrolment: `enroll.code` (RPC, loopback only, role owner) inserts a 10-minute single-use code and returns the URL; the Settings page shows the code, the URL, and a QR (rendered server-side as an SVG with a small built-in QR encoder — no dependency; the ~150-line alphanumeric/byte-mode encoder is a unit of its own with tests against known vectors). `GET /enroll?code=` → the enrolment page; `POST /webauthn/register/options` (consumes nothing yet) → `generateRegistrationOptions({ userID: "owner", residentKey: "preferred", attestationType: "none" })`, challenge kept in a 5-minute memory map keyed by the code; `POST /webauthn/register/verify` → `verifyRegistrationResponse` → insert `passkeys` (credential id, public key, counter, transports, device name from the form), delete the code, set the session cookie (the device is logged in at once).
- Login: `POST /webauthn/login/options` → `generateAuthenticationOptions({ rpID, allowCredentials: all passkeys })`; `POST /webauthn/login/verify` → `verifyAuthenticationResponse`, counter updated (a counter that did not increase on an authenticator that reports counters is refused and logged), `last_use`, cookie set.
- Browser side (`static/webauthn.js`): `PublicKeyCredential.parseCreationOptionsFromJSON` / `parseRequestOptionsFromJSON` and `credential.toJSON()` where available, else manual base64url conversion of the four binary fields.

### Sessions

- Cookie `__Host-hortus=<256 random bits base64url>`; `Secure; HttpOnly; SameSite=Strict; Path=/`; row `console_sessions(hash = sha256(token), device, created, last_seen, address, passkey)`. Lookup by hash on every request; `last_seen` updated at most once a minute; idle > 30 days → deleted, login again. `session.list` and `session.revoke` (Settings page; also from loopback). Logout button → revoke own.
- A remote session is role `owner` for RPC: every console action works, chat included (the Worker runs on the host as at the machine; v6 Chat away from the machine).

### `owner.notify` URL

Step 4's notice carries `https://console.host/approvals/<id>` when `console.listen` is set, else the loopback URL.

## Functional tests

- Without the cookie: `GET /` → the login page, `POST /api/task.list` → 401 with the login page, `/events/chat` → 401; with a live code `GET /enroll?code=` → 200; a used or expired code → the login page.
- Enrolment: a WebAuthn flow driven with a software authenticator (`@simplewebauthn/server`'s test helpers or a scripted CDP virtual authenticator when 3h's CDP helper exists) creates a `passkeys` row and a session; a second enrolment with the same code fails; the code expires after 10 minutes.
- Login: a correct assertion sets the cookie and the next request renders Tasks; a wrong RP ID or origin fails verification; a replayed assertion (same counter) is refused.
- `session.revoke` from another session makes the revoked one's next request 401; a 31-day-idle row is deleted at the hourly sweep.
- `passkey.delete` refuses that key's next assertion and ends its sessions and any from before sessions named their passkey (v7 › Review round 16); the last key may go, loopback enrols again.
- The cookie is not sent to `127.0.0.1:7700` by a browser (`__Host-` prefix: assert the attributes in the `Set-Cookie` header), and loopback never requires one.
- A host session's `curl https://console.host:7443` (through the proxy's DNS answer it resolves to the session address → the proxy → `origins`… and directly by IP to the LAN address) is dropped by nftables; from the owner's shell it answers.
- TLS: with `console.tls` the served chain is the configured one; without, the leaf is signed by the hortus CA with `SAN = console.host`; the key files are read with mode checks (world-readable key → a warning in the log).
- v6 done-when (manual, with a phone on the LAN and `console.host` pointed at the machine in `/etc/hosts` or DNS): enrol from the loopback Settings page by scanning the QR, approve a merge from the phone off the LAN (the LAN can stand in: the test asserts the decision came through the remote listener by `address`), open a chat from the phone and edit a project in place.

## UI/UX verification

- The login page is one button ("Sign in with passkey") and the host name; an error is a sentence, not a code.
- Enrolment page: device name field (prefilled with the user agent's platform), one button; success shows "this device can now sign in" and a link to Tasks.
- Settings › Remote: the current listener and certificate source, the enrolment code with its expiry countdown, the QR, the passkey table (device, enrolled, last used, "delete"), the session table (device, created, last seen, address, "revoke", the current one marked), a "log out" for the remote session.
- Mobile width: pages are usable at 390 px (the Approvals row wraps, buttons are 44 px tall, the chat textarea is reachable with the keyboard open).

## Extensibility verification

- A second login method (deferred) is another pair of endpoints setting the same cookie; sessions and guards do not change.
- The remote CLI (v6 Deferred) is the socket transport over this listener with the cookie: the RPC router already takes role `owner` from the session.
