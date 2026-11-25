import type { Scope } from "../../core/scopes.ts";
import type { CommandResult } from "../core/result.ts";
import type { SqlClient, SqlConnect } from "../pg.ts";
import type { PermDockConfig } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { readMemberships } from "../../core/read-memberships.ts";
import { scopeList, tenantOf } from "../../core/scopes.ts";
import { shareKeyClaimsEligible } from "../../core/share-key-claims.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { loadConfiguredPolicy } from "../project/load.ts";
import { quoteIdent } from "../sql/quote.ts";
import { activeSource } from "../supabase-hook/memberships.ts";
import { configuredTableReads } from "./table-reads.ts";

/** Requests per tenant when `--requests` is absent. */
export const DEFAULT_REQUESTS = 20;
/** Tables a request reads when `--tables` is absent. */
export const DEFAULT_TABLES = 10;
/** Tenants of one user the share-key count covers. */
const TENANT_LIMIT = 20;
const VERSION_FUNCTION = /(authz_versions?_for|custom_roles_version_for)$/u;

export type MeasureInput = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly db: string;
  readonly connect: SqlConnect;
  /** Auth user ids. */
  readonly users: readonly string[];
  readonly tenant?: string;
  readonly requests: number;
  readonly tables: number;
};

type Counts = ReadonlyMap<string, { calls: number; totalMs: number }>;

/** What one user's requests cost. */
export type MeasuredUser = {
  readonly user: string;
  /** `false` for an id `auth.users` does not hold. */
  readonly token: boolean;
  readonly memberships: number;
  readonly membershipsTruncated: boolean;
  readonly tenants: number;
  /** Tenants whose claims allow a share key. */
  readonly shareKeys: number;
  /** Version-function calls per request, by function. */
  readonly versionReadsPerRequest: Readonly<Record<string, number>>;
  readonly requests: number;
  readonly tablesPerRequest: number;
  readonly requestMs: { readonly median: number; readonly p95: number };
};

export type MeasuredHelper = {
  readonly name: string;
  readonly calls: number;
  readonly meanMs: number;
  readonly totalMs: number;
  /** `pg_stat_user_functions` or `pg_stat_statements`. */
  readonly source: string;
};

export type MeasureReport = {
  readonly users: readonly MeasuredUser[];
  readonly helpers: readonly MeasuredHelper[];
  /** Requests whose claims allow a share key, over all users and tenants. */
  readonly shareKey: {
    readonly requests: number;
    readonly withKey: number;
    readonly share: number | null;
  };
  readonly pgStatStatements: "available" | "missing";
  readonly notes: readonly string[];
};

const ident = quoteIdent;

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

async function counts(
  client: SqlClient,
  schema: string,
): Promise<{ readonly counts: Counts; readonly trackFunctions: boolean }> {
  const out = new Map<string, { calls: number; totalMs: number }>();
  let trackFunctions = true;
  try {
    const { rows } = await client.query(
      `select schemaname, funcname, calls, total_time from pg_stat_user_functions where schemaname = $1`,
      [schema],
    );
    for (const row of rows) {
      out.set(String(row["funcname"]), {
        calls: Number(row["calls"]),
        totalMs: Number(row["total_time"]),
      });
    }
  } catch {
    trackFunctions = false;
  }
  return { counts: out, trackFunctions };
}

function delta(before: Counts, after: Counts): Counts {
  const out = new Map<string, { calls: number; totalMs: number }>();
  for (const [name, now] of after) {
    const was = before.get(name);
    const calls = now.calls - (was?.calls ?? 0);
    if (calls > 0) {
      out.set(name, { calls, totalMs: now.totalMs - (was?.totalMs ?? 0) });
    }
  }
  return out;
}

async function statementCounts(
  client: SqlClient,
  schema: string,
): Promise<Counts> {
  const out = new Map<string, { calls: number; totalMs: number }>();
  const { rows } = await client.query(
    `select query, calls, total_exec_time from pg_stat_statements
     where dbid = (select oid from pg_database where datname = current_database())
       and query like $1`,
    [`%${schema}.%`],
  );
  for (const row of rows) {
    out.set(String(row["query"]), {
      calls: Number(row["calls"]),
      totalMs: Number(row["total_exec_time"]),
    });
  }
  return out;
}

/**
 * The claims the hook mints for `user`, with `tenant` active when the hook
 * reads it from `app_metadata`.
 */
async function mint(
  client: SqlClient,
  input: {
    readonly schema: string;
    readonly user: string;
    readonly tenantKey: string | undefined;
    readonly tenant: string | undefined;
  },
): Promise<Record<string, unknown> | undefined> {
  const meta =
    input.tenantKey === undefined || input.tenant === undefined
      ? "{}"
      : JSON.stringify({ app_metadata: { [input.tenantKey]: input.tenant } });
  const { rows } = await client.query(
    `select ${ident(input.schema)}.custom_access_token_hook(jsonb_build_object(
       'user_id', $1::uuid,
       'claims', jsonb_build_object('sub', $1::text, 'role', 'authenticated', 'aal', 'aal1') || $2::jsonb
     )) -> 'claims' as claims`,
    [input.user, meta],
  );
  const claims: unknown = rows[0]?.["claims"];
  return isRecord(claims) ? claims : undefined;
}

/** `false` for an id `auth.users` does not hold. */
async function known(client: SqlClient, user: string): Promise<boolean> {
  try {
    const { rows } = await client.query(
      "select exists (select 1 from auth.users where id = $1::uuid) as found",
      [user],
    );
    return rows[0]?.["found"] === true;
  } catch {
    return true;
  }
}

async function request(
  client: SqlClient,
  claims: Record<string, unknown>,
  tables: readonly string[],
): Promise<number> {
  await client.query("begin", []);
  try {
    await client.query("set local role authenticated", []);
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    const started = performance.now();
    for (const table of tables) {
      await client.query(`select 1 from ${table} limit 1`, []);
    }
    return performance.now() - started;
  } finally {
    await client.query("rollback", []);
  }
}

function tenantsOf(
  claims: Record<string, unknown>,
  scopes: readonly Scope[],
  only: string | undefined,
): readonly string[] {
  if (only !== undefined) {
    return [only];
  }
  const ids = readMemberships(claims["memberships"]).memberships.flatMap(
    (membership) => {
      const tenant = tenantOf(membership, scopes);
      return tenant === undefined ? [] : [tenant];
    },
  );
  return [...new Set(ids)].slice(0, TENANT_LIMIT);
}

function perRequest(
  versions: Counts,
  requests: number,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    [...versions]
      .filter(([name]) => VERSION_FUNCTION.test(name))
      .map(([name, value]) => [name, round(value.calls / requests)]),
  );
}

async function measureUser(
  client: SqlClient,
  input: MeasureInput & {
    readonly schema: string;
    readonly scopes: readonly Scope[];
    readonly tenantKey: string | undefined;
    readonly tableNames: readonly string[];
  },
  user: string,
): Promise<MeasuredUser> {
  const base = (await known(client, user))
    ? await mint(client, {
        schema: input.schema,
        user,
        tenantKey: input.tenantKey,
        tenant: input.tenant,
      })
    : undefined;
  if (base === undefined) {
    return {
      user,
      token: false,
      memberships: 0,
      membershipsTruncated: false,
      tenants: 0,
      shareKeys: 0,
      versionReadsPerRequest: {},
      requests: 0,
      tablesPerRequest: 0,
      requestMs: { median: 0, p95: 0 },
    };
  }
  const tenants = tenantsOf(base, input.scopes, input.tenant);
  let shareKeys = 0;
  for (const tenant of tenants) {
    const claims =
      input.tenantKey === undefined
        ? base
        : await mint(client, {
            schema: input.schema,
            user,
            tenantKey: input.tenantKey,
            tenant,
          });
    if (
      claims !== undefined &&
      shareKeyClaimsEligible(claims, tenant, input.scopes)
    ) {
      shareKeys += 1;
    }
  }
  const before = (await counts(client, input.schema)).counts;
  const times: number[] = [];
  for (let index = 0; index < input.requests; index += 1) {
    times.push(await request(client, base, input.tableNames));
  }
  const after = (await counts(client, input.schema)).counts;
  const sorted = times.toSorted((a, b) => a - b);
  return {
    user,
    token: true,
    memberships: readMemberships(base["memberships"]).memberships.length,
    membershipsTruncated: base["memberships_truncated"] === true,
    tenants: tenants.length,
    shareKeys,
    versionReadsPerRequest: perRequest(delta(before, after), input.requests),
    requests: input.requests,
    tablesPerRequest: input.tableNames.length,
    requestMs: {
      median: round(median(times)),
      p95: round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0),
    },
  };
}

function helpersOf(
  functions: Counts,
  statements: Counts | undefined,
): readonly MeasuredHelper[] {
  const rows: MeasuredHelper[] = [...functions].map(([name, value]) => ({
    name,
    calls: value.calls,
    meanMs: round(value.totalMs / value.calls),
    totalMs: round(value.totalMs),
    source: "pg_stat_user_functions",
  }));
  for (const [query, value] of statements ?? []) {
    rows.push({
      name: query.replaceAll(/\s+/gu, " ").slice(0, 120),
      calls: value.calls,
      meanMs: round(value.totalMs / value.calls),
      totalMs: round(value.totalMs),
      source: "pg_stat_statements",
    });
  }
  return rows.toSorted((a, b) => b.totalMs - a.totalMs).slice(0, 15);
}

/**
 * Runs `requests` requests as each user in `input.users` against the app's own
 * database and reports what Postgres counted. A request is one transaction, as
 * `authenticated` with the hook's claims, that reads one row from each of the
 * first `tables` tables of `rls.tableReads`. The hook runs per tenant of the
 * user, so the share-key count is the share of tenants whose token allows one
 * (the claims decide; the live version check and `widened` keys can still
 * refuse it). Every request rolls back and writes nothing.
 */
async function measure(input: MeasureInput): Promise<MeasureReport> {
  const hook = input.config.supabase?.hook;
  const schema = hook?.schema ?? input.config.rls?.schema ?? PERMDOCK_SCHEMA;
  const policy = await loadConfiguredPolicy(input.cwd, input.config.policy);
  const scopes = policy === undefined ? [] : scopeList(policy.scopes);
  const root = scopes[0]?.name ?? "tenant";
  const active = activeSource(hook?.activeFrom, root);
  const reads = await configuredTableReads(input.cwd, input.config);
  const tables = reads.map((read) => read.table).slice(0, input.tables);
  const notes: string[] = [];
  const client = await input.connect(input.db);
  try {
    let statements: Counts | undefined;
    let pgStatStatements: MeasureReport["pgStatStatements"] = "available";
    try {
      await client.query("set track_functions = 'all'", []);
    } catch {
      notes.push(
        "track_functions could not be set: version reads are not counted",
      );
    }
    try {
      statements = await statementCounts(client, schema);
    } catch {
      pgStatStatements = "missing";
      notes.push(
        "pg_stat_statements is not installed: create extension pg_stat_statements, and set shared_preload_libraries on a hosted database",
      );
    }
    const functionsBefore = (await counts(client, schema)).counts;
    const users: MeasuredUser[] = [];
    for (const user of input.users) {
      users.push(
        await measureUser(
          client,
          {
            ...input,
            schema,
            scopes,
            tenantKey: "appMetadata" in active ? active.appMetadata : undefined,
            tableNames: tables,
          },
          user,
        ),
      );
    }
    if (!("appMetadata" in active)) {
      notes.push(
        "the hook reads the active tenant from a table: each user is measured with the tenant the table gives",
      );
    }
    if (tables.length === 0) {
      notes.push(
        "rls.tableReads names no table, so a request reads nothing: run permdock rls generate first",
      );
    }
    const functionsAfter = (await counts(client, schema)).counts;
    const statementsAfter =
      statements === undefined
        ? undefined
        : await statementCounts(client, schema);
    const requests = users.reduce((sum, user) => sum + user.tenants, 0);
    const withKey = users.reduce((sum, user) => sum + user.shareKeys, 0);
    return {
      users,
      helpers: helpersOf(
        delta(functionsBefore, functionsAfter),
        statements === undefined || statementsAfter === undefined
          ? undefined
          : delta(statements, statementsAfter),
      ),
      shareKey: {
        requests,
        withKey,
        share: requests === 0 ? null : round(withKey / requests),
      },
      pgStatStatements,
      notes,
    };
  } finally {
    await client.end();
  }
}

function text(report: MeasureReport): string {
  const lines: string[] = [];
  for (const user of report.users) {
    if (!user.token) {
      lines.push(`${user.user}: not in auth.users`);
      continue;
    }
    const reads = Object.entries(user.versionReadsPerRequest)
      .map(([name, value]) => `${name} ${String(value)}`)
      .join(", ");
    lines.push(
      `${user.user}: ${String(user.memberships)} memberships${user.membershipsTruncated ? " (truncated)" : ""}, ${String(user.tenants)} tenants, share key for ${String(user.shareKeys)}`,
      `  ${String(user.requests)} requests of ${String(user.tablesPerRequest)} tables: median ${String(user.requestMs.median)} ms, p95 ${String(user.requestMs.p95)} ms`,
      `  version reads per request: ${reads === "" ? "0" : reads}`,
    );
  }
  const { shareKey } = report;
  lines.push(
    `share key: ${String(shareKey.withKey)} of ${String(shareKey.requests)} tenant requests${shareKey.share === null ? "" : ` (${String(Math.round(shareKey.share * 100))}%)`}`,
  );
  if (report.helpers.length > 0) {
    lines.push("helpers by total time:");
    for (const helper of report.helpers) {
      lines.push(
        `  ${String(helper.calls)} calls, ${String(helper.meanMs)} ms mean, ${String(helper.totalMs)} ms total  ${helper.name}  (${helper.source})`,
      );
    }
  }
  for (const note of report.notes) {
    lines.push(`note: ${note}`);
  }
  return lines.join("\n");
}

/** `permdock rls measure`: the result of {@link measure}. */
export async function runRlsMeasure(
  input: MeasureInput,
): Promise<CommandResult> {
  const report = await measure(input);
  return { code: 0, output: text(report), data: report };
}
