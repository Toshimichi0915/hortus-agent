/**
 * A Worker adds a transform (12-transforms-dof.md): `transforms.submit` validates the files, runs their tests in the
 * sandbox and opens a `transforms` approval holding the files; `approveTransform` (from `approval.decide`) stores the
 * entered credentials, installs the files into the transforms DOF and scopes the credentials to the requesting task.
 */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { define } from "../rpc.ts";
import { type Caller, type Manifest, RpcError, type VaultEntry } from "../types.ts";
import * as dof from "./dof.ts";
import * as gate from "./gate.ts";
import * as transforms from "./transforms.ts";
import { ctx, NAME, read, write } from "./vault.ts";

export const MAX_BYTES = 256 * 1024;
const FILE = /^(manifest\.json|transform\.js|README\.md|tests\/[a-z0-9-]+\.json)$/;

const Hostname = z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, "a hostname");
/** The location kinds the pipeline knows (pipeline.ts › locate). */
const Location = z
  .string()
  .regex(
    /^(header:[A-Za-z0-9-]+|basic:password|form:[^\s]+|query:[^\s]+|path:[^\s]*\{\}[^\s]*|ws:text)$/,
    "a location",
  );
const ManifestShape = z.strictObject({
  name: z.string(),
  credentials: z
    .record(
      z
        .string()
        .regex(NAME)
        .refine((n) => !n.startsWith("c-"), "c- is reserved"),
      z.strictObject({
        type: z.enum(["token", "github-app", "webhook-secret", "aws"]),
        hosts: z.array(Hostname).min(1),
        locations: z.array(Location).min(1),
      }),
    )
    .refine((c) => Object.keys(c).length > 0, "at least one credential"),
  scope: z.array(z.string()).optional(),
  consequential: z.array(z.string()).optional(),
  captures: z.array(z.unknown()).optional(),
});

const Req = z.object({
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
  stream: z.boolean(),
});
const Test = z.object({
  request: Req,
  template: Req,
  response: z
    .object({ status: z.number(), headers: z.record(z.string(), z.string()), body: z.string().nullable() })
    .optional(),
  expected: z.unknown().optional(),
});

const pretty = (v: unknown): string => (v === undefined ? "" : `${JSON.stringify(v, null, 2)}\n`);

/** Full-context line diff (`-`/`+`/` `), LCS. */
// ponytail: O(n·m) and no hunks; fine for manifests and test values, hunk it if submissions grow large
export function diff(a: string, b: string): string {
  const x = a ? a.replace(/\n$/, "").split("\n") : [];
  const y = b ? b.replace(/\n$/, "").split("\n") : [];
  const L = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  const at = (i: number, j: number): number => L[i]?.[j] ?? 0;
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      (L[i] as number[])[j] = x[i] === y[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push(` ${x[i]}`);
      i++;
      j++;
    } else if (i < x.length && (j >= y.length || at(i + 1, j) >= at(i, j + 1))) out.push(`-${x[i++]}`);
    else out.push(`+${y[j++]}`);
  }
  return `${out.join("\n")}\n`;
}

const invalid = (message: string, data?: unknown): never => {
  throw new RpcError("invalid", message, data);
};

export interface Submission {
  name: string;
  files: Record<string, string>;
}

/** Steps 1–2: the manifest and the tests. Returns the parsed manifest and the test count; throws `invalid`. */
export function validate({ name, files }: Submission): { manifest: Manifest; tests: number } {
  const bad = Object.keys(files).filter((f) => !FILE.test(f));
  if (bad.length)
    invalid(`unexpected files: ${bad.join(", ")} (manifest.json, transform.js, tests/<x>.json, README.md)`);
  const size = Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0);
  if (size > MAX_BYTES) invalid(`submission is ${size} bytes, over ${MAX_BYTES}`);
  const text = files["manifest.json"];
  const code = files["transform.js"];
  if (text === undefined || code === undefined) invalid("manifest.json and transform.js are required");
  let raw: unknown;
  try {
    raw = JSON.parse(text as string);
  } catch (e) {
    invalid(`manifest.json: ${(e as Error).message}`);
  }
  const m = ManifestShape.safeParse(raw);
  if (!m.success) invalid(`manifest.json: ${z.prettifyError(m.error)}`, m.error.issues);
  const manifest = m.data as Manifest;
  if (manifest.name !== name) invalid(`manifest.json names ${manifest.name}, not ${name}`);

  const tests = Object.keys(files)
    .filter((f) => f.startsWith("tests/"))
    .sort();
  if (!tests.length) invalid("at least one tests/<x>.json is required");
  const failures: { file: string; diff: string }[] = [];
  for (const file of tests) {
    let c: z.infer<typeof Test>;
    try {
      const t = Test.safeParse(JSON.parse(files[file] ?? ""));
      if (!t.success) throw new Error(`not { request, template, response?, expected? }: ${z.prettifyError(t.error)}`);
      c = t.data;
    } catch (e) {
      failures.push({ file, diff: (e as Error).message });
      continue;
    }
    try {
      const got = transforms.request(name, c.request, { now: 0, nonce: "test" }, code);
      if (!isDeepStrictEqual(got, c.template)) {
        failures.push({
          file,
          diff: `template (- expected, + request() returned):\n${diff(pretty(c.template), pretty(got))}`,
        });
        continue;
      }
      if (c.response) {
        const res = transforms.response(name, c.response, c.request, code);
        if (!isDeepStrictEqual(res, c.expected))
          failures.push({
            file,
            diff: `response (- expected, + response() returned):\n${diff(pretty(c.expected), pretty(res))}`,
          });
      }
    } catch (e) {
      failures.push({ file, diff: (e as Error).message });
    }
  }
  if (failures.length)
    invalid(`tests failed:\n${failures.map((f) => `${f.file}: ${f.diff}`).join("\n")}`, { failures });
  return { manifest, tests: tests.length };
}

export interface SubmitResult {
  /** the pending entry; null when this exact content is already enabled */
  approval: number | null;
  url?: string;
}

export function submit(s: Submission, caller: Caller): SubmitResult {
  const { manifest, tests } = validate(s);
  const hash = transforms.hashOf(s.files["manifest.json"] ?? "", s.files["transform.js"] ?? "");
  const db = ctx().db;
  const row = db.prepare("SELECT hash FROM transforms WHERE name = ? AND enabled_at IS NOT NULL").get(s.name) as
    | { hash: string }
    | undefined;
  if (row?.hash === hash) return { approval: null };
  const current = transforms.get(s.name)?.manifest;
  const vault = read();
  const names = Object.keys(manifest.credentials);
  const summary = {
    name: s.name,
    new: !current,
    manifestDiff: current ? diff(pretty(current), pretty(manifest)) : null,
    manifest: pretty(manifest),
    credentials: manifest.credentials,
    missing: names.filter((n) => !vault[n]).map((n) => ({ name: n, type: manifest.credentials[n]?.type })),
    configured: names.filter((n) => vault[n]),
    tests,
  };
  const g = gate.check({ caller, category: "transforms", hash, summary, consequential: false });
  if (g === "pass") return { approval: null };
  // the latest files of this hash ride on the entry (a resubmission with only new tests refreshes them)
  db.prepare("UPDATE approvals SET payload = ? WHERE id = ? AND status = 'pending'").run(
    JSON.stringify({ consequential: false, name: s.name, hash, files: s.files }),
    g.pending,
  );
  return { approval: g.pending, url: gate.approvalUrl(g.pending) };
}

define("transforms.submit", {
  roles: ["worker"],
  input: z.object({
    name: z.string().regex(/^[a-z0-9-]{1,64}$/),
    files: z.record(z.string(), z.string()),
  }),
  run: (input, caller) => submit(input, caller),
});

// ---------------------------------------------------------------------------------------------------------------------
// approval

const empty = (v: unknown): boolean => v === undefined || v === null || v === "";
const Entered = {
  token: z.object({ value: z.string().min(1) }),
  "webhook-secret": z.object({ value: z.string().min(1) }),
  "github-app": z.object({
    appId: z.coerce.number().int(),
    installationId: z.coerce.number().int(),
    privateKey: z.string().min(1),
  }),
  aws: z.object({ keyId: z.string().min(1), secret: z.string().min(1) }),
} as const;

/**
 * Before `gate.decide(id, "approve")`: a pending `transforms` entry is installed. Throws `invalid` (nothing stored) on a
 * malformed credential; any other entry is left alone.
 */
export async function approveTransform(id: number, credentials: Record<string, unknown> = {}): Promise<void> {
  const db = ctx().db;
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as gate.ApprovalRow | undefined;
  if (row?.category !== "transforms" || row.status !== "pending" || !row.payload) return;
  const { name, hash, files } = JSON.parse(row.payload) as {
    name: string;
    hash: string;
    files: Record<string, string>;
  };
  const manifest = JSON.parse(files["manifest.json"] ?? "{}") as Manifest;
  const vault = read();
  const added: Record<string, VaultEntry> = {};
  for (const [cred, c] of Object.entries(manifest.credentials)) {
    const v = credentials[cred];
    // an existing name is never overwritten; an empty field stays unconfigured
    if (vault[cred] || empty(v) || (typeof v === "object" && Object.values(v as object).every(empty))) continue;
    const r = Entered[c.type].safeParse(v);
    if (!r.success) invalid(`credential ${cred} (${c.type}): ${z.prettifyError(r.error)}`);
    added[cred] = { type: c.type, ...r.data, transform: name } as VaultEntry;
  }
  await dof.install(name, files, hash);
  if (Object.keys(added).length) write({ ...read(), ...added });
  if (!row.task_id) return;
  // only the names this transform introduces: one that already existed (`stripe`, say) keeps its own grant flow
  const fresh = Object.keys(manifest.credentials).filter((c) => !vault[c]);
  const now = new Date().toISOString();
  const t = db.prepare("SELECT scope FROM tasks WHERE id = ?").get(row.task_id) as { scope: string | null } | undefined;
  db.exec("BEGIN");
  try {
    if (t) {
      const scope = (t.scope ? JSON.parse(t.scope) : {}) as { credentials?: string[] };
      scope.credentials = [...new Set([...(scope.credentials ?? []), ...fresh])];
      db.prepare("UPDATE tasks SET scope = ? WHERE id = ?").run(JSON.stringify(scope), row.task_id);
    }
    for (const cred of fresh) {
      const has = db
        .prepare("SELECT 1 FROM approvals WHERE kind = 'grant' AND hash = ? AND task_id = ? AND status = 'approved'")
        .get(`grant:${cred}`, row.task_id);
      if (has) continue;
      db.prepare(
        "INSERT INTO approvals(kind, category, hash, task_id, summary, status, requested_at, decided_at, decided_by, payload) VALUES ('grant', ?, ?, ?, ?, 'approved', ?, ?, 'owner', ?)",
      ).run(
        `credential:${cred}`,
        `grant:${cred}`,
        row.task_id,
        JSON.stringify({ grant: cred, task: row.task_id, transform: name }),
        now,
        now,
        JSON.stringify({ approval: id }),
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
