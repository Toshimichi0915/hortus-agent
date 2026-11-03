/**
 * Handles and the built-in operations that resolve them, the only cryptography a transform can ask for (v6 › Secret
 * Vault). `{secret:name}` inserts the value, `{basic:user:name}` the base64 of `user:value`, `{sign:op(args)}` runs
 * `ops[op]` with a JSON argument list whose first element is the credential name. A new operation is one entry here.
 */
import type { VaultEntry } from "../types.ts";
import { awsDate, type Signing, sigv4 } from "./sigv4.ts";
import type { CapturedRow } from "./vault.ts";

export interface Handle {
  kind: "secret" | "basic" | "sign";
  /** the whole `{…}` text */
  text: string;
  name: string;
  user?: string;
  op?: string;
  args?: unknown[];
}

// ponytail: sign args end at the first ")}"; a JSON string arg containing ")}" breaks parsing (refused, not leaked)
export const HANDLE =
  /\{(?:secret:([a-z0-9][a-z0-9_-]*)|basic:([^:{}]*):([a-z0-9][a-z0-9_-]*)|sign:([a-z0-9-]+)\((.*?)\))\}/g;

/** Every handle in `s`; a `{sign:…}` whose args are not JSON or whose first arg is not a name → throws. */
export function handles(s: string): Handle[] {
  const out: Handle[] = [];
  for (const m of s.matchAll(HANDLE)) {
    if (m[1]) out.push({ kind: "secret", text: m[0], name: m[1] });
    else if (m[3]) out.push({ kind: "basic", text: m[0], name: m[3], user: m[2] ?? "" });
    else {
      const args = JSON.parse(`[${m[5]}]`) as unknown[];
      // the name first, or an object holding it: aws-sigv4({"name":"aws","region":…}) gets the whole object
      const named = (args[0] as { name?: unknown } | null)?.name;
      if (typeof args[0] === "string")
        out.push({ kind: "sign", text: m[0], name: args[0], op: m[4], args: args.slice(1) });
      else if (typeof named === "string") out.push({ kind: "sign", text: m[0], name: named, op: m[4], args });
      else throw new Error(`sign:${m[4]} needs a credential name first`);
    }
  }
  return out;
}

export type Secret = { entry: VaultEntry } | { captured: CapturedRow };

/** `sign` operations by name; each gets the credential and its args and returns the text that replaces the handle. */
export const ops: Record<string, (s: Secret, args: unknown[], req?: Signing) => string> = {
  // github-app installation-token arrives with step 17
  "aws-sigv4": sigv4,
  "aws-date": awsDate,
};

/** Ops that sign the final request: left in place by the first pass, resolved with `req` once headers and body are set. */
export const late = new Set(["aws-sigv4"]);

/** The value a `{secret:}`/`{basic:}` handle stands for: tokens and captured values only. */
function value(s: Secret): string {
  if ("captured" in s) return s.captured.value;
  if (s.entry.type === "token") return s.entry.value;
  // ponytail: github-app needs the installation-token op (step 17); webhook-secret/aws never ride as plain values
  throw new Error(`credential type ${s.entry.type} cannot be inserted as a value`);
}

/** Throws on anything it cannot resolve: the request is refused, never sent without its credential. */
export function resolveHandle(h: Handle, s: Secret, req?: Signing): string {
  if (h.kind === "secret") return value(s);
  if (h.kind === "basic") return Buffer.from(`${h.user}:${value(s)}`).toString("base64");
  const op = h.op ? ops[h.op] : undefined;
  if (!op) throw new Error(`unknown operation ${h.op}`);
  if (!req && late.has(h.op ?? "")) return h.text;
  return op(s, h.args ?? [], req);
}

/** Checks resolvability without producing values (step 8). */
export function resolvable(h: Handle, s: Secret): string | undefined {
  if (h.kind === "sign") return h.op && ops[h.op] ? undefined : `unknown operation ${h.op}`;
  if ("captured" in s || s.entry.type === "token") return undefined;
  return `credential type ${s.entry.type} cannot be inserted as a value`;
}
