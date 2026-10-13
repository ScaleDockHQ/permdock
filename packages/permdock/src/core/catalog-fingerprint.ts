import { canonicalJson } from "./canonical-json.ts";
import { isRecord } from "./compact.ts";
import { sha256Digest } from "./sha256.ts";

const OMITTED_TOP_LEVEL = new Set(["generatedAt", "generator", "fingerprint"]);

function fingerprintInput(catalog: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(catalog)) {
    if (OMITTED_TOP_LEVEL.has(key)) {
      continue;
    }
    out[key] =
      key === "permissions" && Array.isArray(value)
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
 * The catalog v1 fingerprint: the `sha-256:` digest of its RFC 8785 JSON without `generatedAt`, `generator`, `fingerprint`
 * and every `permissions[].usages`, so neither the CLI version, the clock nor
 * call sites change it.
 */
export function catalogFingerprint(catalog: unknown): string {
  if (!isRecord(catalog)) {
    throw new TypeError("PermDock: a catalog must be an object");
  }
  return sha256Digest(canonicalJson(fingerprintInput(catalog)));
}
