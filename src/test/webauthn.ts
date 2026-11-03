/**
 * A software WebAuthn authenticator for tests: one ES256 credential, `fmt: "none"` attestation, a counter that
 * increases per assertion. CBOR is encoded by hand (the few shapes WebAuthn needs).
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

/** CBOR head: major type and argument (0..65535 is enough here). */
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
}

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), v]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

export interface Options {
  /** the RP ID the authenticator signs for (default: the options' rp.id / rpId) */
  rpId?: string;
}

export class SoftAuthenticator {
  readonly id = randomBytes(16);
  private readonly key: KeyObject;
  private readonly cose: Buffer;
  counter = 0;

  constructor(public origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, "base64url")],
        [-3, Buffer.from(jwk.y as string, "base64url")],
      ]),
    );
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  /** `navigator.credentials.create()` + `toJSON()` for the server's creation options. */
  create(o: { challenge: string; rp: { id?: string } }, opts: Options = {}) {
    const rpId = opts.rpId ?? (o.rp.id as string);
    const cred = Buffer.concat([Buffer.alloc(16), Buffer.from([0, this.id.length]), this.id, this.cose]);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([0x45]), Buffer.alloc(4), cred]); // UP | UV | AT
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: b64u(this.id),
      rawId: b64u(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", o.challenge)),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  /** `navigator.credentials.get()` + `toJSON()`; each call bumps the counter. */
  get(o: { challenge: string; rpId?: string }, opts: Options = {}) {
    const rpId = opts.rpId ?? (o.rpId as string);
    this.counter++;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([0x05]), counter]); // UP | UV
    const clientDataJSON = this.clientData("webauthn.get", o.challenge);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.key);
    return {
      id: b64u(this.id),
      rawId: b64u(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: b64u(Buffer.from("owner")),
      },
      clientExtensionResults: {},
    };
  }
}
