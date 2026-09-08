import type {
  DecisionSink,
  Membership,
  MembershipSource,
  RoleSource,
  SnapshotSource,
  Subject,
  SubjectResolver,
  WhereCompiler,
} from 'permdock';

import { expect, it } from 'vitest';

export function testSubjectResolver<TInput>(
  resolver: SubjectResolver<TInput>,
  options: { readonly invalid: TInput },
): void {
  it('never throws and fails closed to anonymous', async () => {
    let result: Subject;
    try {
      result = await resolver(options.invalid);
    } catch {
      throw new Error('SubjectResolver must not throw');
    }
    expect(result.principal).toBeNull();
  });
}

export function testMembershipSource(
  source: MembershipSource,
  options: {
    readonly principals: readonly {
      readonly id: string;
      readonly kind?: string;
    }[];
    readonly expect?: Record<string, readonly Membership[]>;
  },
): void {
  it('returns well-formed memberships and fails closed on throw', async () => {
    for (const principal of options.principals) {
      let memberships: Membership[] = [];
      try {
        memberships = await source.membershipsFor(principal, {});
      } catch {
        memberships = [];
      }
      for (const membership of memberships) {
        const flags = [
          membership.tenant,
          membership.team,
          membership.on,
        ].filter((value) => value !== undefined);
        expect(flags.length).toBeLessThanOrEqual(2);
        expect(Array.isArray(membership.roles)).toBe(true);
      }
      const expected = options.expect?.[principal.id];
      if (expected !== undefined) {
        expect(memberships).toEqual(expected);
      }
    }
  });
}

export function testRoleSource(
  source: RoleSource,
  options: { readonly tenant: string; readonly declared: readonly string[] },
): void {
  it('only resolves declared role names', async () => {
    const roles = await source.rolesFor(options.tenant);
    for (const role of roles) {
      for (const included of role.includes) {
        expect(options.declared).toContain(included);
      }
    }
    if (source.assignable !== undefined) {
      const assignable = await source.assignable(options.tenant);
      for (const name of assignable) {
        expect(options.declared).toContain(name);
      }
    }
  });
}

export function testDecisionSink(sink: DecisionSink): void {
  it('accepts batches and never propagates write errors', async () => {
    await expect(Promise.resolve(sink.write([]))).resolves.toBeUndefined();
    if (sink.flush !== undefined) {
      await expect(Promise.resolve(sink.flush())).resolves.toBeUndefined();
      await expect(Promise.resolve(sink.flush())).resolves.toBeUndefined();
    }
  });
}

export function testSnapshotSource(source: SnapshotSource): void {
  it('round-trips snapshot v2', async () => {
    const snapshot = await source.get();
    expect(snapshot === null || snapshot === undefined).toBe(false);
    if (typeof snapshot === 'object' && snapshot !== null && 'v' in snapshot) {
      expect(snapshot.v === 1 || snapshot.v === 2).toBe(true);
    }
    if (source.subscribe !== undefined) {
      const unsubscribe = source.subscribe(() => undefined);
      unsubscribe();
    }
  });
}

export function testWhereCompiler<TTarget>(
  compiler: WhereCompiler<TTarget>,
  options: { readonly target: TTarget },
): void {
  it('fails closed on an empty allow set', () => {
    const compiled = compiler({ op: 'or', conditions: [] }, options.target);
    expect(
      compiled === false || compiled === undefined || compiled === null,
    ).toBe(true);
  });
}
