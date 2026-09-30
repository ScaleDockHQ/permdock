import type { Credential, CredentialPrincipal } from '../core/credential.ts';
import type {
  AuthEvent,
  CredentialVerifier,
  DecisionSink,
  SettingsSource,
  SubjectResolver,
} from '../core/interfaces.ts';
import type { PermissionTree } from '../core/permissions.ts';
import type { Principal, Subject } from '../core/subject.ts';

import { compact } from '../core/compact.ts';
import {
  credentialPolicyViolation,
  credentialSubject,
  credentialTenant,
  parseCredential,
} from '../core/credential.ts';
import { bytesToBase64Url } from '../core/sha256.ts';
import { credentialEvent } from '../core/sink.ts';
import { anonymousSubject } from '../core/subject.ts';
import { isThenable } from '../core/thenable.ts';

const PREFIX = 'pdk_';
const ID = /^[\w-]{1,128}$/u;
const TAIL = /^[A-Za-z\d]{49}$/u;
const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SECRET_LENGTH = 43;
const CHECKSUM_LENGTH = 6;
const MAX_KEY = PREFIX.length + 128 + 1 + SECRET_LENGTH + CHECKSUM_LENGTH;

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3) of the key's ASCII bytes, as 6 base62 characters. */
function checksum(text: string): string {
  let crc = 0xff_ff_ff_ff;
  for (let index = 0; index < text.length; index += 1) {
    crc =
      (CRC_TABLE[(crc ^ (text.codePointAt(index) ?? 0)) & 0xff] ?? 0) ^
      (crc >>> 8);
  }
  let value = (crc ^ 0xff_ff_ff_ff) >>> 0;
  let out = '';
  for (let index = 0; index < CHECKSUM_LENGTH; index += 1) {
    out = (ALPHABET[value % 62] ?? '') + out;
    value = Math.floor(value / 62);
  }
  return out;
}

/** `on('auth')` causes for an API key that resolves to the anonymous subject. */
export type ApiKeyFailureCause =
  | 'malformed'
  | 'unknown-credential'
  | 'invalid-claims'
  | 'expired'
  | 'credential-policy'
  | 'credential-revoked'
  | 'owner-unavailable';

/** An opaque key split at its last `_`: `pdk_<id>_<secret><checksum>`. */
export type ApiKeyParts = {
  readonly id: string;
  readonly secret: string;
};

/** What an application stores per key: the credential and the key's hash, never the key. */
export type StoredCredential = {
  readonly credential: Credential;
  readonly hash: string;
};

/**
 * Splits `pdk_<id>_<secret><checksum>`: `id` is 1 to 128 of `A-Z a-z 0-9 _ -`,
 * the secret 43 base62 characters and the checksum the 6 base62 characters of
 * the CRC-32 of everything before it. Anything else, including a checksum
 * that does not match, is `undefined`.
 */
export function parseApiKey(key: unknown): ApiKeyParts | undefined {
  if (
    typeof key !== 'string' ||
    key.length > MAX_KEY ||
    !key.startsWith(PREFIX)
  ) {
    return undefined;
  }
  const body = key.slice(PREFIX.length);
  const cut = body.lastIndexOf('_');
  if (cut <= 0) {
    return undefined;
  }
  const id = body.slice(0, cut);
  const tail = body.slice(cut + 1);
  if (!ID.test(id) || !TAIL.test(tail)) {
    return undefined;
  }
  const secret = tail.slice(0, SECRET_LENGTH);
  return tail.slice(SECRET_LENGTH) === checksum(`${PREFIX}${id}_${secret}`)
    ? { id, secret }
    : undefined;
}

/**
 * A fresh `pdk_<id>_<secret><checksum>`: a 43-character base62 secret (about
 * 256 bits) and a 6-character CRC-32 checksum, so a secret scanner can tell a
 * real key from a lookalike without calling the issuer.
 */
export function generateApiKey(id: string): string {
  if (!ID.test(id)) {
    throw new TypeError(
      'PermDock: an API key id is 1 to 128 of A-Z, a-z, 0-9, _ and -',
    );
  }
  let secret = '';
  const bytes = new Uint8Array(64);
  while (secret.length < SECRET_LENGTH) {
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // 248 = 4 * 62: rejecting the rest keeps every character equally likely.
      if (byte < 248 && secret.length < SECRET_LENGTH) {
        secret += ALPHABET[byte % 62];
      }
    }
  }
  const key = `${PREFIX}${id}_${secret}`;
  return `${key}${checksum(key)}`;
}

/** base64url SHA-256 of the whole key, the value to store and compare. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(key),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

function sameHash(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |=
      (left.codePointAt(index) ?? 0) ^ (right.codePointAt(index) ?? 0);
  }
  return difference === 0;
}

/**
 * A `CredentialVerifier` over the application's own table: `find` looks a
 * key up by the id in it, and the key's hash is compared in constant time.
 * A record that is not a valid v1 credential, or whose id is not the key's,
 * verifies to `null`. A throwing `find` propagates, so the resolver denies
 * with `source-threw`.
 */
export function apiKeyVerifier(options: {
  readonly find: (
    id: string,
  ) =>
    | StoredCredential
    | null
    | undefined
    | Promise<StoredCredential | null | undefined>;
  /** Passed through as the verifier's `touch`, for a `lastUsedAt` column. */
  readonly touch?: CredentialVerifier['touch'];
}): CredentialVerifier {
  return Object.freeze({
    ...(options.touch === undefined ? {} : { touch: options.touch }),
    async verify(secret: string): Promise<Credential | null> {
      const parts = parseApiKey(secret);
      if (parts === undefined) {
        return null;
      }
      const stored = await options.find(parts.id);
      if (stored === null || stored === undefined) {
        return null;
      }
      const credential = parseCredential(stored.credential);
      if (
        credential === undefined ||
        credential.id !== parts.id ||
        typeof stored.hash !== 'string' ||
        !sameHash(await hashApiKey(secret), stored.hash)
      ) {
        return null;
      }
      return credential;
    },
  });
}

export type MemoryCredentials = CredentialVerifier & {
  /** Stores `credential` and returns its key; the key is never stored. */
  issue(credential: Credential): Promise<string>;
  /** A new secret for the same id; the old key stops verifying at once. */
  rotate(id: string): Promise<string | undefined>;
  /** `true` when a credential was removed. */
  revoke(id: string): boolean;
  list(): readonly Credential[];
  /** When `touch` last recorded a use of `id`, in Unix seconds. */
  lastUsedAt(id: string): number | undefined;
};

function write(
  sink: DecisionSink,
  event: Parameters<DecisionSink['write']>[0],
): void {
  try {
    const written = sink.write(event);
    if (isThenable(written)) {
      void Promise.resolve(written).catch(() => undefined);
    }
  } catch {
    // a sink never influences a store or an outcome
  }
}

/**
 * In-process credentials for tests and single-replica apps. `issue`, `rotate`
 * and `revoke` write `credential` events to `sink` when one is given.
 */
export function memoryCredentials(
  options: { readonly sink?: DecisionSink; readonly source?: string } = {},
): MemoryCredentials {
  const records = new Map<string, StoredCredential>();
  const used = new Map<string, number>();
  const verifier = apiKeyVerifier({ find: (id) => records.get(id) });
  const emit = (
    operation: 'created' | 'rotated' | 'revoked',
    credential: Credential,
  ): void => {
    if (options.sink !== undefined) {
      write(options.sink, [
        credentialEvent(
          compact({ operation, credential, source: options.source }),
        ),
      ]);
    }
  };
  const store = async (credential: Credential): Promise<string> => {
    const key = generateApiKey(credential.id);
    records.set(credential.id, { credential, hash: await hashApiKey(key) });
    return key;
  };
  return Object.freeze({
    verify: (secret: string) => verifier.verify(secret),
    touch(id: string, at: number): void {
      if (records.has(id)) {
        used.set(id, at);
      }
    },
    lastUsedAt(id: string): number | undefined {
      return used.get(id);
    },
    async issue(input: Credential): Promise<string> {
      const credential = parseCredential(input);
      if (credential === undefined) {
        throw new TypeError('PermDock: not a valid v1 credential');
      }
      if (records.has(credential.id)) {
        throw new Error(`PermDock: credential '${credential.id}' exists`);
      }
      const key = await store(credential);
      emit('created', credential);
      return key;
    },
    async rotate(id: string): Promise<string | undefined> {
      const current = records.get(id);
      if (current === undefined) {
        return undefined;
      }
      const key = await store(current.credential);
      emit('rotated', current.credential);
      return key;
    },
    revoke(id: string): boolean {
      const current = records.get(id);
      if (current === undefined) {
        return false;
      }
      records.delete(id);
      used.delete(id);
      emit('revoked', current.credential);
      return true;
    },
    list(): readonly Credential[] {
      return [...records.values()].map((record) => record.credential);
    },
  });
}

export type ApiKeySubjectOptions = {
  readonly verifier: CredentialVerifier;
  /** The definitions, to turn the credential's permission keys into its delegation. */
  readonly permissions: PermissionTree;
  /**
   * The live owner of a user-bound key: roles and memberships as of this
   * request. `null` (a deleted or suspended user) is anonymous. Without it
   * the owner is `{ id, kind: 'user' }` and its rights come from the
   * `memberships` source passed to `createPermDock`.
   */
  readonly owner?: (
    id: string,
  ) => Principal | null | undefined | Promise<Principal | null | undefined>;
  /** `true` when the application revoked the credential id; a throw denies. */
  readonly revoked?: (id: string) => boolean | Promise<boolean>;
  /**
   * The tenant `credentials` policy, checked on every use so a tightened
   * policy reaches existing keys: a service key's own tenant, a user key's
   * the `tenant` the resolver is called with. A throw denies.
   */
  readonly settings?: SettingsSource;
  /** Receives a `credential` event with operation `used` for sampled uses. */
  readonly sink?: DecisionSink;
  /** Fraction of uses reported to `sink`, in `(0, 1]`; defaults to 1. */
  readonly sample?: number;
  /** The `source` of `used` events; defaults to `permdock`. */
  readonly source?: string;
  readonly onAuth?: (event: AuthEvent) => void;
  readonly requestId?: string;
};

type Checked =
  | { readonly ok: true; readonly owner?: Principal }
  | { readonly ok: false; readonly cause?: ApiKeyFailureCause };

async function checkStores(
  options: ApiKeySubjectOptions,
  credential: Credential,
  active: string | undefined,
): Promise<Checked> {
  try {
    const tenant = credentialTenant(credential, active);
    const policy =
      options.settings === undefined || tenant === undefined
        ? undefined
        : (await options.settings.settingsFor(tenant))?.credentials;
    if (
      policy !== undefined &&
      credentialPolicyViolation(credential, policy) !== undefined
    ) {
      return { ok: false, cause: 'credential-policy' };
    }
    if (
      options.revoked !== undefined &&
      (await options.revoked(credential.id))
    ) {
      return { ok: false, cause: 'credential-revoked' };
    }
    if (credential.kind !== 'user' || options.owner === undefined) {
      return { ok: true };
    }
    const owner = await options.owner(credential.principal);
    if (owner === null || owner === undefined) {
      return { ok: false, cause: 'owner-unavailable' };
    }
    return { ok: true, owner };
  } catch {
    return { ok: false };
  }
}

function touch(verifier: CredentialVerifier, id: string): void {
  if (verifier.touch === undefined) {
    return;
  }
  try {
    const touched = verifier.touch(id, Math.floor(Date.now() / 1000));
    if (isThenable(touched)) {
      void Promise.resolve(touched).catch(() => undefined);
    }
  } catch {
    // a touch never changes the subject
  }
}

function sampled(sample: number): boolean {
  if (sample === 1) {
    return true;
  }
  const draw = new Uint32Array(1);
  globalThis.crypto.getRandomValues(draw);
  return (draw[0] ?? 0) / 0x1_0000_0000 < sample;
}

function reportUse(
  options: ApiKeySubjectOptions,
  credential: Credential,
): void {
  const sample = options.sample ?? 1;
  if (
    options.sink === undefined ||
    !Number.isFinite(sample) ||
    sample <= 0 ||
    sample > 1 ||
    !sampled(sample)
  ) {
    return;
  }
  write(options.sink, [
    credentialEvent(
      compact({
        operation: 'used' as const,
        credential,
        source: options.source,
        sample,
      }),
    ),
  ]);
}

/**
 * A `SubjectResolver` for opaque API keys (`pdk_<id>_<secret>`): each call
 * resolves a key into the subject its credential acts as. Every failure (a
 * malformed or unknown key, a record that is not a valid credential, expiry,
 * a tenant policy the key breaks, a revoked id, a missing owner, a throwing
 * verifier or callback) is the anonymous subject, never a throw.
 */
export function subjectFromApiKey(
  options: ApiKeySubjectOptions,
): SubjectResolver<string | undefined | null, CredentialPrincipal> {
  return (key, resolve) => resolveApiKey(key, options, resolve?.tenant);
}

function anonymous(): Subject<CredentialPrincipal> {
  // SAFETY: the anonymous subject has a null principal, which fits any principal type.
  return anonymousSubject() as Subject<CredentialPrincipal>;
}

async function resolveApiKey(
  key: string | undefined | null,
  options: ApiKeySubjectOptions,
  tenant: string | undefined,
): Promise<Subject<CredentialPrincipal>> {
  if (typeof key !== 'string' || key.length === 0) {
    return anonymous();
  }
  const deny = (
    cause: ApiKeyFailureCause | undefined,
    reason: AuthEvent['reason'] = 'invalid-token',
  ): Subject<CredentialPrincipal> => {
    try {
      options.onAuth?.(
        compact<AuthEvent>({
          reason,
          cause,
          source: 'api-key',
          requestId: options.requestId,
        }),
      );
    } catch {
      // a listener never changes the outcome
    }
    return anonymous();
  };
  const parts = parseApiKey(key);
  if (parts === undefined) {
    return deny('malformed');
  }
  let verified: unknown;
  try {
    verified = await options.verifier.verify(key);
  } catch {
    return deny(undefined, 'source-threw');
  }
  if (verified === null || verified === undefined) {
    return deny('unknown-credential');
  }
  const credential = parseCredential(verified);
  if (credential === undefined || credential.id !== parts.id) {
    return deny('invalid-claims');
  }
  if (
    credential.expiresAt !== undefined &&
    credential.expiresAt <= Date.now() / 1000
  ) {
    return deny('expired');
  }
  const checked = await checkStores(options, credential, tenant);
  if (!checked.ok) {
    return checked.cause === undefined
      ? deny(undefined, 'source-threw')
      : deny(checked.cause);
  }
  const subject = credentialSubject(
    credential,
    compact({ permissions: options.permissions, owner: checked.owner }),
  );
  if (subject.principal === null) {
    return deny('owner-unavailable');
  }
  reportUse(options, credential);
  touch(options.verifier, credential.id);
  // SAFETY: credentialSubject builds a CredentialPrincipal, and a null principal returned above.
  return subject as Subject<CredentialPrincipal>;
}
