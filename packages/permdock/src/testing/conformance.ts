import { expect, it, vi } from 'vitest';

import type { ApprovalRequest, ApprovalStore } from '../approvals/index.ts';
import type {
  CredentialVerifier,
  DecisionSink,
  EntitlementSource,
  LimitStore,
  Membership,
  MembershipSource,
  Policy,
  PolicyDocument,
  PolicySource,
  RevocationEvent,
  RevocationFeed,
  Role,
  RoleSource,
  SettingsSource,
  SnapshotSource,
  Subject,
  SubjectResolver,
  TokenSigner,
  TokenVerifier,
  WhereCompiler,
} from '../index.ts';
import type { DirectoryStore } from '../scim/index.ts';
import type { ReplayStore } from '../ssf/index.ts';

import { normalizeMemberships, scopeList } from '../core/scopes.ts';
import {
  memoryRevocationFeed,
  mergeHostedGrants,
  parseCredential,
  parsePolicyDocument,
  validateCustomRole,
} from '../index.ts';
import {
  directoryMembershipSource,
  scimHandler,
  sha256Hex,
} from '../scim/index.ts';
import { parseApiKey } from '../server/credentials.ts';
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
    /** With the policy, every membership must name one of its scopes and carry its parent ids. */
    readonly policy?: Policy;
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
        const named = membership.scope !== undefined;
        const legacy =
          membership.tenant !== undefined || membership.team !== undefined;
        const shapes = [named, legacy, membership.on !== undefined].filter(
          Boolean,
        );
        expect(shapes.length).toBe(1);
        expect(Array.isArray(membership.roles)).toBe(true);
        if (options.policy !== undefined) {
          expect(
            normalizeMemberships(
              [membership],
              scopeList(options.policy.scopes),
            ),
          ).toHaveLength(1);
        }
      }
      const expected = options.expect?.[principal.id];
      if (expected !== undefined) {
        expect(memberships).toEqual(expected);
      }
    }
  });
  if (source.list !== undefined) {
    it('lists every member of an instance it returns a membership for', async () => {
      for (const principal of options.principals) {
        let memberships: Membership[] = [];
        try {
          memberships = await source.membershipsFor(principal, {});
        } catch {
          continue;
        }
        for (const membership of memberships) {
          if (membership.scope === undefined || membership.id === undefined) {
            continue;
          }
          const members =
            (await source.list?.({
              scope: membership.scope,
              id: membership.id,
            })) ?? [];
          expect(
            members.some(
              (entry) =>
                entry.principal.id === principal.id &&
                entry.membership.scope === membership.scope &&
                entry.membership.id === membership.id,
            ),
          ).toBe(true);
        }
      }
    });
  }
  if (source.version !== undefined) {
    it('reports a finite version or none', async () => {
      for (const principal of options.principals) {
        const version = await source.version?.({ id: principal.id });
        expect(
          version === undefined ||
            (typeof version === 'number' && Number.isFinite(version)),
        ).toBe(true);
      }
    });
  }
}

export function testEntitlementSource(
  source: EntitlementSource,
  options: {
    readonly principal: { readonly id: string };
    readonly tenant: string;
    readonly expect?: readonly string[];
  },
): void {
  it('returns plan names for a tenant and none without one', async () => {
    const found = await source.entitlementsFor(options.principal, {
      tenant: options.tenant,
    });
    expect(Array.isArray(found)).toBe(true);
    for (const name of found) {
      expect(typeof name).toBe('string');
    }
    if (options.expect !== undefined) {
      expect([...found].toSorted()).toEqual([...options.expect].toSorted());
    }
    expect(await source.entitlementsFor(options.principal, {})).toEqual([]);
  });
}

export function testRoleSource(
  source: RoleSource,
  options: {
    readonly tenant: string;
    readonly declared: readonly (string | Role)[];
    /** When set, every custom role's `grants` must resolve inside the ceiling. */
    readonly policy?: Policy;
  },
): void {
  it('only resolves declared role names', async () => {
    const declared = options.declared.map((item) =>
      typeof item === 'string' ? item : item.key,
    );
    const roles = await source.rolesFor(options.tenant);
    for (const role of roles) {
      expect(role.tenant).toBe(options.tenant);
      for (const included of role.includes ?? []) {
        expect(declared).toContain(included);
      }
      if (options.policy !== undefined) {
        expect(validateCustomRole(options.policy, role).dropped).toEqual([]);
      }
    }
    if (source.assignable !== undefined) {
      const assignable = await source.assignable(options.tenant);
      for (const name of assignable) {
        expect(declared).toContain(name);
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
    await expect(
      Promise.resolve(
        sink.write([
          {
            type: 'membership',
            at: new Date().toISOString(),
            source: 'app',
            operation: 'changed',
            principal: { id: 'u_1' },
            roles: { added: ['admin'], removed: ['member'] },
          },
        ]),
      ),
    ).resolves.toBeUndefined();
    await expect(Promise.resolve(sink.write([]))).resolves.toBeUndefined();
    if (sink.flush !== undefined) {
      await expect(Promise.resolve(sink.flush())).resolves.toBeUndefined();
      await expect(Promise.resolve(sink.flush())).resolves.toBeUndefined();
    }
  });
}

export function testSnapshotSource(source: SnapshotSource): void {
  it('round-trips a snapshot', async () => {
    const snapshot = await source.get();
    expect(snapshot === null || snapshot === undefined).toBe(false);
    if (typeof snapshot === 'object' && snapshot !== null && 'v' in snapshot) {
      expect(snapshot.v).toBe(1);
    }
    if (source.subscribe !== undefined) {
      const unsubscribe = source.subscribe(() => undefined);
      unsubscribe();
    }
  });
}

export function testPolicySource(
  source: PolicySource,
  options: { readonly policy?: Policy } = {},
): void {
  const readCurrent = (): PolicyDocument | null => {
    const document = source.current();
    expect(
      document !== null &&
        typeof document === 'object' &&
        'then' in document &&
        typeof (document as { readonly then?: unknown }).then === 'function',
    ).toBe(false);
    return document;
  };

  it('returns null or a v1 policy document synchronously', () => {
    const document = readCurrent();
    if (document !== null) {
      expect(parsePolicyDocument(document)).toEqual(document);
    }
  });

  it('refreshes without rejecting and keeps current() synchronous', async () => {
    await expect(Promise.resolve(source.refresh())).resolves.toBeUndefined();
    const document = readCurrent();
    if (document !== null) {
      expect(document.v).toBe(1);
    }
  });

  if (options.policy !== undefined) {
    const policy = options.policy;
    it('merges only grants on hostable permissions', () => {
      const document = readCurrent();
      const merged = mergeHostedGrants(policy, document);
      for (const grant of merged.policy.grants) {
        if (grant.hosted !== undefined) {
          expect(policy.hostable).toContain(grant.permission.key);
        }
      }
      for (const dropped of merged.dropped) {
        expect(dropped.kind).toBe('hosted-grant-dropped');
      }
    });
  }
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

export function testReplayStore(store: ReplayStore): void {
  it('records a jti after remember and reports it as seen', async () => {
    const jti = 'jti-1';
    expect(await store.seen(jti)).toBe(false);
    await store.remember(jti);
    expect(await store.seen(jti)).toBe(true);
    expect(await store.seen('jti-2')).toBe(false);
  });

  it('forgets a jti whose expiresAt has passed', async () => {
    await store.remember('ttl-jti', Math.floor(Date.now() / 1000) - 1);
    expect(await store.seen('ttl-jti')).toBe(false);
  });

  it('claims a key once under concurrency and releases it for a retry', async (context) => {
    if (store.claim === undefined || store.release === undefined) {
      context.skip();
      return;
    }
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const results = await Promise.all([
      store.claim('claim-key', expiresAt),
      store.claim('claim-key', expiresAt),
    ]);
    expect(results.toSorted()).toEqual([false, true]);
    expect(await store.seen('claim-key')).toBe(true);
    await store.release('claim-key');
    expect(await store.claim('claim-key', expiresAt)).toBe(true);
  });
}

export function testRevocationFeed(feed: RevocationFeed): void {
  it('delivers each event to every subscriber until it unsubscribes', async () => {
    const first: RevocationEvent[] = [];
    const second: RevocationEvent[] = [];
    const stopFirst = feed.subscribe((event) => {
      first.push(event);
    });
    const stopSecond = feed.subscribe((event) => {
      second.push(event);
    });
    const revoked: RevocationEvent = {
      principal: 'u-feed',
      session: 's-feed',
      kind: 'session-revoked',
    };
    await feed.revoke(revoked);
    await vi.waitFor(() => {
      expect(first).toEqual([revoked]);
      expect(second).toEqual([revoked]);
    });
    stopFirst();
    const changed: RevocationEvent = {
      principal: 'u-feed',
      tenant: 't-feed',
      kind: 'changed',
    };
    await feed.revoke(changed);
    await vi.waitFor(() => {
      expect(second).toEqual([revoked, changed]);
    });
    expect(first).toEqual([revoked]);
    stopSecond();
  });

  it('keeps delivering when a listener throws', async () => {
    const seen: RevocationEvent[] = [];
    const stopThrowing = feed.subscribe(() => {
      throw new Error('listener failed');
    });
    const stop = feed.subscribe((event) => {
      seen.push(event);
    });
    const event: RevocationEvent = { principal: 'u-throw', kind: 'changed' };
    await feed.revoke(event);
    await vi.waitFor(() => {
      expect(seen).toEqual([event]);
    });
    stopThrowing();
    stop();
  });

  it('rejects an event without a principal or with an unknown kind', async () => {
    const seen: unknown[] = [];
    const stop = feed.subscribe((event) => {
      seen.push(event);
    });
    const bad = [
      { principal: '', kind: 'changed' },
      { principal: 'u-bad', kind: 'granted' },
    ] as unknown as readonly RevocationEvent[];
    for (const event of bad) {
      // oxlint-disable-next-line no-await-in-loop -- each rejection is asserted in order
      await expect(
        (async (): Promise<void> => {
          await feed.revoke(event);
        })(),
      ).rejects.toThrow(TypeError);
    }
    expect(seen).toEqual([]);
    stop();
  });
}

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
        roles: ['editor'],
        via: `group:${group.id}`,
        managedBy: 'idp',
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

  it('ends sessions when scimHandler deactivates a user in this store', async () => {
    const feed = memoryRevocationFeed();
    const seen: RevocationEvent[] = [];
    feed.subscribe((event) => {
      seen.push(event);
    });
    const kinds: string[] = [];
    const token = 'conformance-scim-token';
    const handle = scimHandler({
      store,
      tenant: home,
      token: { hash: 'sha256', lookup: () => sha256Hex(token) },
      revocations: feed,
      onChange: (change) => {
        kinds.push(change.kind);
      },
    });
    const call = (path: string, method: string, body: unknown) =>
      handle(
        new Request(`https://app.example.com/scim/v2${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/scim+json',
          },
          body: JSON.stringify(body),
        }),
      );
    const created = await call('/Users', 'POST', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'grace',
      active: true,
    });
    expect(created.status).toBe(201);
    const id = String(((await created.json()) as { id: unknown }).id);
    seen.length = 0;
    const patched = await call(`/Users/${id}`, 'PATCH', {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(patched.status).toBe(200);
    expect(seen).toContainEqual({
      principal: 'grace',
      tenant: home,
      kind: 'session-revoked',
    });
    expect(seen.every((event) => event.kind === 'session-revoked')).toBe(true);
    expect(kinds).toEqual(['changed', 'session-revoked']);
  });
}

export type ApprovalStoreOptions = {
  /**
   * Opens a second store over the same backing storage, as a restarted process
   * would. Omit it for stores that do not persist (the resume-after-restart
   * case is then skipped).
   */
  readonly reopen?: () => ApprovalStore | Promise<ApprovalStore>;
};

function tenantApproval(token: string, tenant: string): ApprovalRequest {
  const base = sampleApproval(token);
  return {
    ...base,
    subject: {
      ...base.subject,
      principal: { id: 'u_1', roles: ['member'], tenant },
    },
  };
}

function tenantApprover(tenant: string): Subject {
  return {
    principal: {
      id: 'u_9',
      roles: [],
      memberships: [{ tenant, roles: ['admin'] }],
    },
    context: {},
  };
}

export function testApprovalStore(
  store: ApprovalStore,
  options: ApprovalStoreOptions = {},
): void {
  it('keeps the existing record when the same call asks again', async () => {
    await store.create(sampleApproval('dup-token'));
    await store.resolve('dup-token', { status: 'approved', by: approver });
    await store.create(sampleApproval('dup-token'));
    expect((await store.get('dup-token'))?.status).toBe('approved');
  });

  it('consumes an approved request exactly once', async () => {
    await store.create(sampleApproval('once-token'));
    expect(await store.consume('once-token')).toBeNull();
    await store.resolve('once-token', { status: 'approved', by: approver });
    const [first, second] = await Promise.all([
      store.consume('once-token'),
      store.consume('once-token'),
    ]);
    expect([first, second].filter((item) => item !== null)).toHaveLength(1);
    expect((first ?? second)?.consumedAt).toEqual(expect.any(String));
    expect(await store.consume('once-token')).toBeNull();
    expect((await store.get('once-token'))?.consumedAt).toEqual(
      expect.any(String),
    );
  });

  it('refuses an approver from another tenant', async () => {
    await store.create(tenantApproval('tenant-token', 'o_1'));
    await expect(
      Promise.resolve().then(() =>
        store.resolve('tenant-token', {
          status: 'approved',
          by: tenantApprover('o_2'),
        }),
      ),
    ).rejects.toThrow(/tenant|eligible/u);
    expect((await store.get('tenant-token'))?.status).toBe('pending');
  });

  it.skipIf(options.reopen === undefined)(
    'resumes an approval after a restart',
    async () => {
      await store.create(sampleApproval('restart-token'));
      await store.resolve('restart-token', {
        status: 'approved',
        by: approver,
      });
      const reopened = await options.reopen!();
      expect((await reopened.get('restart-token'))?.status).toBe('approved');
      expect(await reopened.consume('restart-token')).not.toBeNull();
      expect(await store.consume('restart-token')).toBeNull();
    },
  );

  it('creates, gets, lists, resolves and expires', async () => {
    const request = sampleApproval('opaque-token');
    await store.create(request);
    const loaded = await store.get('opaque-token');
    expect(loaded).toEqual(request);
    expect(JSON.parse(JSON.stringify(loaded))).toEqual(request);
    const listed = await store.list({ status: 'pending' });
    expect(listed.items.some((item) => item.token === 'opaque-token')).toBe(
      true,
    );
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

  it('pages list results with limit and an opaque cursor', async () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const tokens = ['page-a', 'page-b', 'page-c'];
    await Promise.all(
      tokens.map(async (token, index) =>
        store.create({
          ...sampleApproval(token),
          subject: { principal: { id: 'u_pager', roles: ['member'] } },
          createdAt: new Date(base + index * 1000).toISOString(),
        }),
      ),
    );
    const first = await store.list({ principalId: 'u_pager', limit: 2 });
    expect(first.items.map((item) => item.token)).toEqual(['page-a', 'page-b']);
    expect(typeof first.next).toBe('string');
    const second = await store.list({
      principalId: 'u_pager',
      limit: 2,
      cursor: first.next!,
    });
    expect(second.items.map((item) => item.token)).toEqual(['page-c']);
    expect(second.next).toBeUndefined();
    expect(
      (await store.list({ principalId: 'u_pager', cursor: 'not a cursor' }))
        .items,
    ).toEqual([]);
  });

  it('refuses an approver who does not match request.approvers', async () => {
    const request = {
      ...sampleApproval('gated-token'),
      approvers: {
        by: { kind: 'role' as const, role: 'admin', scope: 'global' as const },
      },
    };
    await store.create(request);
    const member: Subject = {
      principal: { id: 'u_2', roles: ['member'] },
      context: {},
    };
    await expect(
      Promise.resolve().then(() =>
        store.resolve('gated-token', { status: 'approved', by: member }),
      ),
    ).rejects.toThrow(/eligible|not pending|not found/);
  });

  it('refuses the principal as approver unless the grant sets distinct: false', async () => {
    const principal: Subject = {
      principal: { id: 'u_1', roles: ['admin'] },
      context: {},
    };
    const admin = {
      kind: 'role' as const,
      role: 'admin',
      scope: 'global' as const,
    };
    const shapes = [
      ['self-human', undefined],
      ['self-by', { by: admin }],
      ['self-distinct', { by: admin, distinct: true }],
    ] as const;
    for (const [token, approvers] of shapes) {
      await store.create(
        approvers === undefined
          ? sampleApproval(token)
          : { ...sampleApproval(token), approvers },
      );
      await expect(
        Promise.resolve().then(() =>
          store.resolve(token, { status: 'approved', by: principal }),
        ),
      ).rejects.toThrow(/principal/u);
      expect((await store.get(token))?.status).toBe('pending');
    }
    await store.create({
      ...sampleApproval('self-optout'),
      approvers: { by: admin, distinct: false },
    });
    const resolved = await store.resolve('self-optout', {
      status: 'approved',
      by: principal,
    });
    expect(resolved.resolvedBy).toBe('u_1');
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

/** Settings for `tenant`, or `undefined`; a thrown source fails the runner. */
export function testSettingsSource(
  source: SettingsSource,
  options: { readonly tenant: string; readonly unknown?: string },
): void {
  it('answers per tenant with plain settings and nothing for an unknown tenant', async () => {
    const settings = await source.settingsFor(options.tenant);
    if (settings !== undefined) {
      expect(typeof settings).toBe('object');
      const credentials = settings.credentials;
      if (credentials !== undefined) {
        expect(
          credentials.maxTtl === undefined ||
            (Number.isFinite(credentials.maxTtl) && credentials.maxTtl >= 0),
        ).toBe(true);
        expect(
          credentials.kinds === undefined ||
            credentials.kinds.every(
              (kind) => kind === 'user' || kind === 'service',
            ),
        ).toBe(true);
      }
      expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
    }
    expect(
      await source.settingsFor(options.unknown ?? '__permdock_unknown__'),
    ).toBeUndefined();
  });
}

function flipLast(value: string): string {
  const last = value.at(-1);
  return `${value.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
}

/**
 * `key` is a live key the verifier knows, or a function issuing one (called
 * once). `revoke`, when given, revokes it; the runner then expects the key
 * to stop verifying.
 */
export function testCredentialVerifier(
  verifier: CredentialVerifier,
  options: {
    readonly key: string | (() => string | Promise<string>);
    readonly revoke?: () => void | Promise<void>;
  },
): void {
  let issued: Promise<string> | undefined;
  const live = (): Promise<string> => {
    const source = options.key;
    issued ??= Promise.resolve(typeof source === 'string' ? source : source());
    return issued;
  };

  it('verifies the live key to a v1 credential with the key id', async () => {
    const key = await live();
    const parts = parseApiKey(key);
    expect(parts).toBeDefined();
    const credential = parseCredential(await verifier.verify(key));
    expect(credential).toBeDefined();
    expect(credential?.id).toBe(parts?.id);
    expect(parseCredential(await verifier.verify(key))).toEqual(credential);
  });

  it('never throws and answers null for every other key', async () => {
    const key = await live();
    const parts = parseApiKey(key);
    const others = [
      '',
      'garbage',
      'pdk_',
      `${key}x`,
      flipLast(key),
      `pdk_${parts?.id ?? 'x'}-other_${parts?.secret ?? ''}`,
      key.replace(/^pdk_/u, 'sk_'),
    ];
    for (const other of others) {
      let result: Awaited<ReturnType<CredentialVerifier['verify']>>;
      try {
        result = await verifier.verify(other);
      } catch {
        throw new Error('CredentialVerifier must not throw');
      }
      expect(result).toBeNull();
    }
  });

  if (options.revoke !== undefined) {
    const revoke = options.revoke;
    it('stops verifying a revoked key', async () => {
      const key = await live();
      await revoke();
      expect(await verifier.verify(key)).toBeNull();
    });
  }
}

export function testTokenSigner(
  signer: TokenSigner,
  options: { readonly verifier: TokenVerifier },
): void {
  it('emits compact JWS with only alg, kid and typ', async () => {
    const token = await signer.sign(
      { snapshot: { v: 1 }, sub: 'u_1' },
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

  it('compiles a sqlFunction through its twin', () => {
    const twin = { op: 'eq' as const, field: 'authorId', value: 'u1' };
    expect(() =>
      compiler(
        {
          op: 'sqlFunction',
          name: 'job_permitted',
          args: [{ field: 'id' }],
          twin,
        },
        options.target,
      ),
    ).not.toThrow();
  });
}
