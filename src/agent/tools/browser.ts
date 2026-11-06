/** The `browser` feature: seven CDP tools and `browser_login`, over one BrowserSession per process. */
import { join } from "node:path";
import { type Tool, tool } from "@hortus/core";
import { z } from "zod";
import { BrowserSession } from "../../browser/tools.ts";
import { taskRpc } from "../rpc.ts";
import type { TaskJson } from "../../types.ts";

/** `paths.work` is `<task dir>/out/work` on the host and in the VM. */
export function browserTools(
  task: TaskJson,
  session = new BrowserSession(task, join(task.paths.work, "..", "..")),
): Tool[] {
  const sel = z.string().min(1).describe("a CSS selector");
  return [
    tool({
      name: "browser_navigate",
      description:
        "Open a URL in the task's headless browser; returns the title and the final URL. It holds placeholder cookies only; logins you were given are already in it.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: ({ url }) => session.navigate(url),
    }),
    tool({
      name: "browser_click",
      description: "Click the element matching a CSS selector.",
      inputSchema: z.object({ selector: sel }),
      execute: ({ selector }) => session.click(selector),
    }),
    tool({
      name: "browser_type",
      description:
        "Focus the element matching a CSS selector and type text into it. For a configured password, type `hortus-secret-<name>`.",
      inputSchema: z.object({ selector: sel, text: z.string() }),
      execute: ({ selector, text }) => session.type(selector, text),
    }),
    tool({
      name: "browser_screenshot",
      description: "A PNG of the current page.",
      inputSchema: z.object({}),
      execute: () => session.screenshot(),
    }),
    tool({
      name: "browser_eval",
      description: "Evaluate JavaScript in the page (5 s timeout); returns the value as JSON or text.",
      inputSchema: z.object({ js: z.string().min(1) }),
      execute: ({ js }) => session.eval(js),
    }),
    tool({
      name: "browser_tree",
      description: "The page's accessibility tree (role, name, value per line, 20 KB cap): what is on the page.",
      inputSchema: z.object({}),
      execute: () => session.tree(),
    }),
    tool({
      name: "browser_console",
      description: "The last 50 console messages and errors of the page.",
      inputSchema: z.object({}),
      execute: () => session.console(),
    }),
    tool({
      name: "browser_login",
      description:
        "Ask the owner to sign in to a site for you (JS-hashed passwords, OTPs, CAPTCHAs). `why` is shown to them. Then end your turn: the cookies arrive in your inbox as from=cookies and the browser has them; navigate again.",
      inputSchema: z.object({ url: z.string().url(), why: z.string().min(1) }),
      execute: async ({ url, why }) => {
        const r = (await taskRpc(task.rpc, "browser.login", { url, why })) as {
          approval?: number;
          kind?: string;
          status?: string;
          cookies?: number;
        };
        if (r.status === "granted") {
          await session.ready();
          return `already signed in: ${r.cookies ?? 0} cookies for this site are in the browser; navigate again`;
        }
        return `waiting for the owner (approval ${r.approval}, ${r.kind === "grant" ? "reuse a stored login" : "sign in"}): end your turn; the cookies arrive in your inbox`;
      },
    }),
  ];
}
