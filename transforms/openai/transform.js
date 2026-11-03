// One token as `Authorization: Bearer hortus-secret-<name>`; responses are identity.
export function request(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers))
    headers[k] =
      k.toLowerCase() === "authorization"
        ? v.replace(/^Bearer hortus-secret-([a-z0-9_-]+)$/i, "Bearer {secret:$1}")
        : v;
  return { ...req, headers };
}

export function response(res) {
  return { res };
}
