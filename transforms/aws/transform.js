// AWS SigV4. The Worker signs with access key id `hortus-secret-<name>` and any secret key (the aws CLI works as is),
// or sends `Authorization: Bearer hortus-secret-<name>` (region and service from the host). The template asks the
// runtime to re-sign the final request with the real key (`aws-sigv4`) at the time it is sent (`aws-date`).
const CRED = /Credential=hortus-secret-([a-z0-9_-]+)\/\d{8}\/([a-z0-9-]+)\/([a-z0-9-]+)\/aws4_request/;
const BEARER = /^Bearer hortus-secret-([a-z0-9_-]+)$/;

function fromHost(url) {
  const host = (url.match(/^https?:\/\/([^/:?#]+)/) || [])[1] || "";
  const parts = host.split(".");
  // <service>.<region>.amazonaws.com or <service>.amazonaws.com (global: us-east-1)
  return { region: parts.length === 4 ? parts[1] : "us-east-1", service: parts[0] };
}

export function request(req) {
  let sig;
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() !== "authorization") continue;
    const m = v.match(CRED);
    const b = v.match(BEARER);
    if (m) sig = { name: m[1], region: m[2], service: m[3] };
    else if (b) sig = { name: b[1], ...fromHost(req.url) };
  }
  if (!sig) return req;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (key !== "authorization" && key !== "x-amz-date") headers[k] = v;
  }
  headers.authorization = `{sign:aws-sigv4(${JSON.stringify(sig)})}`;
  headers["x-amz-date"] = `{sign:aws-date(${JSON.stringify(sig.name)})}`;
  return { ...req, headers };
}

export function response(res) {
  return { res };
}
