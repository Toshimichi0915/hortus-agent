/**
 * A fake website for the browser tests (14-browser.md › Functional tests), plain HTTP, reached through `dev.upstreams`
 * under any host name. `/set` sets `session=secret123`; `/login` is a form whose password is hashed in page JS before
 * it is posted (so a placeholder in the field cannot work: the login view is the only way in); `/me` says who is signed
 * in; `/echo` puts the request's Cookie header into the page; `/api/token` returns a bearer token in a JSON body that
 * `/api/whoami` accepts. Every request is recorded in `seen`.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const SESSION = "secret123";
export const USER = "owner";
export const PASSWORD = "pw-correct-horse";
export const TOKEN = "tok-secret-0123456789";

/** The same hash the login page computes in JS. */
export const hash = (s: string): string =>
  [...s].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7).toString(16);

export interface Seen {
  method: string;
  host: string;
  path: string;
  cookie: string;
  auth: string;
  body: string;
}

export interface FakeSite {
  url: string;
  seen: Seen[];
  /** the session value `POST /login` issued (absent before a login) */
  auth?: string;
  close(): Promise<void>;
}

const page = (title: string, body: string, script = "") =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

const LOGIN = page(
  "Sign in",
  `<form id="f" method="post" action="/login" style="position:absolute;left:0;top:0;margin:0">
<input id="user" name="user" style="position:absolute;left:100px;top:100px;width:200px;height:30px">
<input id="pw" type="password" style="position:absolute;left:100px;top:150px;width:200px;height:30px">
<input id="hash" name="hash" type="hidden">
<button id="go" style="position:absolute;left:100px;top:200px;width:100px;height:30px">Sign in</button></form>`,
  `const h = (s) => [...s].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7).toString(16);
document.getElementById("f").addEventListener("submit", () => {
  document.getElementById("hash").value = h(document.getElementById("pw").value);
});`,
);

export async function fakeSite(): Promise<FakeSite> {
  const site: FakeSite = { url: "", seen: [], close: async () => {} };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const path = req.url ?? "/";
      const cookie = req.headers.cookie ?? "";
      const auth = req.headers.authorization ?? "";
      site.seen.push({ method: req.method ?? "GET", host: req.headers.host ?? "", path, cookie, auth, body });
      const html = (s: string, headers: Record<string, string | string[]> = {}, status = 200) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
        res.end(s);
      };
      const signedIn = site.auth !== undefined && cookie.split(/;\s*/).includes(`auth=${site.auth}`);
      if (path === "/" || path === "/me")
        return html(
          page(
            signedIn ? `logged in as ${USER}` : "anonymous",
            `<button>Press me</button>`,
            `console.log("hello from fake")`,
          ),
        );
      // one value per site: a value another site's capture already holds would be scrubbed to that one's placeholder
      const value = req.headers.host === "fake.test" ? SESSION : `sess-${req.headers.host}`;
      if (path === "/set") return html(page("set", "cookie set"), { "set-cookie": `session=${value}; Path=/` });
      if (path === "/echo") return html(page("echo", `<pre id="c">${cookie.replace(/</g, "&lt;")}</pre>`));
      if (path === "/login" && req.method === "GET") return html(LOGIN);
      if (path === "/slow") return void setTimeout(() => html(LOGIN), 2000);
      if (path === "/login" && req.method === "POST") {
        const f = new URLSearchParams(body);
        if (f.get("user") !== USER || f.get("hash") !== hash(PASSWORD))
          return html(page("wrong", "wrong password"), {}, 403);
        site.auth = `auth-${Math.random().toString(36).slice(2)}${Date.now()}`;
        return html("", { location: "/me", "set-cookie": `auth=${site.auth}; Path=/; HttpOnly` }, 302);
      }
      if (path === "/logout")
        return html(page("bye", "logged out"), { "set-cookie": "auth=deleted-cookie; Path=/; Max-Age=0" });
      if (path === "/act") return html(page("acted", `acted with ${cookie ? "a cookie" : "nothing"}`));
      if (path === "/api/token") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ token: TOKEN }));
      }
      if (path === "/api/whoami") {
        res.writeHead(auth === `Bearer ${TOKEN}` ? 200 : 401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: auth === `Bearer ${TOKEN}` }));
      }
      html(page("not found", "no such page"), {}, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  site.close = () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return site;
}
