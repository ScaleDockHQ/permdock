/* oxlint-disable max-lines-per-function, no-await-in-loop, typescript/prefer-readonly-parameter-types, typescript/no-unsafe-assignment -- a measurement driver: each timed statement waits for the one before it, over untyped EXPLAIN JSON */
/**
 * Time a write takes to parse, rewrite and plan with and without the
 * restrictive `{table}_{op}_read_only_actors` policies that
 * `rls.readOnlyActors` generates, and the cost of the function they call. The
 * database half of the CentraKit dry run runs it against the loaded stack.
 *
 * Each statement is sent as `EXPLAIN` without `ANALYZE` by a role in
 * `authenticated` inside a transaction, and the client times the round trip:
 * "Planning Time" leaves out the rewriter, which applies the policies. The
 * policies are then dropped in the same transaction and the statements timed
 * again; the transaction rolls back. The stack has no rows, so nothing
 * executes. Each policy adds one initplan, whose cost is the call of
 * `permdock_actor_may_write()`, timed separately over `CALLS` calls.
 */
const SAMPLE = 15;
const ROUNDS = 2;
const CALLS = 20_000;
const POLICY = /_(insert|update|delete)_read_only_actors$/u;
const CLAIMS =
  '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

export type Query = (
  sql: string,
) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;

type Op = "insert" | "update" | "delete";
type Guard = {
  readonly schema: string;
  readonly table: string;
  readonly policy: string;
  readonly op: Op;
  /** A column an `update` can set to itself. */
  readonly column: string;
};

const OPS: readonly Op[] = ["insert", "update", "delete"];

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const keyOf = (guard: Guard): string =>
  `${guard.schema}.${guard.table}:${guard.op}`;
const round = (value: number): number => Math.round(value * 1000) / 1000;

function statement(guard: Guard): string {
  const table = `${ident(guard.schema)}.${ident(guard.table)}`;
  switch (guard.op) {
    case "insert":
      return `insert into ${table} default values`;
    case "update":
      return `update ${table} set ${ident(guard.column)} = ${ident(guard.column)}`;
    case "delete":
      return `delete from ${table}`;
    default: {
      const exhaustive: never = guard.op;
      return exhaustive;
    }
  }
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function field(body: unknown, name: string): number | null {
  const first: unknown = Array.isArray(body) ? body[0] : undefined;
  const value =
    typeof first === "object" && first !== null
      ? Reflect.get(first, name)
      : undefined;
  return typeof value === "number" ? value : null;
}

const failures: string[] = [];
const ROLE = "pdk_measure";

/**
 * Milliseconds the server takes to parse, rewrite and plan the statement, as
 * the round trip of `EXPLAIN` without `ANALYZE`. The rewriter applies the row
 * security policies, which "Planning Time" leaves out.
 */
async function statementMs(query: Query, sql: string): Promise<number | null> {
  await query("savepoint measure");
  try {
    const started = performance.now();
    await query(`explain (format json) ${sql}`);
    const elapsed = performance.now() - started;
    await query("release savepoint measure");
    return elapsed;
  } catch (error) {
    await query("rollback to savepoint measure");
    failures.push(
      `${sql}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** A failed statement rolls back to its savepoint so the transaction goes on. */
async function explain(
  query: Query,
  sql: string,
  options: string,
  name: string,
): Promise<number | null> {
  await query("savepoint measure");
  try {
    const { rows } = await query(`explain (${options}, format json) ${sql}`);
    await query("release savepoint measure");
    return field(rows[0]?.["QUERY PLAN"], name);
  } catch (error) {
    await query("rollback to savepoint measure");
    failures.push(
      `${sql}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function plan(
  query: Query,
  guards: readonly Guard[],
): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  for (const guard of guards) {
    const sql = statement(guard);
    await statementMs(query, sql);
    const samples: number[] = [];
    for (let index = 0; index < SAMPLE; index += 1) {
      const time = await statementMs(query, sql);
      if (time !== null) {
        samples.push(time);
      }
    }
    if (samples.length > 0) {
      times.set(keyOf(guard), median(samples));
    }
  }
  return times;
}

async function guardsOf(query: Query): Promise<readonly Guard[]> {
  const { rows } = await query(
    `select p.schemaname, p.tablename, p.policyname,
       (select a.attname from pg_attribute a
        where a.attrelid = format('%I.%I', p.schemaname, p.tablename)::regclass
          and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = ''
        order by a.attnum limit 1) as col
     from pg_policies p
     where p.permissive = 'RESTRICTIVE' and p.policyname like '%\\_read\\_only\\_actors'
     order by p.schemaname, p.tablename, p.policyname`,
  );
  return rows.flatMap((row) => {
    const name = String(row["policyname"]);
    const op = POLICY.exec(name)?.[1];
    return op === "insert" || op === "update" || op === "delete"
      ? [
          {
            schema: String(row["schemaname"]),
            table: String(row["tablename"]),
            policy: name,
            op,
            column: String(row["col"]),
          },
        ]
      : [];
  });
}

/**
 * A role that holds every privilege on the guarded tables and, through
 * `authenticated`, the policies' audience. A superuser or an owner would bypass
 * row security. The role goes with the transaction.
 */
async function createRole(
  query: Query,
  guards: readonly Guard[],
): Promise<void> {
  await query(`create role ${ROLE} nologin`);
  await query(`grant authenticated to ${ROLE}`);
  await query(`grant ${ROLE} to current_user with set true`);
  for (const schema of new Set(guards.map((guard) => guard.schema))) {
    await query(`grant usage on schema ${ident(schema)} to ${ROLE}`);
    await query(
      `grant all on all tables in schema ${ident(schema)} to ${ROLE}`,
    );
  }
}

async function asAuthenticated(query: Query): Promise<void> {
  await query(`set local role ${ROLE}`);
  await query(`select set_config('request.jwt.claims', '${CLAIMS}', true)`);
}

async function guardCallMicros(
  query: Query,
  guards: readonly Guard[],
): Promise<number | null> {
  await query("begin");
  try {
    await createRole(query, guards);
    await asAuthenticated(query);
    const time = await explain(
      query,
      `select count(*) from generate_series(1, ${String(CALLS)}) g where permdock.permdock_actor_may_write() is not null`,
      "analyze",
      "Execution Time",
    );
    return time === null ? null : round((time * 1000) / CALLS);
  } finally {
    await query("rollback");
  }
}

function append(
  into: Map<string, number[]>,
  from: ReadonlyMap<string, number>,
): void {
  for (const [key, time] of from) {
    into.set(key, [...(into.get(key) ?? []), time]);
  }
}

type Pass = ReadonlyMap<string, number>;

/**
 * Two passes with the policies, then two without. The second pass of a pair
 * repeats the first on the same state, so their difference is the noise of the
 * measurement.
 */
async function planRound(
  query: Query,
  guards: readonly Guard[],
): Promise<readonly [Pass, Pass, Pass, Pass]> {
  await query("begin");
  try {
    await createRole(query, guards);
    await asAuthenticated(query);
    const first = await plan(query, guards);
    const second = await plan(query, guards);
    await query("reset role");
    for (const guard of guards) {
      await query(
        `drop policy ${ident(guard.policy)} on ${ident(guard.schema)}.${ident(guard.table)}`,
      );
    }
    await asAuthenticated(query);
    const third = await plan(query, guards);
    return [first, second, third, await plan(query, guards)];
  } finally {
    await query("rollback");
  }
}

/** Median planning milliseconds per command, with and without the policies. */
export async function measureReadOnlyActors(
  query: Query,
): Promise<Record<string, unknown>> {
  const guards = await guardsOf(query);
  if (guards.length === 0) {
    return { policies: 0 };
  }
  const passes = [
    new Map<string, number[]>(),
    new Map<string, number[]>(),
    new Map<string, number[]>(),
    new Map<string, number[]>(),
  ] as const;
  for (let index = 0; index < ROUNDS; index += 1) {
    const [a, b, c, d] = await planRound(query, guards);
    append(passes[0], a);
    append(passes[1], b);
    append(passes[2], c);
    append(passes[3], d);
  }
  const summary = (op: Op): Record<string, number> => {
    const rows = guards
      .filter((guard) => guard.op === op)
      .flatMap((guard) => {
        const [a, b, c, d] = passes.map((pass) => pass.get(keyOf(guard)));
        return a === undefined ||
          b === undefined ||
          c === undefined ||
          d === undefined
          ? []
          : [
              {
                on: (median(a) + median(b)) / 2,
                off: (median(c) + median(d)) / 2,
                noise: median(b) - median(a),
              },
            ];
      });
    const deltas = rows.map((row) => row.on - row.off);
    return {
      statements: rows.length,
      medianMsWith: round(median(rows.map((row) => row.on))),
      medianMsWithout: round(median(rows.map((row) => row.off))),
      medianDeltaMs: round(median(deltas)),
      maxDeltaMs: round(Math.max(0, ...deltas)),
      noiseMs: round(median(rows.map((row) => row.noise))),
    };
  };
  return {
    policies: guards.length,
    tables: new Set(guards.map((guard) => `${guard.schema}.${guard.table}`))
      .size,
    method: `client round trip of EXPLAIN (parse, rewrite with the policies, plan) as a role in authenticated, median of ${String(SAMPLE)} plans per statement, ${String(ROUNDS)} rounds, two passes with the policies, then two without, policies dropped in a rolled-back transaction; noiseMs is the median difference between the two passes of one state`,
    ...Object.fromEntries(OPS.map((op) => [op, summary(op)])),
    guardCallMicros: await guardCallMicros(query, guards),
    failedPlans: failures.length,
    firstFailures: failures.slice(0, 3),
  };
}
