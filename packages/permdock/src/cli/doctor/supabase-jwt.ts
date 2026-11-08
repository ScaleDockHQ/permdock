import type { DoctorFinding, DoctorSource } from "../shared/doctor-types.ts";

const LEGACY_SECRET =
  /process\.env\.(?:SUPABASE_)?JWT_SECRET\b|Deno\.env\.get\(\s*["'](?:SUPABASE_)?JWT_SECRET["']|algorithms\s*:\s*\[\s*["']HS256["']\s*\]/u;

/**
 * PD113: a source file verifies with the legacy HS256 secret. HS256 verifies
 * only with the shared secret (or `GET /auth/v1/user`), so every verifier can
 * also mint tokens; ES256 signing keys verify locally from the JWKS.
 */
export function pd113(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    const lines = source.text.split("\n");
    const index = lines.findIndex(
      (text) => !/^\s*(?:\/\/|\*|\/\*)/u.test(text) && LEGACY_SECRET.test(text),
    );
    if (index < 0) {
      continue;
    }
    const line = index + 1;
    findings.push({
      code: "PD113",
      severity: "warning",
      target: `${source.file}:${String(line)}`,
      message: `${source.file}:${String(line)} verifies with the legacy HS256 JWT secret: whoever holds it can mint any user's token, and without it the only check is GET /auth/v1/user`,
      fix: "rotate to an ES256 signing key, verify against the JWKS with permdock/jwt or supabase.auth.getClaims(), and remove the secret",
    });
  }
  return findings;
}
