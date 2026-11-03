// The browser layer (14-browser.md): runs for every host without a credential transform and for site manifests (a
// manifest with `captures`). Placeholders `hortus-secret-c-<id>` in `Cookie` and `Authorization: Bearer` become
// handles; `Set-Cookie` values (and the body tokens a site's `captures` name) are captured, so the browser only ever
// holds placeholders. The pipeline names the rows `c-<id>`; `name` here is the cookie's or token's own name.

const C = /hortus-secret-(c-[0-9]+)/g;

export function request(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const n = k.toLowerCase();
    headers[k] =
      n === "cookie"
        ? v.replace(C, "{secret:$1}")
        : n === "authorization"
          ? v.replace(/^Bearer hortus-secret-(c-[0-9]+)$/i, "Bearer {secret:$1}")
          : v;
  }
  return { ...req, headers };
}

// ponytail: no public suffix list; the last two labels, three when the second-to-last is a common second-level
// label (example.co.uk). Wrong for shared-tenant suffixes (github.io tenants share an origin); the PSL is the upgrade.
// Same rule as src/browser/jar.ts `registrable` (a test keeps them equal).
const SLD = ["co", "com", "net", "org", "gov", "ac", "edu"];
export function registrable(host) {
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return host;
  const l = host.split(".");
  const n = l.length > 2 && SLD.includes(l[l.length - 2]) ? 3 : 2;
  return l.slice(-n).join(".");
}

const hostOf = (url) => (url.match(/^https?:\/\/([^/:?#]+)/i)?.[1] ?? "").toLowerCase();
const pathOf = (url) => url.match(/^https?:\/\/[^/?#]+([^?#]*)/i)?.[1] || "/";
// values shorter than 8 characters cannot be scrubbed (vault/scrub.ts), so they are not treated as secrets
const worth = (v) => v.length >= 8 && !v.startsWith("hortus-secret-");

function cookie(line) {
  const parts = line.split(";").map((s) => s.trim());
  const first = parts.shift() ?? "";
  const i = first.indexOf("=");
  if (i <= 0) return undefined;
  const meta = { cookieName: first.slice(0, i).trim() };
  for (const p of parts) {
    const j = p.indexOf("=");
    const k = (j < 0 ? p : p.slice(0, j)).toLowerCase();
    const v = j < 0 ? "" : p.slice(j + 1);
    if (k === "domain") meta.domain = v.replace(/^\./, "").toLowerCase();
    else if (k === "path") meta.path = v;
    else if (k === "expires") meta.expires = v;
    else if (k === "max-age") meta.maxAge = Number(v);
    else if (k === "secure") meta.secure = true;
    else if (k === "httponly") meta.httpOnly = true;
    else if (k === "samesite") meta.sameSite = v;
  }
  return { value: first.slice(i + 1).trim(), meta };
}

function dig(o, path) {
  for (const k of path.split(".")) o = o && typeof o === "object" ? o[k] : undefined;
  return typeof o === "string" ? o : undefined;
}

// `site` is the site manifest when there is one: `captures: [{ path: "/api/login", json: "data.token" }]` captures that
// body field as a bearer token (the page keeps the placeholder; it comes back in `Authorization: Bearer`).
export function response(res, req, site) {
  const origin = registrable(hostOf(req.url));
  const capture = [];
  for (const [k, v] of Object.entries(res.headers)) {
    if (k.toLowerCase() !== "set-cookie") continue;
    for (const line of v.split("\n")) {
      const c = cookie(line);
      // a Domain outside the request host's registrable domain is the browser's to reject; never captured
      if (!c || !worth(c.value) || (c.meta.domain && registrable(c.meta.domain) !== origin)) continue;
      capture.push({ name: c.meta.cookieName, value: c.value, origin, kind: "cookie", meta: c.meta });
    }
  }
  const path = pathOf(req.url);
  for (const s of site?.captures ?? []) {
    if (!s || typeof s.json !== "string" || (s.path && s.path !== path) || !res.body) continue;
    let b;
    try {
      b = JSON.parse(res.body);
    } catch {
      continue;
    }
    const v = dig(b, s.json);
    if (v && worth(v)) capture.push({ name: s.json, value: v, origin, kind: "bearer", meta: { key: s.json } });
  }
  return capture.length ? { res, capture } : { res };
}
