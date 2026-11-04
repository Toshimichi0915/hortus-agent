# F3 + Step 2 — Secret Vault, proxy, transforms, approvals under `human`

Spec: v6 › Process › Network, Secret Vault, Approval Gate, Mount (writes). F3 is testable on loopback without capabilities; step 2 wires the dummy interface, role `core` for the connector, and the Approvals and Credentials pages (06-console.md).

## Implementation

### `src/vault/vault.ts`

```ts
type Credential =
  | { type: "token"; value: string }
  | { type: "github-app"; appId: number; installationId: number; privateKey: string }
  | { type: "webhook-secret"; value: string }
  | { type: "aws"; keyId: string; secret: string };
type Entry = Credential & { transform?: string; hosts?: string[]; last_use?: string };
read(): Record<string, Entry>; write(v): atomic 0600; secretValues(): { value: string; placeholder: string }[]  // every token/secret/privateKey/minted token
```

Placeholders: `hortus-secret-<name>` (configured), `hortus-secret-c-<id>` (captured, 3h). `effectiveHosts(name)`: the entry's `hosts` else the manifest entry of the same name, else the manifest entry of the same `type` (v7).

### `src/vault/ca.ts`

`ensure()`: `ca/ca.key` (RSA 2048) + `ca/ca.crt` (CN `hortus CA`, 10 years) via `openssl`. `hostContext(host)`: `ca/hosts/<host>.key|crt` (ECDSA P-256, SAN DNS or IP, 398 days, minted with `openssl req -x509`-less flow: key → CSR → `openssl x509 -req -CA`), cached `SecureContext` in memory, serialized per host (two SNI hits for one new host mint once). Hosts are validated (`[a-z0-9.-]`, ≤ 253) before touching the filesystem.

### `src/vault/transforms.ts`

```ts
interface Manifest {
  name: string;
  credentials: Record<string, { type: Credential["type"]; hosts: string[]; locations: Location[] }>;
  scope?: string[];            // "{api}/repos/{project}/**"
  consequential?: string[];    // "METHOD host/path" with * and **
  captures?: unknown[];        // 3h
}
type Location = `header:${string}` | "basic:password" | `form:${string}` | `query:${string}` | `path:${string}` | "ws:text";
interface Req { method: string; url: string; headers: Record<string, string>; body: string | null; stream: boolean }
interface Template extends Req {}        // handle syntax inside values: {secret:name} {basic:user:name} {sign:op(json-args)}
interface Res { status: number; headers: Record<string, string>; body: string | null }
interface ResponseResult { res: Res; capture?: { name: string; value: string; origin: string }[]; repos?: string[]; refs?: string[] }
load(dirs): Map<name, { manifest, code, hash }>   // dist/transforms/* and, from 3f, enabled rows of the transforms DOF
byHost(host): { name, manifest, credential name } | undefined   // the first manifest whose effective hosts (manifest or vault override) include host
request(name, req, ctx: { now, nonce }): Template
response(name, res, req): ResponseResult
render(name, template): string | undefined
runTests(name): { file, ok, diff? }[]   // tests/*.json: { request, template, response, expected }
```

Runtime: `quickjs-emscripten`, one WASM module per process, per call a new runtime (`setMemoryLimit(32 MiB)`, `setInterruptHandler`: 100 ms of the thread's CPU and of the clock, polled between operations, so one native call is not bounded, v7 › Review round 11), a fresh context, the transform evaluated as an ES module, the function called with JSON strings and its result parsed from a JSON string; everything disposed in `finally`. A thrown error, an interrupt, or a non-object result refuses the request (`502 transform failed`, logged with the name).

Shipped transforms (`transforms/<name>/`): `slack` (`slack.com`, `files.slack.com`; `header:Authorization`; `response()` returns `refs` for `chat.postMessage` as `slack:<channel>:<thread_ts ?? ts>`; consequential: `POST slack.com/api/chat.delete`, `files.delete`), `anthropic` (`api.anthropic.com`, `header:x-api-key`), `openai` (`api.openai.com`, `header:Authorization`), `openrouter` (`openrouter.ai`), `ollama` (`ollama.com`). Each `request()` replaces every `hortus-secret-<name>` it knows in its declared location with `{secret:<name>}` and returns the template; everything else untouched.

### `src/vault/scrub.ts`

`Scrubber(values)`: `text(s)` replaces every secret value (≥ 8 chars; shorter values are logged once as unscrubbable) with its placeholder, longest first; `stream()` is a `Transform` with a carry of `maxLen − 1` bytes; `headers(h)` applies `text` to every value. Rebuilt whenever the vault, the captured table, or the minted-token cache changes.

### `src/vault/gate.ts`

```ts
check(input: { caller: Caller; category: string; hash: string; summary: Summary; consequential: boolean }): "pass" | { pending: number }
decide(id, decision: "approve" | "reject", by: "owner" | "judge", extra?): void   // UPDATE … WHERE status='pending'; writes the decision to the task inbox
expire(): void   // every minute: pending requests older than 72 h → "expired"
```

`human` (F3): a `request` row with this `hash`, `status = approved`, not yet `used` → mark used, pass; `pending` with this hash → `{ pending }`; else insert pending and notify (`owner.notify` from step 4). Role `core` passes without a row (v7: hortusd is the owner's process). `grant`s and `auto` are 3e. `summary` is what the page shows: `{ method, host, path, headers (handles as handles, other values scrubbed), bodyPreview (2 KB), rendered? }`. `hash` = SHA-256 of canonical JSON `{ method, url, headers sorted, body }` of the template (handles, not secrets).

### `src/proxy/links.ts`

Client registry: `links` rows cached in memory: `address → { role, task, kind }`. `register(address, role, task, kind)`, `release(address)`, `lookup(address)`. The in-process client is `{ role: "core" }` without an address. Tests register `127.0.0.2` etc. and clients bind to them.

### `src/proxy/pipeline.ts` — one function for every client

```
handle(client, req: IncomingRequest): Response
 1. host = SNI (TLS) / Host (plain); none → 400 "no host"
 2. host == hortusd.internal → internal(client, req) with X-Hortus-Role / X-Hortus-Task from `client` (client-sent copies dropped)
 3. task = client.task ? tasks row : null; origins = merged(config.origins, task.origins); host not allowed → 403 page "host not in origins" (final, v6 Browser › Origins). The host is resolved and refused when any address is loopback/private/link-local (IPv6 forms that embed one included) unless in chat.allow, `"*"` and listed hosts alike (round 5: a listed name can be rebound); role core is unchecked; the connection goes to the checked address.
 4. tf = transforms.byHost(host); raw = read request (body buffered up to 1 MB unless streaming types → body null, stream true)
 5. refuse if any raw secret value appears anywhere in the request (headers, URL, body) → 403 "raw credential"
 6. template = tf ? transforms.request(tf.name, raw, { now, nonce }) : raw
 7. refuse if any `hortus-secret-` placeholder survives in template → 403 "unmapped placeholder"
 8. for each handle in template: name known (vault or captured) else 403; host ∈ effectiveHosts(name) else 403; location of the occurrence ∈ manifest locations else 403; task && name ∉ task.scope.credentials → grant approval (3e; under human: 403 {approval} of kind grant); manifest scope patterns (6) and consequential patterns → consequential flag
 9. hash = sha256(canonical(template)); category = `credential:<name>` (or `origin:<domain>` for captured); gate.check → pending → 403 {"approval": id, "category": category}
10. upstream = dev.upstreams[host] ?? https://host; send with handles resolved by ops (token / basic / sign), streaming the body when `stream`
11. response: headers scrubbed; body: event-stream or x-git-* → scrub stream, pipe; else buffer ≤ 16 MB, scrub, tf ? transforms.response() : identity; capture/repos/refs applied (repos only when consequential && approved); write to client. Bounds (round 5): an upstream socket idle 10 min (`IDLE_MS`, no bytes either way: a server that never answers or never finishes TLS) is dropped (502); the client hanging up aborts the upstream request; one client has at most 256 requests and upgrades open (`MAX_INFLIGHT`, then 429) and 16 MB of request bodies (`BODY_BUDGET`, round 8: `content-length` up to 1 MB, a chunked body or an upgrade 1 MB, then 429; an RPC declaring more than 1 MB is a 413 before any of it is read, round 9; a request has no receive deadline, `requestTimeout` 0, so a long push is not cut at Node's 5 minutes; a client socket idle 10 min, no bytes either way, is cut, `CLIENT_IDLE`, round 10: a Worker that stopped sending, a VM killed mid-upload), buffers at most 4 responses at once (`BUFFERING`, the rest wait with their sockets paused) and for at most 30 s each (`BUFFER_MS`, then it streams as a body over 16 MB does), and starts its `hortusd.internal` RPCs one per loop turn; the frame relay pauses a side whose destination needs a drain; response headers over Node's 16 KB limit are a 502.
```

`IncomingRequest` is the same object for the TLS server, the plain server, and the in-process `coreFetch(url, init)` (a `fetch`-shaped function the connectors use as `deps.fetch`), so there is one code path.

### `src/proxy/server.ts`, `dns.ts`, `net.ts`

- `server`: `https.createServer({ SNICallback: ca.hostContext, ALPNProtocols: ["http/1.1"] })` and `http.createServer`, both calling `pipeline.handle` with `client = links.lookup(local === "10.77.0.1" ? remote : local)`; `upgrade` → handshake through the pipeline, then a byte relay to the upstream socket (frame relay for `ws:text` hosts in 4b). `listen(address)` / `unlisten(address)` bind `:443`, `:80` (and the DNS socket) on one address; step 2 listens on `10.77.0.1`, tests on `127.0.0.x:<ephemeral>`.
- `dns`: UDP; `A` → the socket's own address, `AAAA` → empty NOERROR, other types → empty; TTL 5.
- `net`: `ensureDummy()` (`ip link add hortus0 type dummy`, `10.77.0.1/32`, up), `addAddress(a)`/`delAddress(a)`, the `inet hortus` table with base chains (`out` filter, `nat` nat), VM link rules (3g), session rules (F4). Every command is idempotent (`ip -j` and `nft -j list` first). `HORTUS_NO_NET=1` makes it a no-op for tests.

### Step 2 wiring

- `bin/hortusd.ts` starts `ca`, `net`, `proxy` (on `10.77.0.1`, ports from config `proxy`, DNAT'd from 443/80/53: v7 › Security › Network), and gives the gateway `coreFetch` as `deps.fetch` (the step-1 shim is deleted). The connector now sends placeholders and the pipeline inserts the token. `sessionNet.init` is wired in `hortusd.ts` (the proxy's `listen`/`unlisten`, `links`). The end-to-end test is `src/e2e/step2.test.ts` (loopback by default, `HORTUS_TEST_NET=1` for hortus0).
- Console pages Approvals and Credentials (06-console.md): pending entries with summary, approve/reject; credentials add/replace/delete with `transform` and `hosts`.
- `hortus install --ca` is the optional system-store install; host children get the CA by environment (F4).

## Functional tests

Pipeline (loopback, `HORTUS_NO_NET=1`, a fake upstream, links for `127.0.0.2` (worker, task T) and `127.0.0.3` (unregistered)):

- A `curl --interface 127.0.0.2 -H "Authorization: Bearer hortus-secret-slack" https://slack.com/api/auth.test` resolved to the proxy (`--resolve`) under `human` returns `403 {"approval": 1, "category": "credential:slack"}`; after `approval.decide(1, approve)` the same request passes and the fake sees `Bearer xoxb-real`; the third identical request is pending again (single use).
- The same request from `127.0.0.3` → 403 unknown client.
- A request with the real `xoxb-real` in the header, from a session address → 403 "raw credential"; in the body → the same.
- `hortus-secret-slack` in a JSON body to `slack.com` (not a declared location) → 403 "unmapped placeholder"; to `example.com` (no transform) → 403.
- `hortus-secret-slack` to `api.github.com` → 403 destination.
- A credential name not in `vault.json` → 403 even if a transform maps it.
- No placeholder at all (`GET https://registry.npmjs.org/zod`) → proxied without any approval; the response is scrubbed if it happened to contain a secret.
- `origins: ["registry.npmjs.org"]` on the task → `https://example.com` gets the 403 page, `registry.npmjs.org` passes; `"*"` refuses `http://10.0.0.1/` and `localhost`, accepts them when listed in `chat.allow`.
- SSE: a fake upstream that streams 3 events 500 ms apart with the real token inside one of them: the client sees each event within 100 ms of its send (unbuffered) and the token replaced by the placeholder, including when the token straddles two chunks.
- `application/x-git-receive-pack` with a 5 MB body streams (the transform sees `body: null, stream: true`, memory stays flat).
- A transform that loops forever is interrupted within ~200 ms → `502`; one that allocates 100 MB → `502`; one that returns a string → `502`; the next request on a healthy transform works (fresh context).
- `render()` output appears in the approval summary when defined.
- `refs` from the slack transform's `response()` on `chat.postMessage` insert `slack:C1:<ts>` into `task_refs` for task T.
- Hash: two requests differing only in body whitespace have different hashes; two with the same template and different placeholders in a header order permutation have the same hash.
- Role `core` requests pass without an approval row.
- `expire()` turns a 73-hour-old pending request into `expired` and a retry creates a fresh pending entry.
- WebSocket: an upgrade to the fake's `wss` host relays bytes both ways and closes when either side does.
- Scrubber: values shorter than 8 chars are not scrubbed (and logged once); the longest secret is replaced first when one is a prefix of another.
- CA: `hostContext("slack.com")` mints once under 100 parallel calls; a host with `..` or `/` is refused; the leaf verifies against `ca.crt` with `openssl verify`.
- DNS: `A slack.com` → the listener address; `AAAA` → no answer, `NOERROR`; a malformed packet is ignored.

Step 2 end-to-end (dev-run): the fake Slack (through `dev.upstreams`) syncs with the connector sending placeholders (the fake asserts it received `xoxb-real`); a `curl` from a session address added by hand (`ip addr add 10.77.1.9/32 dev hortus0`, `links.register`) reproduces the approval flow above on the Approvals page.

## UI/UX verification

- Approvals page: pending first, newest first; each entry shows category, task, method, host, path, headers with handles as `{secret:slack}`, a body preview, and the transform's rendering when present; approve/reject are two buttons, the decision is reflected without a full reload (SSE), the entry moves to "decided" with who and when.
- A decided entry cannot be decided again (buttons gone; a stale tab's click gets `already decided`).
- Credentials page: names, types, transform, hosts, last use; the value field is write-only (never pre-filled); replacing asks for the value again; deleting a credential a transform still names shows a warning line; the form validates `hosts` as hostnames.
- A `403 {"approval"}` body is JSON with the console URL of the entry so a human reading a Worker's log can open it.

## Extensibility verification

- A new API: `transforms/<name>/` (manifest, `transform.js`, tests) and a `vault.json` entry; no TypeScript. Verify with a `notion` sample under `test/fixtures/transforms/` loaded via a test dir.
- A new credential type with a new signing operation is one entry in `ops.ts` and the manifest type union (v6: human-reviewed runtime changes).
- A new location kind (e.g. `json:/token`) is one case in the location finder.
- A new client kind (VM tap, login view) is one `links.register` call; the pipeline does not change.
