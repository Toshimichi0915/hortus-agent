# Step 6b — `gitlab` and `bitbucket` connectors and transforms, `equals`, `host`

Spec: v6 › Connectors › Forges (GitLab and Bitbucket columns). Depends on step 6's `Forge` interface and fake shape.

## Implementation

LFS: the `gitlab` transform drops `authenticated` and the `Authorization` of each action from `…/info/lfs/objects/batch`, so git-lfs sends its own credential (the placeholder) to `gitlab-lfs/objects`; v7 › Review round 14.

### `src/connectors/gitlab.ts`

- `api = https://<host ?? gitlab.com>/api/v4`; credential `gitlab` (`token`, `header:PRIVATE-TOKEN`); webhook secret `gitlab-webhook` verified with `equals` (`X-Gitlab-Token`, constant-time); key `X-Gitlab-Event-UUID`.
- Project ids are `group/…/project`, URL-encoded in API paths (`encodeURIComponent`); channel directory `group__sub__project`.
- Events (key `webhook-id`, else `Idempotency-Key`, else `X-Gitlab-Event-UUID`): `issue`, `note` (issue/MR/commit notes), `merge_request` (approvals on `approval`/`approved`, removals on `unapproval`/`unapproved`), `push`, `pipeline`; member = `GET /projects/{p}/members/all/{uid}` cached 1 h (access level ≥ 20); bot = `user.bot`? GitLab marks bots by `user_type`; a note by the token's own user (`GET /user` at start) is ours.
- Mirror: `#iid` issues, `!iid` MRs (`head` = `source_branch`, `base` = `target_branch`, `head_sha` = `last_commit.id`, `checks` from `pipeline` status: `success`/`failed`/`running`→`pending`), notes as messages, `GET /projects/{p}/merge_requests/{iid}/changes` → `diff.patch` (assembled from `changes[].diff` as unified diff), approvals as `review: approved`.
- History: `/projects/{p}/issues?updated_after=`, `/merge_requests?updated_after=`, `/issues/{iid}/notes`, `/merge_requests/{iid}/notes`, `/changes`, `/pipelines?ref=`; cursor = max `updated_at`.
- `projects()`: `GET /projects?membership=true&min_access_level=30` filtered by `repos`; `clone` = `https://<host>/<p>.git` (`oauth2:hortus-secret-gitlab`); `pushed` from `push` events.
- Transform `gitlab`: hosts `{host}`; `scope` `{host}/api/v4/projects/{project}/**` (with `{project}` URL-encoded), `{host}/{project}.git/**`; consequential `DELETE {host}/api/v4/**`, `POST {host}/**/git-receive-pack`, `POST {host}/api/v4/projects`, the deletes that are a POST (`jobs/*/erase`, `housekeeping`, `ml/mlflow/**/delete`), `import/**`, and every REST door to a ref (`merge_requests/*/merge`, whose `render()` shows the `sha`, `/rebase`, `merge_trains/**`, `repository/**`, `releases`).

### `src/connectors/bitbucket.ts`

- `api = https://api.bitbucket.org/2.0`; credential `bitbucket` (`token`, `header:Authorization` as `Bearer`; repository access token); webhook `X-Hub-Signature` HMAC-SHA256 via `hmac-verify`; key `X-Request-UUID`.
- Projects `workspace/repo`; events `issue:*`, `pullrequest:*` (created, updated, approved, comment_created, fulfilled, rejected), `repo:push`, `repo:commit_status_updated`; member = `GET /workspaces/{w}/members/{uid}` cached; bot = the token's own account.
- Mirror: `#id` issues, `!id` PRs (`head` = `source.branch.name`, `base` = `destination.branch.name`, `head_sha` = `source.commit.hash`, `checks` from commit statuses), comments, `GET /repositories/{p}/pullrequests/{id}/diff` → `diff.patch`.
- History: `/repositories/{p}/issues?q=updated_on>`, `/pullrequests?q=updated_on>` (state ALL), comments, diffs, statuses; cursor `updated_on`, sent unquoted without `Z` (BBQL datetimes). The issue tracker API is gone since 2026-08 (404/410 reads as no tracker).
- `projects()`: exact `repos` names by `GET /repositories/{w}/{r}` (all a repository access token can do); globs by `GET /repositories/{workspace}?role=member` per workspace they name; none by `GET /user/workspaces` first (`account` scope: a workspace access token). `/user/permissions/repositories` ended 2026-04-14; `clone` = `https://bitbucket.org/<w/r>.git` (`x-token-auth:hortus-secret-bitbucket`).
- Transform `bitbucket`: hosts `api.bitbucket.org`, `bitbucket.org`; `scope` `api.bitbucket.org/2.0/repositories/{project}/**`, `bitbucket.org/{project}.git/**`; consequential `DELETE api.bitbucket.org/**`, `POST bitbucket.org/**/git-receive-pack`, `POST api.bitbucket.org/2.0/repositories/*/*` (creation), and every REST door to a ref (`pullrequests/*/merge`, no commit to pin: `render()` says so, `src`, `refs/**`).

### `equals` op

`ops.equals(name, value)`: `timingSafeEqual` over equal-length buffers (length mismatch → false without early exit on content); used by GitLab's webhook check.

### Fakes

`test/fakes/gitlab.ts`, `test/fakes/bitbucket.ts` with the same control surface as the GitHub fake (deliver, issues, MR/PR with diff, pipeline/status, git server with the static token).

## Functional tests

- The step-6 test suite is parameterized by forge and runs against all three fakes: webhook verify (valid, bad, replay), mirror shapes, trust by membership, CI routing by `task_refs`, push approval with `render()`, PR/MR open→review→close flow, history cursors, `projects()` filtered by `repos`.
- Static token scope: with `scope.repos: ["gitlab:g/p"]` a `GET /api/v4/projects/g%2Fother/issues` → 403 scope (v6 done-when); the consequential `POST /api/v4/projects` passes the scope check and asks approval.
- GitLab project encoding: `g/sub/p` → `g%2Fsub%2Fp` in API paths and `g__sub__p` on disk; a webhook for a nested group project routes to the right channel.
- `host`: a self-hosted GitLab at `gitlab.example.com` → transform hosts and scope patterns expand to it; the connector's `api` follows.
- `equals`: a token differing in length → false; one differing in the last byte → false; equal → true; the call takes the same time for both failure cases (coarse timing assertion over 1000 runs).
- `git diff --stat` of 6b's change set touches only `src/connectors/{gitlab,bitbucket}.ts`, `transforms/{gitlab,bitbucket}/`, `connectors/index.ts`, `ops.ts` (`equals`), fakes and tests.

## UI/UX verification

- Sources rows show the forge's host, token type ("project access token"), and the webhook secret header name to configure.
- Push entries render the same `old new refname` line for every forge.

## Extensibility verification

- A fourth forge (Gitea) is the same pair of files; the parameterized suite is the acceptance test.
