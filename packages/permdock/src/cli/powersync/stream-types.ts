import type { Scope } from "../../core/scopes.ts";
import type { Policy } from "../../index.ts";
import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type { RlsGrant } from "../sql/grants.ts";
import type { PermDockConfig } from "../types.ts";
import type { TableNames } from "./names.ts";

import { quoteSqlLiteral } from "../../core/sql.ts";
import { ident } from "./names.ts";

/**
 * How a stream query names the signed-in user, its claims and row columns.
 * `powersync` writes Sync Streams SQL; `postgres` writes the same query for
 * `permdock powersync verify` to run, with `$1` the user id and `$2` the
 * claims.
 */
export type StreamDialect = {
  readonly user: string;
  claim: (name: string) => string;
  claims: (name: string) => string;
  /** A row column; `numeric` keeps its type for a comparison with a number. */
  column: (table: string, name: string, numeric?: boolean) => string;
  literal: (value: string | number | boolean) => string;
  readonly names?: TableNames;
};

export const POWERSYNC: StreamDialect = {
  user: "auth.user_id()",
  claim: (name) => `auth.parameter(${quoteSqlLiteral(name)})`,
  claims: (name) =>
    `(SELECT value FROM json_each(auth.parameter(${quoteSqlLiteral(name)})))`,
  column: (table, name) => `${table}.${ident(name)}`,
  literal: (value) =>
    typeof value === "string" ? quoteSqlLiteral(value) : String(value),
};

export const POSTGRES: StreamDialect = {
  user: "$1::text",
  claim: (name) => `($2::jsonb ->> ${quoteSqlLiteral(name)})`,
  claims: (name) =>
    `(select jsonb_array_elements_text(case jsonb_typeof($2::jsonb -> ${quoteSqlLiteral(name)}) when 'array' then $2::jsonb -> ${quoteSqlLiteral(name)} else '[]'::jsonb end))`,
  column: (table, name, numeric) =>
    `${table}.${ident(name)}${numeric === true ? "" : "::text"}`,
  literal: (value) =>
    typeof value === "number" ? String(value) : quoteSqlLiteral(String(value)),
};

export type PowerSyncStream = {
  readonly name: string;
  readonly resource: string;
  readonly table: string;
  /** The row's id column, which `verify` matches a fixture row on. */
  readonly id: string;
  /** One query per way a subject may read a row; the stream syncs their union. */
  readonly queries: readonly string[];
  /** The token claims the queries read; a change needs a PowerSync reconnect. */
  readonly claims: readonly string[];
};

/**
 * A stream of the rows `localSnapshot` builds the user's snapshot from:
 * memberships, roles, custom roles.
 */
export type SubjectStream = {
  readonly name: string;
  readonly table: string;
  /**
   * The user column when every row is the user's own; `verify` checks no other
   * user's row syncs.
   */
  readonly user?: string;
  readonly queries: readonly string[];
};

export type PowerSyncPlan = {
  readonly streams: readonly PowerSyncStream[];
  readonly subject: readonly SubjectStream[];
  /** The `powersync.tables` streams. */
  readonly tables: readonly SubjectStream[];
  /** Resources and `powersync.tables` entries with no stream, and why. */
  readonly omitted: readonly {
    readonly resource: string;
    readonly reason: string;
  }[];
  readonly warnings: readonly string[];
  /**
   * Device names of the tables outside `public` renamed to `<schema>_<table>`,
   * by `schema.table`.
   */
  readonly devices: ReadonlyMap<string, string>;
  /**
   * The grant behind each `does not sync` and `under-syncs` warning; `powersync
   * verify` excuses a granted, unsynced fixture only through one.
   */
  readonly unsynced: readonly PowerSyncGap[];
  /** The synced tables outside `public`, as `schema.table`. */
  readonly outside: readonly string[];
  /**
   * `alter publication powersync add table …;` for the synced tables outside
   * `public`, which a `for all tables in schema public` publication leaves
   * out.
   */
  readonly publication?: string;
};

/**
 * A grant a stream leaves rows of out: a declared role (or `anyone`,
 * `authenticated`) by `role`; a custom role's allow at `level` (`null` for no
 * level, absent for every level); or, with `composed`, any custom role with
 * includes or a shared or global scope.
 */
export type PowerSyncGap = {
  readonly permission: string;
  readonly role: string;
  readonly level?: string | null;
  readonly composed?: true;
};

/**
 * What one stream compile reads. `gaps` is filled by the compile and drained by
 * the plan.
 */
export type StreamCtx = {
  readonly policy: Policy;
  readonly config: PermDockConfig;
  readonly scopes: readonly Scope[];
  readonly kinds: Readonly<Record<string, readonly string[]>>;
  readonly dialect: StreamDialect;
  readonly sources: readonly SqlMembershipSource[];
  readonly grants: readonly RlsGrant[];
  /** How many `inherit()` grants deep the condition being compiled sits. */
  readonly depth: number;
  /**
   * Why a source the grant being compiled reads does not sync; the caller turns
   * them into warnings.
   */
  readonly gaps: string[];
};
