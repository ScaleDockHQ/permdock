import {
  createPermDock,
  type PermDockOptions,
  type Permission,
  type Policy,
  type WhereResult,
} from "../index.ts";

export type OrmParityScenario<TUser = unknown> = {
  readonly name: string;
  /** What the policy's `subject` mapper receives, as in `createPermDock(policy, user)`. */
  readonly user: TUser;
  /** The active tenant and role sources, as in `createPermDock(policy, user, options)`. */
  readonly options?: PermDockOptions;
  /** An instance permission; its `where()` filters the table. */
  readonly permission: Permission<string, unknown, "instance">;
  /** Every row of the table, exactly as the database holds them. */
  readonly rows: readonly Readonly<Record<string, unknown>>[];
};

export type OrmParityRunInput<TUser = unknown> = {
  readonly scenario: OrmParityScenario<TUser>;
  readonly where: WhereResult;
};

export type OrmParityOptions<TUser = unknown> = {
  /** Runs `toWhere(where)` against the database and returns the matching row ids. */
  readonly run: (
    input: OrmParityRunInput<TUser>,
  ) => Promise<readonly unknown[]>;
  /** The row id field; default `id`. */
  readonly id?: string;
};

export type OrmParityCase = {
  readonly name: string;
  readonly expected: readonly string[];
  readonly actual: readonly string[];
  /**
   * `where()` left out a non-portable grant. `toWhere` refusing it is
   * fail-closed and passes; rows it does return must be a subset.
   */
  readonly partial: boolean;
  readonly error?: string;
  readonly ok: boolean;
};

export type OrmParityReport = {
  readonly ok: boolean;
  readonly results: readonly OrmParityCase[];
};

function sortedIds(values: readonly unknown[]): string[] {
  return values.map(String).toSorted();
}

function subsetOf(small: readonly string[], large: readonly string[]): boolean {
  return small.every((value) => large.includes(value));
}

/**
 * ORM parity: for each scenario, the rows `permdock.filter()` keeps in memory
 * must be exactly the rows the database returns for `toWhere(permdock.where())`.
 * With a `relations` option, the graph is loaded for the rows first, so the
 * in-memory side walks the same graph the database query does.
 * A partial `where()` (a closure grant it cannot compile) may be refused or
 * return fewer rows, never more.
 */
export async function ormParity<TUser>(
  policy: Policy<TUser>,
  scenarios: readonly OrmParityScenario<TUser>[],
  options: OrmParityOptions<TUser>,
): Promise<OrmParityReport> {
  const idField = options.id ?? "id";

  async function runCase(
    scenario: OrmParityScenario<TUser>,
  ): Promise<OrmParityCase> {
    const permdock = await createPermDock(
      policy,
      scenario.user,
      scenario.options,
    );
    if (scenario.options?.relations !== undefined) {
      await permdock.loadRelations(scenario.permission, scenario.rows);
    }
    // SAFETY: scenario rows are object rows; the id field value stays unknown for sortedIds.
    const expected = sortedIds(
      permdock
        .filter(scenario.permission, scenario.rows)
        .map((row) => (row as Readonly<Record<string, unknown>>)[idField]),
    );
    const where = permdock.where(scenario.permission);
    try {
      const actual = sortedIds(await options.run({ scenario, where }));
      const ok = where.partial
        ? subsetOf(actual, expected)
        : actual.length === expected.length && subsetOf(actual, expected);
      return {
        name: scenario.name,
        expected,
        actual,
        partial: where.partial,
        ok,
      };
    } catch (error) {
      return {
        name: scenario.name,
        expected,
        actual: [],
        partial: where.partial,
        error: error instanceof Error ? error.message : String(error),
        ok: where.partial,
      };
    }
  }

  const results: OrmParityCase[] = [];
  for (const scenario of scenarios) {
    results.push(await runCase(scenario));
  }
  return { ok: results.every((item) => item.ok), results };
}
