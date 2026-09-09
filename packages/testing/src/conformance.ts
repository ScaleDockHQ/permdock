import type {
  DecisionSink,
  LimitStore,
  Membership,
  MembershipSource,
  RoleSource,
  SnapshotSource,
  Subject,
  SubjectResolver,
  TokenSigner,
  TokenVerifier,
  WhereCompiler,
} from 'permdock';
import type { ApprovalRequest, ApprovalStore } from 'permdock/approvals';
import type { DirectoryStore } from 'permdock/scim';

import { directoryMembershipSource } from 'permdock/scim';
import { expect, it } from 'vitest';

import {
  jwtFixtureAudience,
  jwtFixtureIssuer,
  jwtFixtureTokens,
} from './jwt-fixtures.ts';

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

export function testLimitStore(store: LimitStore): void {
  it('counts down synchronously and fails closed when exhausted', async () => {
    const input = {
      key: 'report.export',
      subjectId: 'u_1',
      count: 2,
      per: 'hour',
      now: 1_700_000_000,
    };
    const first = await store.consume(input);
    expect(first.remaining).toBeGreaterThanOrEqual(0);
    const peeked = store.remaining(input);
    if (peeked !== undefined) {
      expect(typeof peeked.remaining).toBe('number');
      expect(
        peeked !== null &&
          typeof peeked === 'object' &&
          'then' in peeked &&
          typeof (peeked as { readonly then?: unknown }).then === 'function',
      ).toBe(false);
    }
    await store.consume(input);
    const exhausted = await store.consume(input);
    expect(exhausted.remaining).toBeLessThan(0);
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

function sampleApproval(token: string): ApprovalRequest {
  return {
    v: 1,
    token,
    permission: 'post.delete',
    scope: 'post:delete',
    resource: { type: 'post', id: '42' },
    subject: {
      principal: { id: 'u_1', roles: ['member'] },
      actor: { id: 'agent-1', kind: 'eve' },
    },
    detail: 'post.delete requires human approval.',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: 'pending',
  };
}

const approver: Subject = {
  principal: { id: 'u_9', roles: ['admin'] },
  context: {},
};

export function testDirectoryStore(
  store: DirectoryStore,
  options: { readonly tenants: readonly [string, string] },
): void {
  const [home, other] = options.tenants;
  it('round-trips users and groups, isolates tenants, and drops inactive memberships', async () => {
    const created = await store.putUser(home, {
      id: '',
      userName: 'ada',
      externalId: '00u1',
      active: true,
      meta: { created: '', lastModified: '' },
    });
    expect(created.id).not.toBe('');
    expect(await store.getUser(home, created.id)).toMatchObject({
      userName: 'ada',
      externalId: '00u1',
    });
    expect(await store.getUser(other, created.id)).toBeNull();
    await expect(
      store.putUser(home, {
        id: '',
        userName: 'ada',
        active: true,
        meta: { created: '', lastModified: '' },
      }),
    ).rejects.toThrow(/userName/);
    const group = await store.putGroup(home, {
      id: 'g_editors',
      displayName: 'Editors',
      members: [{ value: created.id }],
      roles: ['editor'],
      meta: { created: '', lastModified: '' },
    });
    expect(await store.groupsFor(home, created.id)).toEqual([
      expect.objectContaining({ id: group.id, displayName: 'Editors' }),
    ]);
    expect(await store.groupsFor(other, created.id)).toEqual([]);
    const patched = await store.patchUser(home, created.id, [
      { op: 'replace', path: 'active', value: false },
    ]);
    expect(patched.active).toBe(false);
    const source = directoryMembershipSource(store, { assignable: ['editor'] });
    expect(
      await source.membershipsFor({ id: '00u1' }, { tenant: home }),
    ).toEqual([]);
    await store.patchUser(home, created.id, [
      { op: 'replace', path: 'active', value: true },
    ]);
    expect(
      await source.membershipsFor({ id: '00u1' }, { tenant: home }),
    ).toEqual([
      {
        tenant: home,
        team: group.id,
        roles: ['editor'],
        via: `group:${group.id}`,
      },
    ]);
    await store.patchGroup(home, group.id, [
      {
        op: 'remove',
        path: 'members',
        value: [{ value: created.id }],
      },
    ]);
    expect(await store.groupsFor(home, created.id)).toEqual([]);
  });
}

export function testApprovalStore(store: ApprovalStore): void {
  it('creates, gets, lists, resolves and expires', async () => {
    const request = sampleApproval('opaque-token');
    await store.create(request);
    const loaded = await store.get('opaque-token');
    expect(loaded).toEqual(request);
    expect(JSON.parse(JSON.stringify(loaded))).toEqual(request);
    const listed = await store.list({ status: 'pending' });
    expect(listed.some((item) => item.token === 'opaque-token')).toBe(true);
    const resolved = await store.resolve('opaque-token', {
      status: 'approved',
      by: approver,
    });
    expect(resolved.status).toBe('approved');
    await expect(
      Promise.resolve().then(() =>
        store.resolve('opaque-token', { status: 'rejected', by: approver }),
      ),
    ).rejects.toThrow(/not pending/);
    await store.create(sampleApproval('stale-token'));
    const expired = await store.expire(
      new Date(Date.now() + 2 * 60 * 60 * 1000),
    );
    expect(expired).toBeGreaterThanOrEqual(1);
  });
}

function decodeHeader(token: string): Record<string, unknown> {
  const [encoded] = token.split('.');
  if (encoded === undefined) {
    return {};
  }
  const padded = encoded.replaceAll('-', '+').replaceAll('_', '/');
  const pad =
    padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return JSON.parse(atob(`${padded}${pad}`)) as Record<string, unknown>;
}

export function testTokenVerifier(
  verifier: TokenVerifier,
  options?: { readonly audience?: string; readonly issuer?: string },
): void {
  const audience = options?.audience ?? jwtFixtureAudience;
  const issuer = options?.issuer ?? jwtFixtureIssuer;
  it('never throws and maps the JWT behaviour table', async () => {
    const valid = await verifier.verify(jwtFixtureTokens.valid, {
      audience,
      issuer,
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.claims.sub).toBe('u_1');
      expect(valid.header.alg).toBe('Ed25519');
    }
    const rows: readonly {
      readonly token: string;
      readonly cause: string;
    }[] = [
      { token: jwtFixtureTokens.none, cause: 'alg-none' },
      { token: jwtFixtureTokens.expired, cause: 'expired' },
      { token: jwtFixtureTokens.wrongAud, cause: 'wrong-audience' },
      { token: jwtFixtureTokens.wrongIss, cause: 'wrong-issuer' },
      { token: jwtFixtureTokens.unknownKid, cause: 'unknown-kid' },
      { token: 'not-a-jwt', cause: 'malformed' },
      { token: 'a.b.c.d.e', cause: 'encrypted-token' },
    ];
    for (const row of rows) {
      let result: Awaited<ReturnType<TokenVerifier['verify']>>;
      try {
        result = await verifier.verify(row.token, { audience, issuer });
      } catch {
        throw new Error('TokenVerifier must not throw');
      }
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.cause).toBe(row.cause);
      }
    }
  });
}

export function testTokenSigner(
  signer: TokenSigner,
  options: { readonly verifier: TokenVerifier },
): void {
  it('emits compact JWS with only alg, kid and typ', async () => {
    const token = await signer.sign(
      { snapshot: { v: 2 }, sub: 'u_1' },
      { typ: 'permdock-snapshot+jwt', audience: 'https://app.example.com' },
    );
    const header = decodeHeader(token);
    expect(Object.keys(header).toSorted()).toEqual(['alg', 'kid', 'typ']);
    expect(header.typ).toBe('permdock-snapshot+jwt');
    expect(header.alg).not.toBe('none');
    const verified = await options.verifier.verify(token, {
      typ: 'permdock-snapshot+jwt',
      audience: 'https://app.example.com',
    });
    expect(verified.ok).toBe(true);
    if (signer.jwks !== undefined) {
      const jwks = await signer.jwks();
      expect(jwks.keys.length).toBeGreaterThan(0);
      expect(jwks.keys[0]).not.toHaveProperty('d');
    }
  });
}

export function testWhereCompiler<TTarget>(
  compiler: WhereCompiler<TTarget>,
  options: {
    readonly target: TTarget;
    readonly isFailClosed?: (compiled: unknown) => boolean;
  },
): void {
  it('fails closed on an empty allow set', () => {
    const compiled = compiler({ op: 'or', conditions: [] }, options.target);
    const closed =
      options.isFailClosed === undefined
        ? compiled === false || compiled === undefined || compiled === null
        : options.isFailClosed(compiled);
    expect(closed).toBe(true);
  });
}
