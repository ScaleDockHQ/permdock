import {
  type Decision,
  fromSnapshot,
  listPermissions,
  getPermDock,
  type PermDock,
  type PermDockOptions,
  type Policy,
} from "../index.ts";

export type MatrixOutcome = "granted" | "denied" | "approval-required";

export type MatrixCell =
  | MatrixOutcome
  | {
      readonly outcome?: MatrixOutcome;
      readonly denials?: readonly {
        readonly role?: string | null;
        readonly reason: string;
      }[];
      readonly alternatives?: readonly string[];
      /**
       * Obligation kinds a granted decision carries, in order; `[]` asserts
       * none.
       */
      readonly obligations?: readonly string[];
      /** The `name` of the deny grant `explain` reports as the one that won. */
      readonly deniedBy?: string;
    };

export type DescribePolicyConfig<TSubject> = {
  readonly subjects: Record<string, TSubject>;
  readonly fixtures?: Record<string, unknown>;
  readonly matrix: Record<
    string,
    Record<string, MatrixCell | Record<string, MatrixCell>>
  >;
  readonly exhaustive?: boolean;
  readonly options?: PermDockOptions;
  /**
   * Also assert every granted or denied cell against
   * `fromSnapshot(permdock.snapshot())`, the client a Server Component hands
   * down. Closures cannot cross a snapshot and deny on the client.
   */
  readonly snapshot?: boolean;
};

/** One cell of the matrix, decided. */
export type PolicyMatrixCell = {
  /**
   * `<permission> / <subject>`, or `<permission> / <fixture> / <subject>` for a
   * nested row.
   */
  readonly name: string;
  readonly permission: string;
  readonly subject: string;
  readonly fixture?: string;
  readonly expected: MatrixCell;
  readonly actual: MatrixOutcome;
  readonly decision: Decision;
  /** Each way the decision differs from `expected`; empty when the cell holds. */
  readonly failures: readonly string[];
};

export type PolicyMatrixReport = {
  readonly cells: readonly PolicyMatrixCell[];
  /** Permission keys the matrix has no row for; empty with `exhaustive: false`. */
  readonly missing: readonly string[];
};

function isOutcomeCell(value: unknown): value is MatrixCell {
  return (
    value === "granted" ||
    value === "denied" ||
    value === "approval-required" ||
    (value !== null &&
      typeof value === "object" &&
      ("denials" in value ||
        "outcome" in value ||
        "alternatives" in value ||
        "obligations" in value ||
        "deniedBy" in value))
  );
}

function expectedOutcome(cell: MatrixCell): MatrixOutcome {
  return typeof cell === "string" ? cell : (cell.outcome ?? "denied");
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function list(values: readonly string[]): string {
  return `[${values.join(", ")}]`;
}

function decisionFailures(decision: Decision, cell: MatrixCell): string[] {
  const expected = expectedOutcome(cell);
  if (decision.outcome !== expected) {
    return [`expected ${expected}, got ${decision.outcome}`];
  }
  if (typeof cell !== "object") {
    return [];
  }
  const failures: string[] = [];
  if (cell.denials !== undefined && decision.outcome === "denied") {
    for (const denial of cell.denials) {
      const found = decision.denials.some(
        (item) =>
          item.reason === denial.reason &&
          (denial.role === undefined || item.role === denial.role),
      );
      if (!found) {
        failures.push(
          `no denial ${denial.reason}${denial.role === undefined ? "" : ` for role ${String(denial.role)}`}; got ${list(decision.denials.map((item) => `${item.reason}${item.role === null ? "" : `@${item.role}`}`))}`,
        );
      }
    }
  }
  if (cell.alternatives !== undefined && decision.outcome === "denied") {
    const actual = decision.alternatives.map((leaf) => leaf.key);
    if (!same(actual, cell.alternatives)) {
      failures.push(
        `alternatives: expected ${list(cell.alternatives)}, got ${list(actual)}`,
      );
    }
  }
  if (cell.obligations !== undefined && decision.outcome === "granted") {
    const actual = (decision.obligations ?? []).map((item) => item.kind);
    if (!same(actual, cell.obligations)) {
      failures.push(
        `obligations: expected ${list(cell.obligations)}, got ${list(actual)}`,
      );
    }
  }
  return failures;
}

/**
 * `deniedBy`, against the trace of a fresh `explain` call for the same
 * arguments.
 */
function deniedByFailures(
  instance: PermDock,
  permission: unknown,
  data: unknown,
  cell: MatrixCell,
): string[] {
  if (typeof cell !== "object" || cell.deniedBy === undefined) {
    return [];
  }
  // SAFETY: permission is a leaf of the policy under test; explain() accepts any row at runtime.
  const explained = instance.explain(permission as never, data as never);
  const winner = explained.trace.denies[0]?.name;
  if (explained.outcome !== "denied" || winner !== cell.deniedBy) {
    return [
      `deniedBy: expected ${cell.deniedBy}, explain answered ${explained.outcome}${winner === undefined ? "" : ` by ${winner}`}`,
    ];
  }
  return [];
}

function snapshotFailures(
  instance: PermDock,
  permission: unknown,
  data: unknown,
  cell: MatrixCell,
): string[] {
  const outcome = expectedOutcome(cell);
  if (outcome === "approval-required") {
    return [];
  }
  // SAFETY: a JSON round trip of the instance's own snapshot, as a client would receive it.
  const client = fromSnapshot(
    JSON.parse(JSON.stringify(instance.snapshot())) as never,
  );
  // SAFETY: permission is a leaf of the policy under test; can() accepts any row at runtime.
  const granted = client.can(permission as never, data as never);
  return granted === (outcome === "granted")
    ? []
    : ["snapshot client disagrees with the server"];
}

type PendingCell = {
  readonly name: string;
  readonly permission: ReturnType<typeof listPermissions>[number];
  readonly subject: string;
  readonly fixture?: string;
  readonly data: unknown;
  readonly expected: MatrixCell;
};

/** The cells `config.matrix` names, in matrix order, before any decision. */
function pendingCells<TSubject>(
  policy: Policy,
  config: DescribePolicyConfig<TSubject>,
): readonly PendingCell[] {
  const cells: PendingCell[] = [];
  for (const permission of listPermissions(policy.permissions)) {
    const spec = config.matrix[permission.key];
    if (spec === undefined) {
      continue;
    }
    const nested = Object.values(spec).some((value) => !isOutcomeCell(value));
    if (!nested) {
      const data =
        permission.kind === "instance"
          ? Object.values(config.fixtures ?? {})[0]
          : undefined;
      // SAFETY: nested is false, so every value in spec passed isOutcomeCell.
      for (const [subject, cell] of Object.entries(spec) as [
        string,
        MatrixCell,
      ][]) {
        cells.push({
          name: `${permission.key} / ${subject}`,
          permission,
          subject,
          data,
          expected: cell,
        });
      }
      continue;
    }
    for (const [fixture, row] of Object.entries(spec)) {
      if (isOutcomeCell(row)) {
        continue;
      }
      for (const [subject, cell] of Object.entries(row)) {
        cells.push({
          name: `${permission.key} / ${fixture} / ${subject}`,
          permission,
          subject,
          fixture,
          data: config.fixtures?.[fixture],
          expected: cell,
        });
      }
    }
  }
  return cells;
}

/**
 * Where each cell sits, without deciding it: a test runner registers one test
 * per cell.
 */
export function policyMatrixLayout<TSubject>(
  policy: Policy,
  config: DescribePolicyConfig<TSubject>,
): readonly {
  readonly name: string;
  readonly permission: string;
  readonly subject: string;
  readonly fixture?: string;
}[] {
  return pendingCells(policy, config).map((cell) =>
    cell.fixture === undefined
      ? {
          name: cell.name,
          permission: cell.permission.key,
          subject: cell.subject,
        }
      : {
          name: cell.name,
          permission: cell.permission.key,
          subject: cell.subject,
          fixture: cell.fixture,
        },
  );
}

/**
 * Decides every cell of a policy matrix with no test runner: each cell lists
 * its `failures`, and `missing` names the permissions an exhaustive matrix
 * leaves out. `describePolicy` asserts the same report under Vitest.
 */
export async function policyMatrix<TSubject>(
  policy: Policy,
  config: DescribePolicyConfig<TSubject>,
): Promise<PolicyMatrixReport> {
  const instances = new Map<string, PermDock>();
  for (const [name, user] of Object.entries(config.subjects)) {
    instances.set(name, await getPermDock(policy, user, config.options));
  }
  const cells: PolicyMatrixCell[] = [];
  for (const pending of pendingCells(policy, config)) {
    const instance =
      instances.get(pending.subject) ??
      (await getPermDock(
        policy,
        config.subjects[pending.subject],
        config.options,
      ));
    // SAFETY: permission is a leaf of the policy under test; decide() accepts any row.
    const decision = instance.decide(
      pending.permission as never,
      pending.data as never,
    );
    const failures = [
      ...decisionFailures(decision, pending.expected),
      ...deniedByFailures(
        instance,
        pending.permission,
        pending.data,
        pending.expected,
      ),
      ...(config.snapshot === true
        ? snapshotFailures(
            instance,
            pending.permission,
            pending.data,
            pending.expected,
          )
        : []),
    ];
    cells.push({
      name: pending.name,
      permission: pending.permission.key,
      subject: pending.subject,
      ...(pending.fixture === undefined ? {} : { fixture: pending.fixture }),
      expected: pending.expected,
      actual: decision.outcome,
      decision,
      failures,
    });
  }
  const missing =
    config.exhaustive === false
      ? []
      : listPermissions(policy.permissions)
          .map((permission) => permission.key)
          .filter((key) => config.matrix[key] === undefined);
  return { cells, missing };
}
