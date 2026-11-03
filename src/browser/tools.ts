/**
 * The Worker's browser (14-browser.md › Worker tools): one headless Chromium per task process, started on first use
 * with `out/work/chrome` as its profile, one tab, driven over CDP. It holds placeholders only: the jar from
 * `task.json.cookies` at launch, and each inbox `cookies` message (a finished login) before the next action.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Cdp, connect, launch, page } from "./cdp.ts";
import type { Cookie, TaskJson } from "../types.ts";

export const LOAD_MS = 10_000;
export const EVAL_MS = 5_000;
export const TREE_MAX = 20 * 1024;
const CONSOLE_MAX = 50;

interface Remote {
  type: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
}

const show = (r: Remote): string =>
  r.value !== undefined
    ? typeof r.value === "string"
      ? r.value
      : JSON.stringify(r.value)
    : (r.unserializableValue ?? r.description ?? r.type);

export class BrowserSession {
  private browser?: Browser;
  private cdp?: Cdp;
  private session = "";
  private starting?: Promise<void>;
  private logs: string[] = [];
  /** the highest inbox seq whose `cookies` were injected */
  private cookieSeq = 0;

  constructor(
    private task: TaskJson,
    /** the task directory (ctl/, out/) */
    private dir: string,
    private opts: { args?: string[]; caCert?: string } = {},
  ) {}

  private async start(): Promise<void> {
    const args = [...(process.env.HORTUS_CHROMIUM_FLAGS?.split(" ").filter(Boolean) ?? []), ...(this.opts.args ?? [])];
    const caCert = this.opts.caCert ?? process.env.SSL_CERT_FILE ?? join(this.dir, "ctl", "ca.crt");
    this.browser = await launch({ userDataDir: join(this.task.paths.work, "chrome"), caCert, args, noSandbox: true });
    const b = this.browser;
    process.once("exit", () => b.proc.kill("SIGKILL"));
    this.cdp = await connect(b.ws);
    this.session = await page(this.cdp);
    for (const d of ["Page", "Runtime", "Log", "Network"]) await this.send(`${d}.enable`);
    const log = (line: string) => {
      this.logs.push(line.slice(0, 2000));
      if (this.logs.length > CONSOLE_MAX) this.logs.shift();
    };
    this.cdp.on("Runtime.consoleAPICalled", (p) => {
      const args = (p.args as Remote[] | undefined) ?? [];
      log(`console.${String(p.type)}: ${args.map(show).join(" ")}`);
    });
    this.cdp.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails as { text?: string; exception?: Remote } | undefined;
      log(`exception: ${d?.exception ? show(d.exception) : (d?.text ?? "")}`);
    });
    this.cdp.on("Log.entryAdded", (p) => {
      const e = p.entry as { level: string; text: string; url?: string };
      log(`${e.level}: ${e.text}${e.url ? ` (${e.url})` : ""}`);
    });
    await this.inject(this.task.cookies ?? []);
  }

  /** Chromium up, the inbox's new `cookies` injected. */
  async ready(): Promise<void> {
    if (!this.cdp) {
      this.starting ??= this.start().catch((e) => {
        this.starting = undefined;
        void this.browser?.close();
        this.browser = this.cdp = undefined;
        throw e;
      });
      await this.starting;
    }
    await this.inject(this.inboxCookies());
  }

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.cdp) throw new Error("browser not started");
    return this.cdp.send<T>(method, params, this.session);
  }

  /** `cookies` inbox messages after the last one injected (their `data` is a placeholder jar). */
  private inboxCookies(): Cookie[] {
    const dir = join(this.dir, "ctl", "inbox");
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => /^\d{6}\.json$/.test(n));
    } catch {}
    const out: Cookie[] = [];
    for (const n of names.sort()) {
      const seq = Number(n.slice(0, 6));
      if (seq <= this.cookieSeq) continue;
      try {
        const m = JSON.parse(readFileSync(join(dir, n), "utf8")) as { from?: string; data?: unknown };
        if (m.from === "cookies" && Array.isArray(m.data)) out.push(...(m.data as Cookie[]));
      } catch {}
      this.cookieSeq = seq;
    }
    return out;
  }

  private async inject(cookies: Cookie[]): Promise<void> {
    // placeholders only: a real value here would mean the jar leaked
    const ok = cookies.filter((c) => c.value.startsWith("hortus-secret-c-"));
    if (!ok.length) return;
    await this.send("Network.setCookies", {
      cookies: ok.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        ...(c.expires ? { expires: c.expires } : {}),
        ...(c.secure ? { secure: true } : {}),
        ...(c.httpOnly ? { httpOnly: true } : {}),
      })),
    });
  }

  private async evaluate(expression: string, timeout = EVAL_MS): Promise<Remote> {
    const r = await Promise.race([
      this.send<{ result: Remote; exceptionDetails?: { text: string; exception?: Remote } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`eval timed out after ${timeout} ms`)), timeout + 1000).unref(),
      ),
    ]);
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception ? show(r.exceptionDetails.exception) : r.exceptionDetails.text);
    return r.result;
  }

  async navigate(url: string): Promise<string> {
    await this.ready();
    const cdp = this.cdp as Cdp;
    let off = () => {};
    const loaded = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), LOAD_MS);
      off = cdp.on("Page.loadEventFired", (_p, s) => {
        if (s !== this.session) return;
        clearTimeout(t);
        resolve(true);
      });
    });
    try {
      const nav = await this.send<{ errorText?: string }>("Page.navigate", { url });
      if (nav.errorText) return `navigation failed: ${nav.errorText}`;
      const ok = await loaded;
      const info = show(
        await this.evaluate(
          "JSON.stringify({ title: document.title, url: location.href, text: (document.body?.innerText ?? '').slice(0, 300) })",
        ),
      );
      const { title, url: final, text } = JSON.parse(info) as { title: string; url: string; text: string };
      // the proxy's own refusals (pipeline › egress, gate): plain text or the approval JSON
      const host = /^hortus: (host not in origins: [^\n]+)/.exec(text);
      if (host) return `${host[1]} — final: there is no approval for a host. Tell the owner with send and go on.`;
      if (/^\{"approval":/.test(text)) return `waiting for the owner's approval: ${text}`;
      return `${ok ? "" : `(load did not finish in ${LOAD_MS / 1000} s) `}${title ? `"${title}" ` : ""}${final}`;
    } finally {
      off();
    }
  }

  private async node(selector: string): Promise<number> {
    const { root } = await this.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.send<{ nodeId: number }>("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`no element matches ${selector}`);
    return nodeId;
  }

  async click(selector: string): Promise<string> {
    await this.ready();
    const nodeId = await this.node(selector);
    await this.send("DOM.scrollIntoViewIfNeeded", { nodeId }).catch(() => {});
    const { model } = await this.send<{ model: { content: number[] } }>("DOM.getBoxModel", { nodeId });
    const q = model.content;
    const x = ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4;
    const y = ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    return `clicked ${selector} at ${Math.round(x)},${Math.round(y)}`;
  }

  async type(selector: string, text: string): Promise<string> {
    await this.ready();
    await this.send("DOM.focus", { nodeId: await this.node(selector) });
    await this.send("Input.insertText", { text });
    return `typed ${text.length} characters into ${selector}`;
  }

  async screenshot(): Promise<{ type: "image"; mediaType: "image/png"; data: string }> {
    await this.ready();
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    return { type: "image", mediaType: "image/png", data };
  }

  async eval(js: string): Promise<string> {
    await this.ready();
    return show(await this.evaluate(js));
  }

  async tree(): Promise<string> {
    await this.ready();
    const { nodes } = await this.send<{
      nodes: {
        nodeId: string;
        parentId?: string;
        ignored?: boolean;
        role?: { value?: string };
        name?: { value?: string };
        value?: { value?: unknown };
      }[];
    }>("Accessibility.getFullAXTree");
    const depth = new Map<string, number>();
    const lines: string[] = [];
    let size = 0;
    for (const n of nodes) {
      const d = n.parentId === undefined ? 0 : (depth.get(n.parentId) ?? 0);
      const role = n.role?.value ?? "";
      const name = n.name?.value ?? "";
      const value = n.value?.value;
      const shown = !n.ignored && !(["none", "generic", "InlineTextBox"].includes(role) && !name);
      depth.set(n.nodeId, shown ? d + 1 : d);
      if (!shown || role === "InlineTextBox") continue;
      const line = `${"  ".repeat(d)}${role}${name ? ` "${name}"` : ""}${value !== undefined && value !== "" ? ` = ${JSON.stringify(value)}` : ""}`;
      size += line.length + 1;
      if (size > TREE_MAX) {
        lines.push("… (cut at 20 KB)");
        break;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  async console(): Promise<string> {
    await this.ready();
    return this.logs.length ? this.logs.join("\n") : "(no console output)";
  }

  async close(): Promise<void> {
    this.cdp?.close();
    await this.browser?.close();
    this.browser = this.cdp = this.starting = undefined;
  }
}
