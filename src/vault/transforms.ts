/**
 * Transforms: manifest + pure JS in QuickJS (WASM). One WASM module per process; per call a fresh runtime and context
 * (32 MiB, 100 ms), arguments and results marshalled as JSON strings, everything disposed in `finally`.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { newQuickJSWASMModule, type QuickJSWASMModule, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { z } from "zod";
import type { Manifest, Req, Res, ResponseResult, Template } from "../types.ts";
import { ctx, read } from "./vault.ts";

export interface Loaded {
  manifest: Manifest;
  code: string;
  hash: string;
  dir: string;
}

/** dist/transforms (copied there by the build). */
export const shippedDir = (): string => fileURLToPath(new URL("../transforms", import.meta.url));

let QuickJS: QuickJSWASMModule | undefined;
let loaded = new Map<string, Loaded>();

export const MEMORY = 32 * 1024 * 1024;
export const DEADLINE_MS = 100;

export const hashOf = (manifest: string, code: string): string =>
  createHash("sha256").update(manifest).update("\0").update(code).digest("hex");

/** Replaces the table: later dirs win on a name clash. `keep(dirName, hash)` false → skipped before parsing (3f). */
export async function load(
  dirs: string[] = [shippedDir()],
  keep?: (name: string, hash: string) => boolean,
): Promise<Map<string, Loaded>> {
  QuickJS ??= await newQuickJSWASMModule();
  const next = new Map<string, Loaded>();
  for (const root of dirs) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name);
      const mf = join(dir, "manifest.json");
      const js = join(dir, "transform.js");
      if (!existsSync(mf) || !existsSync(js)) continue;
      const text = readFileSync(mf, "utf8");
      const code = readFileSync(js, "utf8");
      const hash = hashOf(text, code);
      if (keep && !keep(name, hash)) continue;
      const manifest = expand(JSON.parse(text) as Manifest);
      next.set(manifest.name, { manifest, code, hash, dir });
    }
  }
  loaded = next;
  return loaded;
}

/**
 * Forge manifests: `{host}`/`{api}` in hosts, `scope` and `consequential` become one entry per DOF of the manifest's
 * type (its `host`, its `api` or `vars.host_api` for that host), else `vars` (v7 › Secret Vault). Hosts keep the host.
 */
function expand(m: Manifest): Manifest {
  const vars = m.vars;
  if (!vars) return m;
  let dofs: { host?: string; api?: string }[] = [];
  try {
    dofs = Object.values(ctx().config.dofs).filter((d) => d.type === m.name);
  } catch {} // not bound (tests loading transforms alone): the defaults
  const sets = (dofs.length ? dofs : [{}]).map((d) => {
    const host = d.host ?? vars.host;
    const api = d.api
      ? d.api.replace(/^https?:\/\//, "").replace(/\/$/, "")
      : d.host
        ? (vars.host_api ?? "{host}").replace("{host}", d.host)
        : vars.api;
    return { host, api };
  });
  const PH = /\{(host|api)\}/g;
  const each = (list: string[] | undefined, hostOnly = false) =>
    list && [
      ...new Set(
        list.flatMap((s) =>
          s.match(PH)
            ? sets.map((v) => {
                const r = s.replace(PH, (_, k: "host" | "api") => v[k]);
                return hostOnly ? (r.split("/")[0] ?? r) : r;
              })
            : [s],
        ),
      ),
    ];
  const credentials = Object.fromEntries(
    Object.entries(m.credentials).map(([k, c]) => [k, { ...c, hosts: each(c.hosts, true) ?? [] }]),
  );
  return { ...m, credentials, scope: each(m.scope), consequential: each(m.consequential) };
}

export const get = (name: string): Loaded | undefined => loaded.get(name);
export const all = (): Map<string, Loaded> => loaded;

/** The first manifest whose effective hosts (vault override first, then manifest hosts) include `host`. */
export function byHost(host: string): { name: string; manifest: Manifest; credential: string } | undefined {
  for (const [cred, e] of Object.entries(read())) {
    const t = e.transform && loaded.get(e.transform);
    if (t && e.hosts?.includes(host)) return { name: t.manifest.name, manifest: t.manifest, credential: cred };
  }
  for (const t of loaded.values()) {
    for (const [cred, c] of Object.entries(t.manifest.credentials))
      if (c.hosts.includes(host)) return { name: t.manifest.name, manifest: t.manifest, credential: cred };
  }
  return undefined;
}

export class TransformError extends Error {}

/** Call `fn(...args)` of the transform; `undefined` when it does not export `fn`. */
export function invoke(
  name: string,
  fn: string,
  args: unknown[],
  t: Pick<Loaded, "code"> | undefined = loaded.get(name),
): unknown {
  if (!t || !QuickJS) throw new TransformError(`no transform ${name}`);
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(MEMORY);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + DEADLINE_MS));
  const vm = rt.newContext();
  const unwrap = (r: ReturnType<typeof vm.evalCode>) => {
    if (r.error) {
      const e = vm.dump(r.error) as { name?: string; message?: string } | string;
      r.error.dispose();
      throw new TransformError(`${name}.${fn}: ${typeof e === "string" ? e : `${e?.name}: ${e?.message}`}`);
    }
    return r.value;
  };
  try {
    const mod = unwrap(vm.evalCode(t.code, `${name}.js`, { type: "module" }));
    vm.setProp(vm.global, "__m", mod);
    mod.dispose();
    const a = vm.newString(JSON.stringify(args));
    vm.setProp(vm.global, "__a", a);
    a.dispose();
    const r = unwrap(
      vm.evalCode(
        `typeof __m[${JSON.stringify(fn)}] === "function" ? JSON.stringify({ r: __m[${JSON.stringify(fn)}](...JSON.parse(__a)) }) : "{}"`,
      ),
    );
    const s = vm.getString(r);
    r.dispose();
    return (JSON.parse(s) as { r?: unknown }).r;
  } catch (e) {
    if (e instanceof TransformError) throw e;
    throw new TransformError(`${name}.${fn}: ${(e as Error).message}`);
  } finally {
    vm.dispose();
    rt.dispose();
  }
}

const Headers = z.record(z.string(), z.string());
const ReqShape = z.object({
  method: z.string(),
  url: z.string(),
  headers: Headers,
  body: z.string().nullable(),
  stream: z.boolean(),
});
const ResShape = z.object({ status: z.number().int(), headers: Headers, body: z.string().nullable() });
const ResultShape = z.object({
  res: ResShape,
  capture: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        origin: z.string(),
        kind: z.string().optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  repos: z.array(z.string()).optional(),
  refs: z.array(z.string()).optional(),
});

function shaped<T>(name: string, fn: string, shape: z.ZodType<T>, v: unknown): T {
  const r = shape.safeParse(v);
  if (!r.success) throw new TransformError(`${name}.${fn} returned ${v === undefined ? "nothing" : "a bad shape"}`);
  return r.data;
}

/** `code` given: run that instead of the loaded transform (submission tests, 3f). */
export function request(name: string, req: Req, ctx: { now: number; nonce: string }, code?: string): Template {
  const t = shaped(name, "request", ReqShape, invoke(name, "request", [req, ctx], code ? { code } : undefined));
  // a streamed body never passes through the transform, so it cannot invent one (a push's ref commands stay as read)
  return req.stream ? { ...t, body: req.body, stream: true } : t;
}

/** `site`: the site manifest's data, handed to the `cookie` layer as a third argument (3h). */
export function response(name: string, res: Res, req: Req, code?: string, site?: unknown): ResponseResult {
  const args = site === undefined ? [res, req] : [res, req, site];
  return shaped(name, "response", ResultShape, invoke(name, "response", args, code ? { code } : undefined));
}

export function render(name: string, template: Template): string | undefined {
  const r = invoke(name, "render", [template]);
  return typeof r === "string" ? r : undefined;
}

/** tests/*.json: `{ request, template?, response?, expected? }`; the request's ctx is `{ now: 0, nonce: "test" }`. */
export function runTests(name: string): { file: string; ok: boolean; diff?: string }[] {
  const t = loaded.get(name);
  if (!t) throw new TransformError(`no transform ${name}`);
  const dir = join(t.dir, "tests");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const c = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        request: Req;
        template?: Template;
        response?: Res;
        expected?: ResponseResult;
      };
      try {
        if (c.template) {
          const got = request(name, c.request, { now: 0, nonce: "test" });
          if (!isDeepStrictEqual(got, c.template)) return { file, ok: false, diff: `template: ${JSON.stringify(got)}` };
        }
        if (c.response && c.expected) {
          const got = response(name, c.response, c.request);
          if (!isDeepStrictEqual(got, c.expected)) return { file, ok: false, diff: `response: ${JSON.stringify(got)}` };
        }
        return { file, ok: true };
      } catch (e) {
        return { file, ok: false, diff: (e as Error).message };
      }
    });
}
