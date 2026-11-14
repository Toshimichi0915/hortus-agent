// One token as `x-api-key: hortus-secret-<name>` or (the SDK's spelling since 1.x) `Authorization: Bearer
// hortus-secret-<name>`; responses are identity.
export function request(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const h = k.toLowerCase();
    headers[k] =
      h === "x-api-key"
        ? v.replace(/^hortus-secret-([a-z0-9_-]+)$/i, "{secret:$1}")
        : h === "authorization"
          ? v.replace(/^Bearer hortus-secret-([a-z0-9_-]+)$/i, "Bearer {secret:$1}")
          : v;
  }
  return { ...req, headers };
}

export function response(res) {
  return { res };
}
