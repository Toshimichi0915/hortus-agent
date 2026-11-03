// GitLab (18-gitlab-bitbucket.md): a static project/group access token. The placeholder `hortus-secret-<name>` rides
// in `PRIVATE-TOKEN` or as `Authorization: Bearer …` (REST) and as the Basic password (git over HTTPS, through
// insteadOf); the user git sends is replaced by `oauth2`, which GitLab accepts for every token kind.
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
  return n ? `Basic {basic:oauth2:${n[1]}}` : v;
}

export function request(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (key === "authorization") headers[k] = auth(v);
    else if (key === "private-token") headers[k] = v.replace(PH, "{secret:$1}");
    else headers[k] = v;
  }
  return { ...req, headers };
}

const API = /^\/api\/v4\/projects(?:\/([^/]+)(?:\/(issues|merge_requests)(?:\/(\d+)\/notes)?)?)?$/;

// Created issues, MRs and notes → refs `gitlab:<group/…/project>:#iid|!iid`; a created project → `repos`, which the
// proxy adds to the task's scope only after an approved request.
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
  if (!m[1]) {
    if (typeof b.path_with_namespace === "string") out.repos = [`gitlab:${b.path_with_namespace}`];
    return out;
  }
  const iid = m[3] ?? b.iid;
  if (m[2] && iid !== undefined)
    out.refs = [`gitlab:${decodeURIComponent(m[1])}:${m[2] === "issues" ? "#" : "!"}${iid}`];
  return out;
}

// What the owner reads on the Approvals page: a push's ref updates, an MR's title and branches, a DELETE's path.
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
  const mr = p.match(/^\/api\/v4\/projects\/([^/]+)\/merge_requests$/);
  if (mr && t.method === "POST" && t.body) {
    try {
      const b = JSON.parse(t.body);
      return `open MR ${decodeURIComponent(mr[1])}: "${b.title}" ${b.source_branch} → ${b.target_branch}`;
    } catch {
      return undefined;
    }
  }
  if (p === "/api/v4/projects" && t.method === "POST" && t.body) {
    try {
      const b = JSON.parse(t.body);
      return `create project ${b.namespace_id ?? ""}/${b.path ?? b.name} (${b.visibility ?? "private"})`;
    } catch {
      return undefined;
    }
  }
  if (t.method === "DELETE") return `DELETE ${decodeURIComponent(p)}`;
  return undefined;
}
