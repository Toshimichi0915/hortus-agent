/** The vault module: CA, transforms, the gate's expiry timer, and the owner's approval and credential RPCs. */
import { z } from "zod";
import type { Ctx, Module } from "../ctx.ts";
import { onApproved as landMerge } from "../projects/merge.ts";
import { define } from "../rpc.ts";
import { RpcError, type VaultEntry } from "../types.ts";
import * as ca from "./ca.ts";
import * as gate from "./gate.ts";
import { approveTransform } from "./submit.ts";
import * as transforms from "./transforms.ts";
import { bind, ctx, NAME, read, write } from "./vault.ts";

export { ca, gate, transforms };
export { transformsDofModule } from "./dof.ts";
export const gateDeps = gate.deps;

let timer: NodeJS.Timeout | undefined;

export const vaultModule: Module = {
  name: "vault",
  async start(c: Ctx) {
    bind(c);
    // a crash mid-install (submit.ts › approveTransform) puts the entry back before the owner: approving re-installs
    c.db.prepare("UPDATE approvals SET status = 'pending' WHERE status = 'installing'").run();
    // a crash mid-landing (merge.ts › landNow) leaves an approved merge without a reason, which the console shows
    // without its Retry; a retry finishes a landing that got as far as the checkout or the origin
    c.db
      .prepare(
        "UPDATE approvals SET reason = 'interrupted by a restart: retry' WHERE category = 'merge' AND status = 'approved' AND reason IS NULL",
      )
      .run();
    await ca.ensure();
    await transforms.load();
    timer = setInterval(() => {
      try {
        gate.expire();
      } catch (e) {
        c.log("gate").error("expire failed", e);
      }
    }, 60_000);
    timer.unref();
  },
  async stop() {
    clearInterval(timer);
  },
};

const parse = (r: gate.ApprovalRow) => ({
  ...r,
  summary: JSON.parse(r.summary) as unknown,
  payload: r.payload ? (JSON.parse(r.payload) as unknown) : null,
  url: gate.approvalUrl(r.id),
});

/** Newest first, `limit` from `skip`; without `status`, pending then decided, each list paged (the CLI pages `--all`). */
define("approval.list", {
  roles: ["owner"],
  input: z
    .object({
      status: z.string().optional(),
      limit: z.number().int().positive().max(500).default(50),
      skip: z.number().int().nonnegative().default(0),
    })
    .default({ limit: 50, skip: 0 }),
  run: ({ status, limit, skip }) => {
    const db = ctx().db;
    const page = (where: string, ...a: string[]) =>
      db.prepare(`SELECT * FROM approvals WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...a, limit, skip);
    const rows = status ? page("status = ?", status) : [...page("status = 'pending'"), ...page("status != 'pending'")];
    return (rows as unknown as gate.ApprovalRow[]).map(parse);
  },
});

/** The nav badge's number: a count, not 500 rows of 64 KB diffs on every approvals event. */
define("approval.count", {
  roles: ["owner"],
  input: z.object({ status: z.string().default("pending") }).default({ status: "pending" }),
  run: ({ status }) =>
    (ctx().db.prepare("SELECT count(*) AS n FROM approvals WHERE status = ?").get(status) as { n: number }).n,
});

define("approval.get", {
  roles: ["owner"],
  input: z.object({ id: z.number().int() }),
  run: ({ id }) => {
    const r = ctx().db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as gate.ApprovalRow | undefined;
    if (!r) throw new RpcError("not_found", `no approval ${id}`);
    return parse(r);
  },
});

define("approval.decide", {
  roles: ["owner"],
  input: z.object({
    id: z.number().int(),
    decision: z.enum(["approve", "reject"]),
    /** 3f: values for the credentials a transform entry names */
    credentials: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().optional(),
    /** round 7: also allow the entry's category for its (tainted) task; `gate.grantable` entries only */
    grant: z.boolean().optional(),
  }),
  run: async ({ id, decision, credentials, reason, grant }) => {
    // a transforms entry is claimed, installed and decided by approveTransform
    if (!(decision === "approve" && (await approveTransform(id, credentials, reason))))
      gate.decide(id, decision, "owner", { reason, grant });
    // 3b: an approved merge lands now; a failure is the entry's reason, not this call's error
    if (decision === "approve") await landMerge(id);
    return { ok: true };
  },
});

define("credential.list", {
  roles: ["owner"],
  input: z.unknown(),
  run: () =>
    Object.entries(read()).map(([name, e]) => ({
      name,
      type: e.type,
      transform: e.transform ?? null,
      hosts: e.hosts ?? null,
      last_use: e.last_use ?? null,
    })),
});

const Hostname = z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, "a hostname");
const Common = {
  name: z
    .string()
    .regex(NAME)
    .refine((n) => !n.startsWith("c-"), "c- is reserved for captured credentials"),
  transform: z.string().optional(),
  hosts: z.array(Hostname).optional(),
};
const CredentialInput = z.discriminatedUnion("type", [
  z.object({ ...Common, type: z.literal("token"), value: z.string().min(1) }),
  z.object({ ...Common, type: z.literal("webhook-secret"), value: z.string().min(1) }),
  z.object({
    ...Common,
    type: z.literal("github-app"),
    appId: z.number().int(),
    installationId: z.number().int(),
    privateKey: z.string().min(1),
  }),
  z.object({ ...Common, type: z.literal("aws"), keyId: z.string().min(1), secret: z.string().min(1) }),
]);

define("credential.set", {
  roles: ["owner"],
  input: CredentialInput,
  run: ({ name, ...entry }) => {
    const v = read();
    const prev = v[name];
    write({ ...v, [name]: { ...entry, ...(prev?.last_use ? { last_use: prev.last_use } : {}) } as VaultEntry });
    return { ok: true };
  },
});

define("credential.delete", {
  roles: ["owner"],
  input: z.object({ name: z.string() }),
  run: ({ name }) => {
    const v = { ...read() };
    if (!v[name]) throw new RpcError("not_found", `no credential ${name}`);
    // deleting what the config still names would fail every later start or sync with a puzzling error
    const c = ctx().config;
    const users = [
      c.worker.provider === name && "worker.provider",
      c.planner.provider === name && "planner.provider",
      name in c.dofs && `dofs.${name}`,
    ].filter(Boolean);
    if (users.length)
      throw new RpcError("invalid", `${name} is in use by ${users.join(", ")}: change that in Settings first`);
    delete v[name];
    write(v);
    return { ok: true };
  },
});
