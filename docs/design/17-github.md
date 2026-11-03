# Step 6 — Forge interface with the `github` connector

Spec: v6 › Connectors › Forges (GitHub column), Gateway (webhooks, CI, redelivery), Mirror (forge row), Projects › Forge origin, Secret Vault (`github-app`, `installation-token`, `hmac-verify`, scope patterns), Console › Sources. Depends on steps 2, 3, 4.

## Implementation

### Forge interface (`src/connectors/types.ts`)

```ts
export interface Forge extends Connector {
  projects(): Promise<string[]>;        // where the App is installed, filtered by config.repos
  clone(project: string): string;       // HTTPS URL; the placeholder rides as basic:password through insteadOf
  pushed(e: Event): string | null;      // the project whose repo mirror to fetch
  webhook(req: { headers; body: Buffer }): Promise<{ ok: boolean; event?: Event }>;  // verify and parse one delivery
  redeliveries?(since: string): AsyncIterable<{ key: string; event: Event }>;         // the delivery log
}
```

Webhook listener: `127.0.0.1:7701` (`src/gateway/webhooks.ts`): `POST /<dof>/webhook` → `forge.webhook()` → `validate → INSERT → 200` before any mirror work (the body is queued for the gateway loop); a bad signature → `401`; unknown DOF → `404`; body ≤ 25 MB. The public URL is the owner's tunnel (`cloudflared tunnel --url http://127.0.0.1:7701` or `ssh -R`); not installed by hortus, documented on the Sources page.

### `src/connectors/github.ts`

- Credential `github` (`github-app`); webhook secret `github-webhook`. `host` config → `api = https://<host>/api/v3`, else `api.github.com`.
- `projects()`: `GET /installation/repositories` (role core's installation token, read permissions per v6) filtered by `config.repos` globs.
- `webhook()`: `X-Hub-Signature-256` verified with the built-in `hmac-verify` op (hortusd calls `ops.hmacVerify("github-webhook", body, sig)`; constant-time); key `X-GitHub-Delivery`; events: `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `push`, `check_suite`, `installation_repositories` (membership → `projects()` changes), `repository` (created/deleted); author = `sender.login`, member = `author_association` ∈ OWNER/MEMBER/COLLABORATOR (from the payload's issue/comment/PR); bot = `sender.type === "Bot"`.
- `mirror()`: channel = `owner/repo` (directory `o/r` → `<o>__<r>` to avoid `/`? v6's mirror paths use `<channel>`; a `/` in a channel id would nest. v7: the channel directory is `owner__repo`; `channel.md` carries the real name), threads `#<n>` and `!<n>` with the top message per v6's PR example (`state`, `labels`, `assignees`, `head`, `base`, `head_sha`, `checks`); comments, reviews (`review: approved|changes_requested`), review comments (`path`, `line`) as messages; a PR's `diff.patch` under `files/` (`GET …/pulls/{n}` with `Accept: application/vnd.github.diff`, ≤ 20 MB); `check_suite` → patch `checks` on the PR's top message (worst of the suites on `head_sha`; `pending` while any runs). `wake`: issues, comments, reviews, PR open/close/merge → true; CI results → true only when the PR's ref is in `task_refs` (the connector asks `deps.hasRef(ref)`); pushes and reactions → false. `refs` = `[github:<o/r>:#n | !n]`.
- `history(project, since)`: `GET /repos/{p}/issues?state=all&since=&per_page=100` (issues and PRs), comments (`/issues/comments?since=`), reviews and review comments per open PR, PR diffs, check suites of open PRs; cursor = the max `updated_at`.
- `pushed(e)` for `push` events → the project; the repo mirror (`src/projects/repos.ts`): `repos/<dof>/<o__r>.git` bare, `git fetch --prune? no: never pruned` as role core via the proxy (`https://github.com/o/r.git` with `x-access-token:hortus-secret-github` basic auth; `insteadOf` for hortusd's own git via `GIT_CONFIG_*`), also on the 10-min poll; mounted at `/repos` in VMs; `task.json.paths.repos` on the host.
- `clone(project)` = `https://github.com/<o/r>.git`.
- `redeliveries(since)`: `GET /app/hook/deliveries?per_page=100` (role core, App JWT), for each delivery not in `events` (by `guid` = `X-GitHub-Delivery`) `GET /app/hook/deliveries/{id}` → the payload → an Event; hourly, 3 days back.

### Transform `github` and the vault

- Manifest per v6's example; `credentials.github.type = github-app`; `scope` and `consequential` patterns as listed.
- `ops.installationToken(name, repos, permissions)`: App JWT (RS256, `iat − 60`, `exp + 10 min`) → `POST /app/installations/{id}/access_tokens` with `repositories` and `permissions` (role core request through the pipeline? It needs the private key: the op runs in hortusd directly, not through a transform; the resulting token is cached 50 min keyed by `(task, repos, permissions)` and added to the scrub set). Permissions: Workers `contents: write, issues: write, pull_requests: write, checks: read, actions: read` (+ `administration: write` only for the two create endpoints, minted per request); role core `issues, pull_requests, checks, contents: read`.
- The transform's `request()` emits `{sign:installation-token({"name":"github"})}` as the bearer or basic password; the runtime resolves it with the caller's `scope.repos` (projects whose DOF is `github`) — so a Worker's token covers only its repos.
- Project scope: a credentialed URL must match a `scope` pattern with `{project}` ∈ `scope.repos` or a consequential pattern (03).
- `response()`: `refs` for created issues/PRs/comments (`github:<o/r>:#n`); `repos` for `POST /user/repos` and `/orgs/{org}/repos` (`full_name`).

### Dispatcher and Worker

- Forge-origin tasks: `scope.repos` set, no `scope.project` → VM (3g) or, with `worker.forge_runtime = host` (v7 addition for machines without an image), an unattended host session in `out/work`. The prompt: `git clone --reference /repos/<dof>/<o__r>.git <clone url> work/<repo>`, PR tasks check out `head`, new work on `hortus/<task>`, push (`git-receive-pack` is consequential → `old new refname` shown via `render()`), open the PR by API, `done`. The task stays `waiting` while the PR is open; the PR's close event closes it (Planner `task_close`).
- CI routing: `check_suite` events with a matching ref wake the Planner, which attaches them.

### Console › Sources page (06) gets the forge rows: installation, projects mirrored, webhook deliveries today, last redelivery check, tunnel hint.

### Fake GitHub (`test/fakes/github.ts`)

REST subset (installation token minting with JWT verification against the App's public key, repos, issues, comments, PRs with diff, check suites, deliveries log), webhook delivery with HMAC (`fake.deliver(event)` posts to `127.0.0.1:7701`), and a git HTTP server (`git http-backend` over the fake's repos, basic auth = the minted token).

## Functional tests

- Webhook: a valid delivery → 200 and one row; a bad signature → 401 and no row; a replayed delivery → 200 and no new row; a 30 MB body → 413.
- Mirror: an issue opened, commented, labelled, closed → files per v6; a PR with a diff → `files/diff.patch`; a review → `review: approved` message; a `check_suite` on an open PR → `checks: failure` patch; on a PR not in `task_refs` → no wake; in `task_refs` → wake; a push → the repo mirror fetches (`git -C repos/github/o__r.git log` shows the commit) and no wake.
- Trust: an OWNER comment is trusted; a stranger's (`NONE`) is not; `members` trust includes COLLABORATOR.
- Token minting: a Worker's token request to the fake carries `repositories: [r]` and the Worker permissions; the token appears nowhere in the Worker's session (`grep` the JSONL for the fake's issued token: zero hits) and is scrubbed in any response; a second request within 50 min reuses it; role core's token has read permissions only.
- Scope: a Worker with `scope.repos: ["github:o/r"]` → `GET /repos/o/r/issues` passes, `GET /repos/o/other/issues` → 403 scope; `POST /user/repos` (consequential) → approval → `repos` from the response extends the scope → the first push to the new repo passes the scope check (still consequential → approval).
- Push: `git push` through the proxy → `403 {approval}` with a summary rendering `old new refs/heads/hortus/<id>`; the decision reaches the inbox; the Worker's retry passes; the same push twice (same hash) needs one approval; a push to `main` is a separate entry the owner rejects.
- v6 done-when: the owner's issue comment "fix this" → task → the Worker clones with `--reference`, pushes, opens a PR (refs → `task_refs`), `done`; a stranger's comment on another issue is ignored until the owner asks; a review `changes_requested` and a failing `check_suite` resume the task on the same `work/` (VM or host); the PR's `closed` event → `task_close`.
- Redelivery: a delivery dropped by the tunnel (the fake records it in its log but never posts) is picked up by the hourly check and routed.
- `insteadOf`: a plain `git clone https://github.com/o/r.git` in the Worker carries `x-access-token:hortus-secret-github` (the fake's git server sees the minted token).
- `host` config: `api` becomes `https://<host>/api/v3` and the transform's hosts include it (manifest `{api}`/`{host}` placeholders expanded at load from the DOF config; v7 note).

## UI/UX verification

- A push entry reads `push o/r: 0000000 → 3f2a1c9 refs/heads/hortus/<id>` (via `render()`); a PR-creation request shows the title and base/head; a `DELETE` shows the path in red.
- Sources: the webhook URL to configure in the App is shown verbatim with the tunnel hint; "last delivery 2 min ago"; a red "no deliveries in 24 h while events were expected" line when the delivery log has entries the gateway never saw.

## Extensibility verification

- 6b adds `gitlab`/`bitbucket` as files behind `Forge` plus transforms; the webhook listener, repo mirrors, scope checks and the Planner do not change.
- `{api}`/`{host}` expansion in manifests is generic (every forge manifest uses it).
- The `installation-token` op is GitHub-specific by design (v6); other forges use static tokens through the generic path.
