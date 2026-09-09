import {
  createPermDock,
  listPermissions,
  type CreatePermDockOptions,
  type Decision,
  type Policy,
} from 'permdock';
import { beforeAll, describe, expect, it } from 'vitest';

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
    };

export type DescribePolicyConfig<TSubject> = {
  readonly subjects: Record<string, TSubject>;
  readonly fixtures?: Record<string, unknown>;
  readonly matrix: Record<
    string,
    Record<string, MatrixCell | Record<string, MatrixCell>>
  >;
  readonly exhaustive?: boolean;
  readonly options?: CreatePermDockOptions;
};

function isOutcomeCell(value: unknown): value is MatrixCell {
  return (
    value === 'granted' ||
    value === 'denied' ||
    value === 'approval-required' ||
    (value !== null &&
      typeof value === 'object' &&
      ('denials' in value || 'outcome' in value || 'alternatives' in value))
  );
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
}

export function describePolicy<TSubject>(
  policy: Policy,
  config: DescribePolicyConfig<TSubject>,
): void {
  describe('policy matrix', () => {
    const permissions = listPermissions(policy.permissions);
    const docks = new Map<string, Awaited<ReturnType<typeof createPermDock>>>();

    beforeAll(async () => {
      for (const [name, user] of Object.entries(config.subjects)) {
        docks.set(name, await createPermDock(policy, user, config.options));
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
          for (const [subjectName, cell] of Object.entries(spec) as [
            string,
            MatrixCell,
          ][]) {
            it(`${subjectName}`, async () => {
              const instance =
                docks.get(subjectName) ??
                (await createPermDock(
                  policy,
                  config.subjects[subjectName],
                  config.options,
                ));
              const data =
                permission.kind === 'instance'
                  ? Object.values(config.fixtures ?? {})[0]
                  : undefined;
              assertCell(
                instance.decide(permission as never, data as never),
                cell,
              );
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
                docks.get(subjectName) ??
                (await createPermDock(
                  policy,
                  config.subjects[subjectName],
                  config.options,
                ));
              const fixture = config.fixtures?.[fixtureName];
              assertCell(
                instance.decide(permission as never, fixture as never),
                cell as MatrixCell,
              );
            });
          }
        }
      });
    }
  });
}
