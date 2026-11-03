// Bitbucket Cloud (18-gitlab-bitbucket.md): a static repository access token. The placeholder `hortus-secret-<name>`
// rides as `Authorization: Bearer …` (REST) and as the Basic password (git over HTTPS, through insteadOf); the user
// git sends is replaced by `x-token-auth`, the one Bitbucket requires for access tokens.
const PH = /^hortus-secret-([a-z0-9][a-z0-9_-]*)$/;

/** The path without the query. */
function path(url) {
  const m = url.match(/^https?:\/\/[^/]+(\/[^?#]*)?/);
  return m?.[1] || "/";
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

function auth(v) {
  const bearer = v.match(/^Bearer\s+(\S+)$/i);
  const b = bearer?.[1].match(PH);
  if (b) return `Bearer {secret:${b[1]}}`;
  const basic = v.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  const dec = basic && unbase64(basic[1]);
  const i = dec ? dec.indexOf(":") : -1;
  const n = i >= 0 && dec.slice(i + 1).match(PH);
  return n ? `Basic {basic:x-token-auth:${n[1]}}` : v;
}

export function request(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = k.toLowerCase() === "authorization" ? auth(v) : v;
  return { ...req, headers };
}

const API = /^\/2\.0\/repositories\/([^/]+\/[^/]+)(?:\/(issues|pullrequests)(?:\/(\d+)\/comments)?)?\/?$/;

// Created issues, PRs and comments → refs `bitbucket:<w/r>:#id|!id`; a created repository → `repos`, which the proxy
// adds to the task's scope only after an approved request.
export function response(res, req) {
  const out = { res };
  if (req.method !== "POST" || res.status < 200 || res.status >= 300 || !res.body) return out;
  let b;
  try {
    b = JSON.parse(res.body);
  } catch {
    return out;
  }
  const m = path(req.url).match(API);
  if (!m || !b || typeof b !== "object") return out;
  if (!m[2]) {
    if (typeof b.full_name === "string") out.repos = [`bitbucket:${b.full_name}`];
    return out;
  }
  const id = m[3] ?? b.id;
  if (id !== undefined) out.refs = [`bitbucket:${m[1]}:${m[2] === "issues" ? "#" : "!"}${id}`];
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
  const pr = p.match(/^\/2\.0\/repositories\/([^/]+\/[^/]+)\/pullrequests\/?$/);
  if (pr && t.method === "POST" && t.body) {
    try {
      const b = JSON.parse(t.body);
      return `open PR ${pr[1]}: "${b.title}" ${b.source?.branch?.name} → ${b.destination?.branch?.name ?? "main"}`;
    } catch {
      return undefined;
    }
  }
  const repo = p.match(/^\/2\.0\/repositories\/([^/]+\/[^/]+)\/?$/);
  if (repo && t.method === "POST") {
    let priv = true;
    try {
      priv = JSON.parse(t.body || "{}").is_private !== false;
    } catch {}
    return `create repository ${repo[1]} (${priv ? "private" : "public"})`;
  }
  if (t.method === "DELETE") return `DELETE ${p}`;
  return undefined;
}
