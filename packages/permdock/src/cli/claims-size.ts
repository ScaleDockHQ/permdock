import type { CommandResult } from "./core/result.ts";

import { compactMemberships } from "../core/membership-claim.ts";
import { supabaseMembershipsBudget } from "../supabase/budget.ts";
import {
  COOKIE_CHUNK_CHARS,
  cookieChunks,
  sessionCookieChars,
  tokenChars,
} from "./doctor/perf-token.ts";

export type ClaimsSizeReport = {
  readonly memberships: number;
  readonly rolesPerMembership: number;
  /** Bytes of one membership entry as the hook writes it. */
  readonly entryBytes: number;
  /** Bytes of the whole `memberships` array before the budget cuts it. */
  readonly claimBytes: number;
  readonly budget: number;
  /** Entries that fit the budget, counting only the array itself. */
  readonly kept: number;
  readonly truncated: boolean;
  /** The most memberships of this shape the budget keeps. */
  readonly fits: number;
  /**
   * Bytes of the whole compact claim (`core/membership-claim.ts`), for all
   * memberships.
   */
  readonly compactClaimBytes: number;
  /** The most memberships of this shape the budget keeps in the compact claim. */
  readonly compactFits: number;
  /**
   * Characters of the compact token with the kept entries and the Supabase base
   * claims.
   */
  readonly tokenChars: number;
  /** Characters of the `tokens-only` session cookie that holds that token. */
  readonly cookieChars: number;
  /** The chunks `@supabase/ssr` splits that cookie into. */
  readonly cookieChunks: number;
};

function entry(scope: string, index: number, roles: number): string {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const names = Array.from(
    { length: roles },
    (_, role) => `role-${String(role).padStart(3, "0")}`,
  );
  return JSON.stringify({ scope, id, roles: names });
}

/** How many entries of `entryBytes` fit `budget` bytes of `[a,b,c]`. */
function fitting(entryBytes: number, budget: number): number {
  if (entryBytes <= 0) {
    return 0;
  }
  return Math.max(Math.floor((budget - 1) / (entryBytes + 1)), 0);
}

function compactBytes(entries: readonly string[]): number {
  return Buffer.byteLength(
    JSON.stringify(
      compactMemberships(
        entries.map((text) => {
          const parsed: unknown = JSON.parse(text);
          return parsed;
        }),
      ),
    ),
  );
}

/** The most entries of `entries` whose compact claim fits `budget` bytes. */
function compactFitting(entries: readonly string[], budget: number): number {
  let fits = 0;
  while (
    fits < entries.length &&
    compactBytes(entries.slice(0, fits + 1)) <= budget
  ) {
    fits += 1;
  }
  return fits;
}

export function claimsSize(input: {
  readonly memberships: number;
  readonly roles: number;
  readonly scope: string;
  readonly budget: number;
}): ClaimsSizeReport {
  const entries = Array.from({ length: input.memberships }, (_, index) =>
    entry(input.scope, index, input.roles),
  );
  const entryBytes =
    entries[0] === undefined ? 0 : Buffer.byteLength(entries[0]);
  const fits = fitting(entryBytes, input.budget);
  const kept = Math.min(fits, input.memberships);
  const claim = `[${entries.join(",")}]`;
  const token = tokenChars({
    memberships: entries.slice(0, kept).map((text) => {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    }),
    ...(kept < input.memberships ? { memberships_truncated: true } : {}),
  });
  return {
    memberships: input.memberships,
    rolesPerMembership: input.roles,
    entryBytes,
    claimBytes: Buffer.byteLength(claim),
    budget: input.budget,
    kept,
    truncated: kept < input.memberships,
    fits,
    compactClaimBytes: compactBytes(entries),
    compactFits: compactFitting(entries, input.budget),
    tokenChars: token,
    cookieChars: sessionCookieChars(token),
    cookieChunks: cookieChunks(token),
  };
}

export function runClaimsSize(input: {
  readonly memberships: number;
  readonly roles: number;
  readonly scope: string;
  readonly budget: number | undefined;
  readonly json: boolean;
}): CommandResult {
  const report = claimsSize({
    ...input,
    budget: input.budget ?? supabaseMembershipsBudget,
  });
  const lines = [
    `${String(report.memberships)} memberships of ${String(report.rolesPerMembership)} role(s): ${String(report.entryBytes)} bytes per entry, ${String(report.claimBytes)} bytes in all`,
    report.truncated
      ? `the ${String(report.budget)} byte budget keeps ${String(report.kept)} and sets memberships_truncated; at most ${String(report.fits)} fit`
      : `all fit the ${String(report.budget)} byte budget (at most ${String(report.fits)})`,
    `compact claim: ${String(report.compactClaimBytes)} bytes in all; at most ${String(report.compactFits)} fit`,
    `compact token with the Supabase base claims: ${String(report.tokenChars)} characters`,
    `tokens-only session cookie: ${String(report.cookieChars)} characters in ${String(report.cookieChunks)} chunk(s) of ${String(COOKIE_CHUNK_CHARS)}`,
  ];
  return {
    code: 0,
    output: input.json ? JSON.stringify(report) : lines.join("\n"),
    data: report,
  };
}
