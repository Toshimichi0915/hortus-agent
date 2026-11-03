import assert from "node:assert/strict";
import { test } from "node:test";
import { handles, resolveHandle } from "./ops.ts";
import { canonical, sigv4 } from "./sigv4.ts";

// AWS SigV4 test suite (aws-sig-v4-test-suite): get-vanilla and get-vanilla-query-order-key-case
const KEY = {
  entry: { type: "aws" as const, keyId: "AKIDEXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
};
const ARGS = [{ name: "aws", region: "us-east-1", service: "service" }];
const headers = { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" };

test("aws-sigv4: AWS's get-vanilla vector", () => {
  assert.equal(
    sigv4(KEY, ARGS, { method: "GET", path: "/", query: "", headers, payload: null }),
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

test("aws-sigv4: AWS's get-vanilla-query-order-key-case vector (query sorted)", () => {
  const r = sigv4(KEY, ARGS, {
    method: "GET",
    path: "/",
    query: "Param2=value2&Param1=value1",
    headers,
    payload: null,
  });
  assert.match(r, /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/);
});

test("aws-sigv4: a streamed body signs UNSIGNED-PAYLOAD; x-amz-content-sha256 is signed when present", () => {
  const c = canonical({ method: "PUT", path: "/b/k", query: "", headers, payload: "stream" }, "s3");
  assert.ok(c.text.endsWith("\nhost;x-amz-date\nUNSIGNED-PAYLOAD"));
  const h = { ...headers, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" };
  assert.deepEqual(canonical({ method: "PUT", path: "/b/k", query: "", headers: h, payload: "stream" }, "s3").signed, [
    "host",
    "x-amz-content-sha256",
    "x-amz-date",
  ]);
});

test("aws-sigv4 handle: the object form names the credential; only an aws credential signs", () => {
  const [h] = handles('{sign:aws-sigv4({"name":"aws","region":"us-east-1","service":"service"})}');
  assert.equal(h?.name, "aws");
  assert.ok(h);
  // the first pass (no request yet) leaves the handle for the late pass
  assert.equal(resolveHandle(h, KEY), h.text);
  assert.match(
    resolveHandle(h, KEY, { method: "GET", path: "/", query: "", headers, payload: null }),
    /Signature=5fa00fa3/,
  );
  assert.throws(() =>
    resolveHandle(
      h,
      { entry: { type: "token", value: "x" } },
      { method: "GET", path: "/", query: "", headers, payload: null },
    ),
  );
  const [d] = handles('{sign:aws-date("aws")}');
  assert.ok(d);
  assert.match(resolveHandle(d, KEY), /^\d{8}T\d{6}Z$/);
});
