# Step 3f (v6 step 8) — Transforms DOF, test runner, manifest approval, `aws-sigv4`

Spec: v6 › Secret Vault › Adding transforms, Built-in operations. Depends on step 3 and F3. Parallel with 3b–3e, 3g, 3h.

## Implementation

### The `transforms` DOF

`dofs.transforms` is implicit like `logs`: a repo at `dof/transforms.git` + worktree, no connector, written only by `hortusd`. Shipped transforms are copied into it at first start and again when a release changes them (one commit `ship: <names>`), so a Worker reads every transform under `<dof>/transforms/<name>/`. The `transforms` table binds `(name, hash)`; `transforms.load()` takes the enabled rows from the worktree and ignores files whose content hash differs from the row (a tampered worktree disables the transform and logs).

### Submission (`src/vault/submit.ts`)

RPC `transforms.submit` (role worker): `{ name, files: { "manifest.json": string, "transform.js": string, "tests/<x>.json": string… } }` ≤ 256 KB total, names `[a-z0-9-]+`, no other paths.

1. Parse the manifest (03's schema); refuse unknown keys; refuse a credential type outside the known set; refuse `locations` the runtime does not know.
2. Run the tests in the sandbox, on a thread of their own (`submit.ts › inThread`, one submission at a time, terminated at the total): every `tests/*.json` is `{ request, template, response?, expected? }`: `request(request)` must deep-equal `template`; when `response` is given, `response(response, request)` must deep-equal `expected`. At least one test is required, at most 32, run until the first failure or 30 s in total (`TESTS.ms`; each call also has the 100 ms deadline). A failure returns the diff to the Worker (`invalid`), nothing is stored.
3. Diff against the current manifest of that name (none → "new"): a unified diff of the pretty-printed JSON, plus the list of `credentials` names missing from `vault.json` with their types.
4. Gate `check({ category: "transforms", hash: sha256(files), summary: { name, manifestDiff, missing: [{ name, type }], configured: [names], tests: n } })` → pending entry; the files are kept under `approvals.payload`. Returns `{ approval }`.

### Approval with credentials

`approval.decide({ id, decision: "approve", credentials: { <name>: { value } | { appId, installationId, privateKey } | { keyId, secret } } })`: on approve, in one DB transaction: each non-empty entered credential → `vault.json` with `transform = name` (a name that exists is not overwritten; the form shows it as configured and has no field); write the files into the worktree, `git add` + commit `transform(<name>): <hash[:8]>`; upsert `transforms(name, hash, enabled_at)`; `transforms.load()`; add the manifest's credential names to the requesting task's `scope.credentials` and insert task-scoped `grant` rows for them; inbox decision. A field left empty → the name stays unconfigured (a request with it → 403 until the Credentials page adds it).

Re-submission of an enabled name with a changed hash is a new entry; approving replaces the binding. Rejecting leaves the old version enabled.

### `aws-sigv4` (`ops.ts`)

`{sign:aws-sigv4({"name":"aws","region":"us-east-1","service":"s3"})}` as the `Authorization` value and `{sign:aws-date()}` for `x-amz-date`: the runtime computes the SigV4 signature over the final request (method, canonical URI and query, signed headers `host;x-amz-date` plus `x-amz-content-sha256` when present, payload hash) with the credential's `keyId`/`secret`; the secret never enters the sandbox. Streaming bodies use `UNSIGNED-PAYLOAD`. One shipped `aws` transform (`*.amazonaws.com`, `header:Authorization`) with tests, exercising the op.

### Worker side

The prompt (F5) tells a Worker how to add a transform: write the three files in `work/transforms/<name>/`, `POST https://hortusd.internal/rpc/transforms.submit` (the `dof` CLI gets `dof transform submit <dir>` for convenience), wait for the inbox decision. The transforms DOF is readable for examples.

### Console

A `transforms` entry on the Approvals page: name, "new" or the manifest diff, test count, one field per missing credential by type (`token`: value; `github-app`: three; `webhook-secret`: value; `aws`: two), configured names shown as such, approve/reject; approve submits the fields with the decision.

## Functional tests

- v6 done-when: a Worker (fake provider) submits a `notion` transform (`api.notion.com`, `header:Authorization`, one test); the entry shows the manifest (new) and a `notion` field; approve with a value → `vault.json` has `notion` with `transform: "notion"`, the DOF has the commit, the task's next request `Authorization: Bearer hortus-secret-notion` to `api.notion.com` passes under `human` after its request approval (or at once under `auto` with the task grant) and the fake upstream sees the entered value; nobody opened `transform.js`.
- Tests gate: a submission whose test's `template` differs from `request()`'s output → `invalid` with the diff, no entry; zero tests → `invalid`; a test file that is not an object → `invalid`.
- Runtime limits apply to tests (an infinite loop in `request()` fails the test within ~200 ms).
- Manifest safety: `locations: ["body:*"]` → refused; an unknown credential type → refused; a `hosts` entry with a path → refused; a 300 KB `transform.js` → refused.
- Partial credentials: approve with the `notion` field empty → the transform is enabled, `vault.json` unchanged, a request with the placeholder → 403 "unknown credential"; adding `notion` on the Credentials page makes it pass.
- Existing name: a manifest naming `slack` shows it as configured, no field; approving does not touch the `slack` entry.
- Tamper: editing `transform.js` in the worktree by hand → `load()` disables it (hash mismatch) and the Sources page shows "transforms: 1 disabled (hash mismatch)".
- Re-approval: a second submission of `notion` with a changed manifest shows the diff; approving swaps the hash; rejecting keeps the old one working.
- `aws-sigv4`: a canonical test vector (AWS's documented GET example) produces the documented signature; the secret never appears in the sandbox input (the runtime passes only `keyId`); a streaming PUT signs `UNSIGNED-PAYLOAD`.
- Only role worker may submit; the owner's CLI cannot; a Worker's entry names the submitting task and the grant is scoped to it.

## UI/UX verification

- The entry's header reads "transform `notion` (new): put `notion` into `header:Authorization` on `api.notion.com`" — the one line the owner needs; the diff and tests are folded.
- Credential fields are labelled by name and type, `password` inputs, with a hint "leave empty to add later".
- A rejected submission tells the Worker the owner's reason if given.

## Extensibility verification

- A new built-in op is one entry in `ops.ts` and one test vector; manifests reference it by name.
- The transforms DOF is the generic extension point: a Worker can add any HTTP API without a release of hortus.
- The submission's file set is fixed (manifest, code, tests); a `README.md` is accepted and ignored by the runtime, so a Worker can document its transform.
