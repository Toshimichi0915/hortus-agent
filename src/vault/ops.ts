/**
 * Handles and the built-in operations that resolve them, the only cryptography a transform can ask for (v6 › Secret
 * Vault). `{secret:name}` inserts the value, `{basic:user:name}` the base64 of `user:value`, `{sign:op(args)}` runs
 * `ops[op]` with a JSON argument list whose first element is the credential name. A new operation is one entry here.
 */
import type { VaultEntry } from "../types.ts";
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
      if (typeof args[0] !== "string") throw new Error(`sign:${m[4]} needs a credential name first`);
      out.push({ kind: "sign", text: m[0], name: args[0], op: m[4], args: args.slice(1) });
    }
  }
  return out;
}

export type Secret = { entry: VaultEntry } | { captured: CapturedRow };

/** `sign` operations by name; each gets the credential and its args and returns the text that replaces the handle. */
export const ops: Record<string, (s: Secret, args: unknown[]) => string> = {
  // github-app installation-token and aws-sigv4 arrive with their steps (17, later); until then `{sign:…}` is refused
};

/** The value a `{secret:}`/`{basic:}` handle stands for: tokens and captured values only. */
function value(s: Secret): string {
  if ("captured" in s) return s.captured.value;
  if (s.entry.type === "token") return s.entry.value;
  // ponytail: github-app needs the installation-token op (step 17); webhook-secret/aws never ride as plain values
  throw new Error(`credential type ${s.entry.type} cannot be inserted as a value`);
}

/** Throws on anything it cannot resolve: the request is refused, never sent without its credential. */
export function resolveHandle(h: Handle, s: Secret): string {
  if (h.kind === "secret") return value(s);
  if (h.kind === "basic") return Buffer.from(`${h.user}:${value(s)}`).toString("base64");
  const op = h.op ? ops[h.op] : undefined;
  if (!op) throw new Error(`unknown operation ${h.op}`);
  return op(s, h.args ?? []);
}

/** Checks resolvability without producing values (step 8). */
export function resolvable(h: Handle, s: Secret): string | undefined {
  if (h.kind === "sign") return h.op && ops[h.op] ? undefined : `unknown operation ${h.op}`;
  if ("captured" in s || s.entry.type === "token") return undefined;
  return `credential type ${s.entry.type} cannot be inserted as a value`;
}
