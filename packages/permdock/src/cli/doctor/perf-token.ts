import type { Project } from "../project/project.ts";
import type { DoctorFinding } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";
import type { HookEvent } from "./hook-role.ts";

import { isRecord } from "../../core/compact.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { describeError } from "../core/errors.ts";
import { quoteIdent } from "../sql/quote.ts";

/**
 * The longest access token, in characters, PD110 accepts. The token travels in
 * every `Authorization` header, and `@supabase/ssr` splits a session cookie
 * into chunks of 3,180 bytes.
 */
export const TOKEN_CHARS_BUDGET = 4096;

/**
 * Claims every Supabase access token carries beside the hook's, sized for an
 * OAuth sign-in: a long email, the `user_metadata` a social provider writes
 * (user-writable, so any size), an OAuth `client_id` and two `amr` entries.
 * Shorter placeholders would make PD110 and `claims size` under-report.
 * https://supabase.com/docs/guides/auth/jwt-fields
 */
const BASE_CLAIMS = {
  iss: "https://abcdefghijklmnopqrst.supabase.co/auth/v1",
  aud: "authenticated",
  exp: 1_900_000_000,
  iat: 1_900_000_000,
  sub: "00000000-0000-4000-8000-000000000000",
  email: "firstname.lastname.with.a.long.local.part@subdomain.example.com",
  phone: "",
  app_metadata: { provider: "google", providers: ["google", "email"] },
  user_metadata: {
    avatar_url:
      "https://lh3.googleusercontent.com/a/ACg8ocJ0000000000000000000000000000000000000000000=s96-c",
    email: "firstname.lastname.with.a.long.local.part@subdomain.example.com",
    email_verified: true,
    full_name: "Firstname Lastname-Longsurname",
    iss: "https://accounts.google.com",
    name: "Firstname Lastname-Longsurname",
    phone_verified: false,
    picture:
      "https://lh3.googleusercontent.com/a/ACg8ocJ0000000000000000000000000000000000000000000=s96-c",
    provider_id: "100000000000000000000",
    sub: "100000000000000000000",
  },
  role: "authenticated",
  aal: "aal1",
  amr: [
    { method: "oauth", timestamp: 1_900_000_000 },
    { method: "password", timestamp: 1_899_000_000 },
  ],
  session_id: "00000000-0000-4000-8000-000000000000",
  is_anonymous: false,
  client_id: "00000000-0000-4000-8000-000000000000",
};

/** Base64url length of `{"alg":"ES256","typ":"JWT","kid":<uuid>}`. */
const HEADER_CHARS = 100;
/** Base64url length of a 64-byte ES256 signature. */
const SIGNATURE_CHARS = 86;

/**
 * The length of the compact JWT a project's sign-in would issue: the Supabase
 * base claims overlaid with what the hook returned, plus header and signature.
 */
export function tokenChars(hookClaims: unknown): number {
  const claims = JSON.stringify({
    ...BASE_CLAIMS,
    ...(isRecord(hookClaims) ? hookClaims : {}),
  });
  return (
    HEADER_CHARS +
    1 +
    Math.ceil((Buffer.byteLength(claims) * 4) / 3) +
    1 +
    SIGNATURE_CHARS
  );
}

/**
 * PD109: `rls.authorize: "jwt"` with `rls.customRoles`, and no
 * `supabase.hook.claims` function to write `grants`. The generated hook writes
 * no `grants` on a membership, so the helpers find no custom role in the token
 * and every custom-role holder is denied.
 */
export function pd109(config: PermDockConfig): readonly DoctorFinding[] {
  const customRoles = config.rls?.customRoles;
  if (
    config.rls?.authorize !== "jwt" ||
    customRoles === undefined ||
    customRoles === false ||
    Object.keys(config.supabase?.hook?.claims ?? {}).length > 0
  ) {
    return [];
  }
  return [
    {
      code: "PD109",
      severity: "error",
      target: "rls.customRoles",
      message:
        "rls.customRoles with rls.authorize 'jwt' resolves no custom role: the generated hook writes no grants into the token",
      fix: "set rls.authorize to 'database', or write memberships[].grants from a supabase.hook.claims function",
    },
  ];
}

/**
 * PD114: `rls.authorize: "jwt"` with a token hook. The helpers read the
 * `memberships` claim and nothing else, so an organisation the hook budget cut
 * is missing from every policy: the user loses access with no error.
 * `rls.authorize: "database"` with the hook reads the claims first and the
 * tables when the token is truncated. With `--db-url-stdin`, PD110's sample run
 * raises this to an error for a sample user whose minted token is truncated.
 */
export function pd114(config: PermDockConfig): readonly DoctorFinding[] {
  if (config.rls?.authorize !== "jwt" || config.supabase?.hook === undefined) {
    return [];
  }
  return [
    {
      code: "PD114",
      severity: "warning",
      target: "rls.authorize",
      message:
        "rls.authorize 'jwt' reads only the memberships the hook budget keeps, so a user with more organisations than fit loses access to the rest with no error",
      fix: "set rls.authorize to 'database': with the hook the helpers read the claims and fall back to the tables for a truncated token; or run doctor with --db-url-stdin to check the sample users",
    },
  ];
}

/**
 * PD110: with `--db-url-stdin`, the token the hook builds for a sample user is
 * longer than {@link TOKEN_CHARS_BUDGET}. It measures the whole token, as
 * better-supabase's BS405 measures the claims against `tokenHook.budget`, and
 * runs the hook inside a transaction it rolls back.
 */
export async function pd110(
  project: Pick<Project, "database" | "config" | "files" | "cwd">,
  events: readonly HookEvent[],
): Promise<readonly DoctorFinding[]> {
  const { database } = project;
  const hook = project.config.supabase?.hook;
  if (database === undefined || hook === undefined) {
    return [];
  }
  const schema = hook.schema ?? project.config.rls?.schema ?? PERMDOCK_SCHEMA;
  const fn = `${quoteIdent(schema)}.custom_access_token_hook`;
  const client = await database.connect(database.url);
  const findings: DoctorFinding[] = [];
  try {
    for (const { label, event } of events) {
      await client.query("begin", []);
      try {
        const result = await client.query(
          `select (${fn}($1::jsonb) -> 'claims') as claims`,
          [JSON.stringify(event)],
        );
        const minted: unknown = result.rows[0]?.["claims"];
        if (
          project.config.rls?.authorize === "jwt" &&
          isRecord(minted) &&
          minted["memberships_truncated"] === true
        ) {
          findings.push({
            code: "PD114",
            severity: "error",
            target: label,
            message: `the token for ${label} is truncated and rls.authorize is 'jwt': the helpers miss every organisation the budget cut`,
            fix: "set rls.authorize to 'database', which falls back to the tables, or raise supabase.hook.budget until the token holds every membership",
          });
        }
        const length = tokenChars(minted);
        if (length > TOKEN_CHARS_BUDGET) {
          findings.push({
            code: "PD110",
            severity: "warning",
            target: label,
            message: `the access token for ${label} is ${String(length)} characters, over ${String(TOKEN_CHARS_BUDGET)}`,
            fix: "lower supabase.hook.budget, drop hook.claims entries, or hold fewer custom roles; the active tenant stays in the token",
          });
        }
      } catch (error) {
        findings.push({
          code: "PD110",
          severity: "info",
          target: label,
          message: `the token size for ${label} was not measured: ${describeError(error)}`,
          fix: "fix PD085 first; it reports why the hook fails",
        });
      } finally {
        await client.query("rollback", []);
      }
    }
  } finally {
    await client.end();
  }
  return findings;
}
