/**
 * AWS Signature Version 4 as built-in operations (12-transforms-dof.md): `{sign:aws-sigv4({"name":…,"region":…,
 * "service":…})}` as the `Authorization` value and `{sign:aws-date("<name>")}` for `x-amz-date`. The signature is
 * computed here over the final request, so the secret never enters the sandbox.
 */
import { createHash, createHmac } from "node:crypto";
import type { Secret } from "./ops.ts";

/** The request as it goes upstream; `payload` "stream" → `UNSIGNED-PAYLOAD`. */
export interface Signing {
  method: string;
  /** path as sent, percent-encoded */
  path: string;
  /** query without "?" */
  query: string;
  /** lowercased names, final values */
  headers: Record<string, string>;
  payload: Buffer | string | null | "stream";
}

const sha256 = (s: Buffer | string): string => createHash("sha256").update(s).digest("hex");
const hmac = (k: Buffer | string, s: string): Buffer => createHmac("sha256", k).update(s).digest();

/** RFC 3986 unreserved stays, everything else %XX (AWS's UriEncode). */
const enc = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const dec = (s: string): string => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
};

export const amzDate = (now = Date.now()): string => new Date(now).toISOString().replace(/[-:]|\.\d{3}/g, "");

function credential(s: Secret): { keyId: string; secret: string } {
  if ("captured" in s || s.entry.type !== "aws") throw new Error("aws-sigv4 needs an aws credential");
  return s.entry;
}

/** The canonical request (step 1 of SigV4) and the signed header list. */
export function canonical(req: Signing, service: string): { text: string; signed: string[] } {
  const payloadHash =
    req.headers["x-amz-content-sha256"] ?? (req.payload === "stream" ? "UNSIGNED-PAYLOAD" : sha256(req.payload ?? ""));
  const signed = ["host", "x-amz-content-sha256", "x-amz-date"].filter((h) => req.headers[h] !== undefined);
  // S3 encodes the path once; every other service encodes the already-encoded path again
  const uri = req.path
    .split("/")
    .map((seg) => (service === "s3" ? enc(dec(seg)) : enc(enc(dec(seg)))))
    .join("/");
  const query = req.query
    .split("&")
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf("=");
      return [enc(dec(i < 0 ? kv : kv.slice(0, i))), i < 0 ? "" : enc(dec(kv.slice(i + 1)))] as const;
    })
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const text = [
    req.method.toUpperCase(),
    uri || "/",
    query,
    ...signed.map((h) => `${h}:${(req.headers[h] ?? "").trim().replace(/\s+/g, " ")}`),
    "",
    signed.join(";"),
    payloadHash,
  ].join("\n");
  return { text, signed };
}

export function sigv4(s: Secret, args: unknown[], req?: Signing): string {
  if (!req) throw new Error("aws-sigv4 signs the final request");
  const { region, service } = (args[0] ?? {}) as { region?: unknown; service?: unknown };
  if (typeof region !== "string" || typeof service !== "string")
    throw new Error("aws-sigv4 needs {name, region, service}");
  const { keyId, secret } = credential(s);
  const date = req.headers["x-amz-date"];
  if (!date || !/^\d{8}T\d{6}Z$/.test(date)) throw new Error("aws-sigv4 needs an x-amz-date header");
  const { text, signed } = canonical(req, service);
  const scope = `${date.slice(0, 8)}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256(text)].join("\n");
  let key = hmac(`AWS4${secret}`, date.slice(0, 8));
  for (const part of [region, service, "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`;
}

/** The current time as `x-amz-date`; the credential argument only ties the header to the manifest's locations. */
export function awsDate(s: Secret): string {
  credential(s);
  return amzDate();
}
