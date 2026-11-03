// GitHub (17-github.md): the placeholder `hortus-secret-<name>` rides as `Authorization: Bearer|token …` (REST) or as
// the Basic password (git over HTTPS, through insteadOf); both become an installation token hortusd mints for the
// caller's repos. The delivery log (`GET /app/hook/deliveries`) is the one App-JWT endpoint.
const PH = /^hortus-secret-([a-z0-9][a-z0-9_-]*)$/;
const CREATE = /^\/(user|orgs\/[^/]+)\/repos$/;

/** The path without the query and without GitHub Enterprise's `/api/v3` prefix. */
function path(url) {
  const m = url.match(/^https?:\/\/[^/]+(\/[^?#]*)?/);
  return (m?.[1] || "/").replace(/^\/api\/v3(?=\/)/, "");
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function unbase64(s) {
  let bits = 0;
  let n = 0;
  let out = "";
  for (const c of s.replace(/=+$/, "")) {
    const v = B64.indexOf(c);
    if (v < 0) return null;
    bits = ((bits << 6) | v) & 0xffffff;
    n += 6;
    if (n >= 8) {
      n -= 8;
      out += String.fromCharCode((bits >> n) & 255);
    }
  }
  return out;
}

const sign = (op, args) => `{sign:${op}(${JSON.stringify(args)})}`;

function auth(v, p, method) {
  const bearer = v.match(/^(?:Bearer|token)\s+(\S+)$/i);
  if (bearer) {
    const n = bearer[1].match(PH);
    if (!n) return v;
    if (method === "GET" && /^\/app\/hook\/deliveries(\/\d+)?$/.test(p))
      return `Bearer ${sign("app-jwt", { name: n[1] })}`;
    const admin = method === "POST" && CREATE.test(p);
    return `Bearer ${sign("installation-token", admin ? { name: n[1], admin: true } : { name: n[1] })}`;
  }
  const basic = v.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  const dec = basic && unbase64(basic[1]);
  const i = dec ? dec.indexOf(":") : -1;
  const n = i >= 0 && dec.slice(i + 1).match(PH);
  return n ? `Basic ${sign("installation-token", { name: n[1], basic: dec.slice(0, i) })}` : v;
}

export function request(req) {
  const p = path(req.url);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers))
    headers[k] = k.toLowerCase() === "authorization" ? auth(v, p, req.method) : v;
  return { ...req, headers };
}

// Created issues, PRs, comments and reviews → refs `github:<o/r>:#n|!n` (from `html_url`); a created repository →
// `repos`, which the proxy adds to the task's scope only after an approved request.
export function response(res, req) {
  const out = { res };
  if (req.method !== "POST" || res.status < 200 || res.status >= 300 || !res.body) return out;
  let b;
  try {
    b = JSON.parse(res.body);
  } catch {
    return out;
  }
  if (!b || typeof b !== "object") return out;
  const p = path(req.url);
  if (CREATE.test(p) && typeof b.full_name === "string") out.repos = [`github:${b.full_name}`];
  const m =
    typeof b.html_url === "string" && b.html_url.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)/);
  if (m && p.startsWith("/repos/")) out.refs = [`github:${m[1]}:${m[2] === "pull" ? "!" : "#"}${m[3]}`];
  return out;
}

// What the owner reads on the Approvals page: a push's ref updates, a PR's title and branches, a DELETE's path.
export function render(t) {
  const p = path(t.url);
  const push = p.match(/^\/(.+?)(?:\.git)?\/git-receive-pack$/);
  if (push && t.body !== null) {
    const lines = [];
    const b = t.body;
    for (let i = 0; i + 4 <= b.length; ) {
      const n = Number.parseInt(b.slice(i, i + 4), 16);
      if (!n || n < 4) break;
      const [old = "", next = "", ref = ""] = b
        .slice(i + 4, i + n)
        .split("\0")[0]
        .trim()
        .split(" ");
      lines.push(`push ${push[1]}: ${old.slice(0, 7)} → ${next.slice(0, 7)} ${ref}`);
      i += n;
    }
    return lines.join("\n");
  }
  const pr = p.match(/^\/repos\/([^/]+\/[^/]+)\/pulls$/);
  if (pr && t.method === "POST" && t.body) {
    try {
      const b = JSON.parse(t.body);
      return `open PR ${pr[1]}: "${b.title}" ${b.head} → ${b.base}`;
    } catch {
      return undefined;
    }
  }
  if (t.method === "DELETE") return `DELETE ${p}`;
  return undefined;
}
