import { canonicalJson } from './canonical-json.ts';
import { bytesToBase64Url, sha256 } from './sha256.ts';

const OMITTED_TOP_LEVEL = new Set(['generatedAt', 'generator', 'fingerprint']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fingerprintInput(catalog: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(catalog)) {
    if (OMITTED_TOP_LEVEL.has(key)) {
      continue;
    }
    out[key] =
      key === 'permissions' && Array.isArray(value)
        ? value.map((permission: unknown) => {
            if (!isRecord(permission)) {
              return permission;
            }
            const { usages: _usages, ...rest } = permission;
            return rest;
          })
        : value;
  }
  return out;
}

/**
 * The catalog v1 fingerprint: base64url SHA-256 of canonical JSON (keys
 * sorted, no whitespace) without `generatedAt`, `generator`, `fingerprint`
 * and every `permissions[].usages`, so neither the CLI version, the clock nor
 * call sites change it.
 */
export function catalogFingerprint(catalog: unknown): string {
  if (!isRecord(catalog)) {
    throw new TypeError('PermDock: a catalog must be an object');
  }
  return bytesToBase64Url(sha256(canonicalJson(fingerprintInput(catalog))));
}
