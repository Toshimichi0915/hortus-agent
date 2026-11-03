// One token as `x-api-key: hortus-secret-<name>`; responses are identity.
export function request(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers))
    headers[k] = k.toLowerCase() === "x-api-key" ? v.replace(/^hortus-secret-([a-z0-9_-]+)$/i, "{secret:$1}") : v;
  return { ...req, headers };
}

export function response(res) {
  return { res };
}
