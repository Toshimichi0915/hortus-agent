// Discord: REST carries `Authorization: Bot hortus-secret-<name>`; gateway frames (method "WS", the frame as body)
// carry the placeholder only as the token of IDENTIFY (op 2) or RESUME (op 6). Anywhere else it stays unmapped and the
// proxy refuses it, so a placeholder cannot be published in, say, a presence status.
export function request(req) {
  if (req.method === "WS") {
    let f;
    try {
      f = JSON.parse(req.body);
    } catch {
      return req;
    }
    const m = (f?.op === 2 || f?.op === 6) && /^hortus-secret-([a-z0-9_-]+)$/.exec(f.d?.token ?? "");
    if (!m) return req;
    f.d.token = `{secret:${m[1]}}`;
    return { ...req, body: JSON.stringify(f) };
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers))
    headers[k] =
      k.toLowerCase() === "authorization" ? v.replace(/^Bot hortus-secret-([a-z0-9_-]+)$/, "Bot {secret:$1}") : v;
  return { ...req, headers };
}

// A created message → refs `discord:<channel>:<id>` (a plain channel: thread = message) and
// `discord:<channel>:<channel>` (a thread channel: messages in it carry that ref too). A created thread →
// `discord:<parent>:<thread>`.
export function response(res, req) {
  const out = { res };
  if (req.method !== "POST" || res.status >= 300 || !res.body) return out;
  let b;
  try {
    b = JSON.parse(res.body);
  } catch {
    return out;
  }
  if (/\/channels\/\d+\/messages(\?|$)/.test(req.url) && b?.id && b.channel_id)
    out.refs = [`discord:${b.channel_id}:${b.id}`, `discord:${b.channel_id}:${b.channel_id}`];
  else if (/\/channels\/\d+\/(messages\/\d+\/)?threads(\?|$)/.test(req.url) && b?.id && b.parent_id)
    out.refs = [`discord:${b.parent_id}:${b.id}`];
  return out;
}
