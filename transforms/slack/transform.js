// Slack Web API: the placeholder rides as `Authorization: Bearer hortus-secret-<name>`.
export function request(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers))
    headers[k] =
      k.toLowerCase() === "authorization"
        ? v.replace(/^Bearer hortus-secret-([a-z0-9_-]+)$/i, "Bearer {secret:$1}")
        : v;
  return { ...req, headers };
}

// chat.postMessage → refs `slack:<channel>:<thread_ts ?? ts>`, so replies in that thread route to the task.
export function response(res, req) {
  const out = { res };
  if (!/\/api\/chat\.postMessage(\?|$)/.test(req.url) || !res.body) return out;
  let b;
  try {
    b = JSON.parse(res.body);
  } catch {
    return out;
  }
  if (b?.ok && b.channel && b.ts) out.refs = [`slack:${b.channel}:${b.message?.thread_ts || b.ts}`];
  return out;
}
