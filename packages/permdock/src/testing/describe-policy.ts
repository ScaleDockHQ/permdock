import { beforeAll, describe, expect, it } from 'vitest';

import {
  createPermDock,
  fromSnapshot,
  listPermissions,
  type PermDockOptions,
  type Decision,
  type Policy,
} from '../index.ts';

export type MatrixOutcome = 'granted' | 'denied' | 'approval-required';

export type MatrixCell =
  | MatrixOutcome
  | {
      readonly outcome?: MatrixOutcome;
      readonly denials?: readonly {
        readonly role?: string | null;
        readonly reason: string;
      }[];
      readonly alternatives?: readonly string[];
      /** Obligation kinds a granted decision carries, in order; `[]` asserts none. */
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
   * Also assert every granted or denied cell against `fromSnapshot(permdock.snapshot())`,
   * the client a Server Component hands down. Closures cannot cross a snapshot and deny on the client.
   */
  readonly snapshot?: boolean;
};

function isOutcomeCell(value: unknown): value is MatrixCell {
  return (
    value === 'granted' ||
    value === 'denied' ||
    value === 'approval-required' ||
    (value !== null &&
      typeof value === 'object' &&
      ('denials' in value ||
        'outcome' in value ||
        'alternatives' in value ||
        'obligations' in value ||
        'deniedBy' in value))
  );
}

/** Asserts `deniedBy` against the trace of a fresh `explain` call for the same arguments. */
function assertDeniedBy(
  instance: Awaited<ReturnType<typeof createPermDock>>,
  permission: unknown,
  data: unknown,
  cell: MatrixCell,
): void {
  if (typeof cell !== 'object' || cell.deniedBy === undefined) {
    return;
  }
  // SAFETY: permission is a leaf of the policy under test; explain() accepts any row at runtime.
  const explained = instance.explain(permission as never, data as never);
  expect(explained.outcome).toBe('denied');
  expect(explained.trace.denies[0]?.name).toBe(cell.deniedBy);
}

function expectedOutcome(cell: MatrixCell): MatrixOutcome {
  return typeof cell === 'string' ? cell : (cell.outcome ?? 'denied');
}

function assertCell(decision: Decision, cell: MatrixCell): void {
  expect(decision.outcome).toBe(expectedOutcome(cell));
  if (
    typeof cell === 'object' &&
    cell.denials !== undefined &&
    decision.outcome === 'denied'
  ) {
    for (const denial of cell.denials) {
      expect(
        decision.denials.some(
          (item) =>
            item.reason === denial.reason &&
            (denial.role === undefined || item.role === denial.role),
        ),
      ).toBe(true);
    }
  }
  if (
    typeof cell === 'object' &&
    cell.alternatives !== undefined &&
    decision.outcome === 'denied'
  ) {
    expect(decision.alternatives.map((leaf) => leaf.key)).toEqual(
      cell.alternatives,
    );
  }
  if (
    typeof cell === 'object' &&
    cell.obligations !== undefined &&
    decision.outcome === 'granted'
  ) {
    expect((decision.obligations ?? []).map((item) => item.kind)).toEqual(
      cell.obligations,
    );
  }
}

function assertSnapshotCell(
  instance: Awaited<ReturnType<typeof createPermDock>>,
  permission: unknown,
  data: unknown,
  cell: MatrixCell,
): void {
  const outcome = expectedOutcome(cell);
  if (outcome === 'approval-required') {
    return;
  }
  // SAFETY: a JSON round trip of the instance's own snapshot, as a client would receive it.
  const client = fromSnapshot(
    JSON.parse(JSON.stringify(instance.snapshot())) as never,
  );
  // SAFETY: permission is a leaf of the policy under test; can() accepts any row at runtime.
  expect(
    client.can(permission as never, data as never),
    'snapshot client disagrees with the server',
  ).toBe(outcome === 'granted');
}

export function describePolicy<TSubject>(
  policy: Policy,
  config: DescribePolicyConfig<TSubject>,
): void {
  describe('policy matrix', () => {
    const permissions = listPermissions(policy.permissions);
    const permdocks = new Map<
      string,
      Awaited<ReturnType<typeof createPermDock>>
    >();

    beforeAll(async () => {
      for (const [name, user] of Object.entries(config.subjects)) {
        permdocks.set(name, await createPermDock(policy, user, config.options));
      }
    });

    it('covers every permission', () => {
      if (config.exhaustive === false) {
        return;
      }
      for (const permission of permissions) {
        expect(
          config.matrix[permission.key],
          `missing matrix for ${permission.key}`,
        ).toBeDefined();
      }
    });

    for (const permission of permissions) {
      const spec = config.matrix[permission.key];
      if (spec === undefined) {
        continue;
      }
      describe(permission.key, () => {
        const nested = Object.values(spec).some(
          (value) => !isOutcomeCell(value),
        );
        if (!nested) {
          // SAFETY: nested is false, so every value in spec passed isOutcomeCell.
          for (const [subjectName, cell] of Object.entries(spec) as [
            string,
            MatrixCell,
          ][]) {
            it(`${subjectName}`, async () => {
              const instance =
                permdocks.get(subjectName) ??
                (await createPermDock(
                  policy,
                  config.subjects[subjectName],
                  config.options,
                ));
              const data =
                permission.kind === 'instance'
                  ? Object.values(config.fixtures ?? {})[0]
                  : undefined;
              // SAFETY: permission is a leaf of the policy under test; decide() accepts any row.
              assertCell(
                instance.decide(permission as never, data as never),
                cell,
              );
              assertDeniedBy(instance, permission, data, cell);
              if (config.snapshot === true) {
                assertSnapshotCell(instance, permission, data, cell);
              }
            });
          }
          return;
        }
        for (const [fixtureName, row] of Object.entries(spec)) {
          if (isOutcomeCell(row)) {
            continue;
          }
          for (const [subjectName, cell] of Object.entries(row)) {
            it(`${fixtureName} / ${subjectName}`, async () => {
              const instance =
                permdocks.get(subjectName) ??
                (await createPermDock(
                  policy,
                  config.subjects[subjectName],
                  config.options,
                ));
              const fixture = config.fixtures?.[fixtureName];
              // SAFETY: a leaf of the policy under test; cell sits in a nested row, so it is a MatrixCell.
              assertCell(
                instance.decide(permission as never, fixture as never),
                cell as MatrixCell,
              );
              // SAFETY: cell sits in a nested fixture row of the matrix, so it is a MatrixCell.
              assertDeniedBy(instance, permission, fixture, cell as MatrixCell);
              if (config.snapshot === true) {
                // SAFETY: cell sits in a nested fixture row of the matrix, so it is a MatrixCell.
                assertSnapshotCell(
                  instance,
                  permission,
                  fixture,
                  cell as MatrixCell,
                );
              }
            });
          }
        }
      });
    }
  });
}
