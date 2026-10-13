import type { JsonWebKeyLike } from "../core/subject.ts";
import type { Instant } from "../core/time.ts";
import type { ReplayStore } from "../ssf/types.ts";

import { nowSeconds, rfc3339 } from "../core/time.ts";

/** The three Standard Webhooks headers a delivery carries. */
export type WebhookHeaders = {
  readonly "webhook-id": string;
  readonly "webhook-timestamp": string;
  readonly "webhook-signature": string;
};

/** An OKP JWK; only `kty: "OKP"` with `crv: "Ed25519"` signs or verifies `v1a`. */
export type WebhookJwk = JsonWebKeyLike & {
  readonly kid?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly d?: string;
};

/** A Standard Webhooks signature version: `v1` HMAC-SHA256 or `v1a` Ed25519. */
export type WebhookAlgorithm = "v1" | "v1a";

export type WebhookSigningKey =
  /** `whsec_` followed by 24 to 64 bytes in base64. */
  | { readonly alg: "v1"; readonly secret: string }
  /** An Ed25519 private JWK (`kty: "OKP"`, `crv: "Ed25519"`, with `d`). */
  | { readonly alg: "v1a"; readonly privateKey: WebhookJwk };

export type WebhookSignerOptions = {
  /** Every key signs each delivery, so a receiver can rotate between them. */
  readonly keys: readonly WebhookSigningKey[];
};

export type WebhookMessage = {
  /** A unique message id, kept across retries of the same message. */
  readonly id: string;
  readonly body: string;
  readonly now?: Instant;
};

export type WebhookSigner = {
  sign(message: WebhookMessage): Promise<WebhookHeaders>;
};

/** An Ed25519 public JWK set for `v1a`, or the URL that serves one. */
export type WebhookJwks =
  | { readonly keys: readonly WebhookJwk[] }
  | URL
  | string;

export type WebhookVerifierOptions = {
  /** `v1` secrets in `whsec_` form; more than one during a rotation. */
  readonly secret?: string | readonly string[];
  /** `v1a` public keys. */
  readonly jwks?: WebhookJwks;
  /** Records each `webhook-id` so a replayed delivery fails. */
  readonly replay: ReplayStore;
  /** Seconds a timestamp may differ from the clock. Defaults to 300. */
  readonly tolerance?: number;
  readonly now?: () => Instant;
  /** Fetches a `jwks` URL. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
};

export type WebhookFailureCause =
  | "missing-headers"
  | "malformed"
  | "timestamp-out-of-range"
  | "invalid-signature"
  | "keys-unavailable"
  | "replayed";

export type WebhookInput =
  | Request
  | {
      readonly headers: Headers | Readonly<Record<string, string | undefined>>;
      readonly body: string;
    };

export type VerifiedWebhookMessage =
  | {
      readonly ok: true;
      readonly id: string;
      /** The `webhook-timestamp` as an RFC 3339 instant. */
      readonly timestamp: string;
      readonly body: string;
    }
  | { readonly ok: false; readonly cause: WebhookFailureCause };

export type WebhookVerifier = {
  /** Never throws; claims the `webhook-id` only after a signature verifies. */
  verify(input: WebhookInput): Promise<VerifiedWebhookMessage>;
};

const DEFAULT_TOLERANCE = 300;
const JWKS_TTL_SECONDS = 300;
const encoder = new TextEncoder();

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    return undefined;
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.codePointAt(index) ?? 0;
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function encodeBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const bytes = decodeBase64(
    secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
  );
  if (bytes === undefined || bytes.length < 24 || bytes.length > 64) {
    throw new TypeError(
      "PermDock: a v1 webhook secret is whsec_ followed by 24 to 64 bytes in base64",
    );
  }
  return bytes;
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    secretBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function isEd25519(jwk: WebhookJwk): boolean {
  return (
    jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string"
  );
}

function signedContent(
  id: string,
  timestamp: string,
  body: string,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${id}.${timestamp}.${body}`);
}

function validId(id: string): boolean {
  return id.length > 0 && id.length <= 256 && !/\s/u.test(id);
}

/**
 * Signs Standard Webhooks deliveries: `v1` HMAC-SHA256 with a `whsec_`
 * secret, `v1a` Ed25519 with a private JWK. Throws on an invalid key or id,
 * because both come from the sender's own configuration.
 */
export function webhookSigner(options: WebhookSignerOptions): WebhookSigner {
  if (options.keys.length === 0) {
    throw new TypeError("PermDock: webhookSigner() needs at least one key");
  }
  const keys = options.keys.map(async (key) => {
    switch (key.alg) {
      case "v1":
        return { alg: key.alg, key: await hmacKey(key.secret, "sign") };
      case "v1a": {
        if (
          !isEd25519(key.privateKey) ||
          typeof key.privateKey.d !== "string"
        ) {
          throw new TypeError(
            "PermDock: a v1a webhook key is an Ed25519 private JWK",
          );
        }
        return {
          alg: key.alg,
          key: await importEd25519(key.privateKey, "sign"),
        };
      }
      default: {
        const exhaustive: never = key;
        return exhaustive;
      }
    }
  });
  for (const pending of keys) {
    pending.catch(() => undefined);
  }
  return {
    async sign(message) {
      if (!validId(message.id)) {
        throw new TypeError(
          "PermDock: a webhook id is 1 to 256 characters without whitespace",
        );
      }
      const timestamp = String(nowSeconds(message.now));
      const content = signedContent(message.id, timestamp, message.body);
      const signatures = await Promise.all(
        keys.map(async (pending) => {
          const { alg, key } = await pending;
          const signature = await crypto.subtle.sign(
            alg === "v1" ? "HMAC" : "Ed25519",
            key,
            content,
          );
          return `${alg},${encodeBase64(signature)}`;
        }),
      );
      return {
        "webhook-id": message.id,
        "webhook-timestamp": timestamp,
        "webhook-signature": signatures.join(" "),
      };
    },
  };
}

function header(input: WebhookInput, name: string): string | undefined {
  const headers = input.headers;
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  return Object.hasOwn(headers, name) ? headers[name] : undefined;
}

async function bodyOf(input: WebhookInput): Promise<string | undefined> {
  if (input instanceof Request) {
    try {
      return await input.text();
    } catch {
      return undefined;
    }
  }
  return input.body;
}

type Signature = {
  readonly alg: WebhookAlgorithm;
  readonly bytes: Uint8Array<ArrayBuffer>;
};

function parseSignatures(value: string): readonly Signature[] {
  const parsed: Signature[] = [];
  for (const entry of value.split(" ")) {
    const comma = entry.indexOf(",");
    const alg = entry.slice(0, comma);
    if (comma <= 0 || (alg !== "v1" && alg !== "v1a")) {
      continue;
    }
    const bytes = decodeBase64(entry.slice(comma + 1));
    if (bytes?.length === (alg === "v1" ? 32 : 64)) {
      parsed.push({ alg, bytes });
    }
  }
  return parsed;
}

function importEd25519(
  jwk: WebhookJwk,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  const material =
    usage === "sign"
      ? { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }
      : { kty: "OKP", crv: "Ed25519", x: jwk.x };
  // SAFETY: material is an OKP JWK; importKey rejects a malformed one.
  return crypto.subtle.importKey("jwk", material as never, "Ed25519", false, [
    usage,
  ]);
}

async function publicKeys(jwks: {
  readonly keys: readonly WebhookJwk[];
}): Promise<readonly CryptoKey[]> {
  const imported = await Promise.all(
    jwks.keys
      .filter(isEd25519)
      .map((jwk) => importEd25519(jwk, "verify").catch(() => undefined)),
  );
  return imported.filter((key) => key !== undefined);
}

async function anyVerifies(
  algorithm: "HMAC" | "Ed25519",
  keys: readonly CryptoKey[],
  signatures: readonly Signature[],
  content: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const results = await Promise.all(
    keys.flatMap((key) =>
      signatures.map((signature) =>
        crypto.subtle.verify(algorithm, key, signature.bytes, content),
      ),
    ),
  );
  return results.includes(true);
}

function isJwks(
  value: unknown,
): value is { readonly keys: readonly WebhookJwk[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "keys" in value &&
    Array.isArray(value.keys)
  );
}

/**
 * Verifies Standard Webhooks deliveries signed `v1` with one of `secret` or
 * `v1a` with a key from `jwks`, within `tolerance` seconds, and records each
 * `webhook-id` in `replay`. Throws only on an invalid `secret`.
 */
export function webhookVerifier(
  options: WebhookVerifierOptions,
): WebhookVerifier {
  const secrets =
    options.secret === undefined
      ? []
      : typeof options.secret === "string"
        ? [options.secret]
        : options.secret;
  for (const secret of secrets) {
    secretBytes(secret);
  }
  const hmacKeys = Promise.all(
    secrets.map((secret) => hmacKey(secret, "verify")),
  );
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const jwks = options.jwks;
  let cached:
    | { readonly keys: readonly CryptoKey[]; readonly until: number }
    | undefined;

  async function ed25519Keys(
    now: number,
  ): Promise<readonly CryptoKey[] | undefined> {
    if (jwks === undefined) {
      return [];
    }
    if (isJwks(jwks)) {
      cached ??= {
        keys: await publicKeys(jwks),
        until: Number.POSITIVE_INFINITY,
      };
      return cached.keys;
    }
    if (cached !== undefined && cached.until > now) {
      return cached.keys;
    }
    try {
      const response = await (options.fetch ?? fetch)(String(jwks), {
        headers: { accept: "application/jwk-set+json, application/json" },
      });
      const parsed: unknown = response.ok ? await response.json() : undefined;
      if (!isJwks(parsed)) {
        return undefined;
      }
      cached = {
        keys: await publicKeys(parsed),
        until: now + JWKS_TTL_SECONDS,
      };
      return cached.keys;
    } catch {
      return undefined;
    }
  }

  async function signatureValid(
    signatures: readonly Signature[],
    content: Uint8Array<ArrayBuffer>,
    now: number,
  ): Promise<WebhookFailureCause | undefined> {
    const v1 = signatures.filter((signature) => signature.alg === "v1");
    const v1a = signatures.filter((signature) => signature.alg === "v1a");
    if (
      v1.length > 0 &&
      (await anyVerifies("HMAC", await hmacKeys, v1, content))
    ) {
      return undefined;
    }
    if (v1a.length === 0) {
      return "invalid-signature";
    }
    const keys = await ed25519Keys(now);
    if (keys === undefined) {
      return "keys-unavailable";
    }
    if (await anyVerifies("Ed25519", keys, v1a, content)) {
      return undefined;
    }
    return "invalid-signature";
  }

  async function claim(id: string, expiresAt: number): Promise<boolean> {
    const key = `webhook:${id}`;
    try {
      if (options.replay.claim !== undefined) {
        return await options.replay.claim(key, expiresAt);
      }
      if (await options.replay.seen(key)) {
        return false;
      }
      await options.replay.remember(key, expiresAt);
      return true;
    } catch {
      return false;
    }
  }

  return {
    async verify(input) {
      const id = header(input, "webhook-id");
      const timestamp = header(input, "webhook-timestamp");
      const signature = header(input, "webhook-signature");
      if (
        id === undefined ||
        timestamp === undefined ||
        signature === undefined
      ) {
        return { ok: false, cause: "missing-headers" };
      }
      const body = await bodyOf(input);
      const signatures = parseSignatures(signature);
      if (
        body === undefined ||
        !validId(id) ||
        !/^\d{1,12}$/u.test(timestamp) ||
        signatures.length === 0
      ) {
        return { ok: false, cause: "malformed" };
      }
      const now = nowSeconds(options.now?.());
      const sent = Number(timestamp);
      if (Math.abs(now - sent) > tolerance) {
        return { ok: false, cause: "timestamp-out-of-range" };
      }
      let failure: WebhookFailureCause | undefined;
      try {
        failure = await signatureValid(
          signatures,
          signedContent(id, timestamp, body),
          now,
        );
      } catch {
        failure = "invalid-signature";
      }
      if (failure !== undefined) {
        return { ok: false, cause: failure };
      }
      if (!(await claim(id, sent + tolerance))) {
        return { ok: false, cause: "replayed" };
      }
      return {
        ok: true,
        id,
        timestamp: rfc3339(sent),
        body,
      };
    },
  };
}
