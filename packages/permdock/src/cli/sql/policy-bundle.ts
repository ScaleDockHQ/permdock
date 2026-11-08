import { createHash } from "node:crypto";

import type { RlsSqlContext } from "./context.ts";

import { canonicalJson } from "../../core/canonical-json.ts";
import { byCodeUnit } from "../shared/compare.ts";
import { qualified, quoteLiteral } from "./quote.ts";

/** The `format` member of a policy bundle. */
export const POLICY_BUNDLE_FORMAT = "policy-bundle";

/** The wire-format major of a policy bundle. */
export const POLICY_BUNDLE_VERSION = 1;

/** The table a bundle is loaded into, in the helpers schema. */
export const POLICY_BUNDLE_TABLE = "permdock_policy_bundle";

/** One static grant: a `role_permissions` row. */
export type BundleRow = {
  readonly role: string;
  readonly permission: string;
  readonly grantKey: string;
  readonly scope: string;
  readonly effect: "allow" | "deny";
};

export type PolicyBundle = {
  /** The canonical JSON text; its bytes are what `hash` covers. */
  readonly text: string;
  /** `sha-256:<base64url>` of the UTF-8 bytes of `text`. */
  readonly hash: string;
};

/**
 * The grant keys each role holds per scope, as the `permdock_role_keys` lookup
 * reads them: sorted, without duplicates.
 */
export function roleKeyMap(
  rows: readonly BundleRow[],
): Record<string, Record<string, string[]>> {
  const map: Record<string, Record<string, string[]>> = {};
  for (const row of rows) {
    const byRole = (map[row.scope] ??= {});
    const keys = (byRole[row.role] ??= []);
    if (!keys.includes(row.grantKey)) {
      keys.push(row.grantKey);
    }
  }
  return Object.fromEntries(
    Object.entries(map)
      .toSorted(([a], [b]) => byCodeUnit(a, b))
      .map(([scope, byRole]) => [
        scope,
        Object.fromEntries(
          Object.entries(byRole)
            .toSorted(([a], [b]) => byCodeUnit(a, b))
            .map(([role, keys]) => [role, keys.toSorted(byCodeUnit)]),
        ),
      ]),
  );
}

/** `sha-256:<base64url>` of a string's UTF-8 bytes. */
export function bundleDigest(text: string): string {
  return `sha-256:${createHash("sha256").update(text, "utf8").digest("base64url")}`;
}

/**
 * The bundle of a policy's static grants: `policy-bundle` v1, with the rows
 * sorted and deduplicated and each key in the order RFC 8785 gives it, so the
 * same policy always produces the same bytes and the same hash. `rows` are the
 * `role_permissions` rows; `roleKeys` is the lookup the helpers read.
 */
export function policyBundle(rows: readonly BundleRow[]): PolicyBundle {
  const unique = new Map<string, BundleRow>();
  for (const row of rows) {
    unique.set(
      canonicalJson([row.scope, row.role, row.grantKey, row.permission]),
      row,
    );
  }
  const sorted = [...unique.entries()]
    .toSorted(([a], [b]) => byCodeUnit(a, b))
    .map(([, row]) => row);
  const text = canonicalJson({
    format: POLICY_BUNDLE_FORMAT,
    v: POLICY_BUNDLE_VERSION,
    rows: sorted.map((row) => ({
      effect: row.effect,
      grant_key: row.grantKey,
      permission: row.permission,
      role: row.role,
      scope: row.scope,
    })),
    roleKeys: roleKeyMap(sorted),
  });
  return { text, hash: bundleDigest(text) };
}

/** The SQL expression that recomputes `bundleDigest` over a `body` column. */
const DIGEST_SQL =
  "'sha-256:' || translate(rtrim(encode(sha256(convert_to(body, 'UTF8')), 'base64'), '='), '+/', '-_')";

/**
 * The table a bundle is loaded into. The check recomputes the digest, so a body
 * stored under a hash it does not have is refused; `doc` is the parsed body the
 * helpers read.
 */
export function bundleTableSql(ctx: RlsSqlContext): string {
  const table = qualified(ctx, POLICY_BUNDLE_TABLE);
  return `create table if not exists ${table} (
  hash text primary key,
  body text not null,
  doc jsonb generated always as (body::jsonb) stored,
  constraint permdock_policy_bundle_digest check (hash = ${DIGEST_SQL})
);
alter table ${table} enable row level security;
revoke all on table ${table} from anon, authenticated, public;`;
}

/**
 * Loads a bundle: an insert keyed by its hash. A bundle that is already there
 * stays as it is, so the statement is safe to run twice.
 */
export function bundleLoaderSql(
  ctx: RlsSqlContext,
  bundle: PolicyBundle,
): string {
  return `insert into ${qualified(ctx, POLICY_BUNDLE_TABLE)} (hash, body) values
  (${quoteLiteral(bundle.hash)}, ${quoteLiteral(bundle.text)})
on conflict (hash) do nothing;`;
}
