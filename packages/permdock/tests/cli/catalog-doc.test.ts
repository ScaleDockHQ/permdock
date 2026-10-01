import { describe, expect, it } from 'vitest';

import type { ScanResult } from '../../src/cli/types.ts';
import type { PolicyScopesInput } from '../../src/index.ts';

import {
  buildCatalog,
  policyRowConditionKeys,
} from '../../src/cli/catalog-doc.ts';
import {
  allow,
  catalogFingerprint,
  definePermissions,
  definePolicy,
  plan,
  resource,
  role,
  supportAccess,
} from '../../src/index.ts';

const scan: ScanResult = {
  roots: [],
  definitionFiles: {},
  usages: {},
  unknown: [],
  dynamic: [],
  roleNames: ['clerk'],
  planNames: [],
  allowKeys: [],
  snapshots: [],
};

const permissions = definePermissions({
  invoice: resource({ actions: ['pay', 'void'], version: 'updatedAt' }),
  note: resource({ actions: ['read'] }),
});

const policy = definePolicy(permissions, {
  roles: [
    role('clerk', [
      allow(permissions.invoice.pay, {
        approval: { staleOn: 'resource-change' },
      }),
      allow(permissions.invoice.void, { approval: 'human' }),
      allow(permissions.note.read),
    ]),
  ],
  subject: () => null,
});

describe('catalog resource versions', () => {
  const catalog = buildCatalog(
    permissions,
    scan,
    '2026-09-29T00:00:00Z',
    policy,
  );

  it('lists the version field of a resource that declares one', () => {
    expect(catalog.resources['invoice']?.version).toBe('updatedAt');
    expect(catalog.resources['note']).not.toHaveProperty('version');
  });

  it('carries staleOn in the approvals of a permission', () => {
    const approvals = (key: string): unknown =>
      catalog.permissions.find((item) => item.key === key)?.approvals;
    expect(approvals('invoice.pay')).toEqual([
      { by: { kind: 'authenticated' }, staleOn: 'resource-change' },
    ]);
    expect(approvals('invoice.void')).toEqual(['human']);
    expect(catalogFingerprint(catalog)).toBe(catalog.fingerprint);
  });
});

describe('catalog rowConditions', () => {
  const rows = definePermissions({
    doc: resource({ actions: ['read', 'update', 'share'] }),
  });
  const conditioned = definePolicy(rows, {
    roles: [
      role('member', [
        allow(rows.doc.read),
        allow(rows.doc.update, { where: { locked: false } }),
      ]),
      role('lead', [allow(rows.doc.share, { to: plan('pro') })]),
    ],
    subject: () => null,
  });

  it('marks keys whose grants the SQL helpers cannot enforce', () => {
    const catalog = buildCatalog(
      rows,
      scan,
      '2026-09-29T00:00:00Z',
      conditioned,
    );
    const flag = (key: string): unknown =>
      catalog.permissions.find((item) => item.key === key)?.rowConditions;
    expect(flag('doc.read')).toBe(false);
    expect(flag('doc.update')).toBe(true);
    expect(flag('doc.share')).toBe(true);
  });

  it('omits the flag without a policy', () => {
    const catalog = buildCatalog(rows, scan, '2026-09-29T00:00:00Z');
    expect(catalog.permissions[0]).not.toHaveProperty('rowConditions');
  });

  it('flags a grant whose grantee list includes a plan', () => {
    const listed = definePolicy(rows, {
      roles: [],
      grants: [allow(rows.doc.share, { to: [plan('pro'), plan('team')] })],
      subject: () => null,
    });
    expect(policyRowConditionKeys(listed)).toEqual(new Set(['doc.share']));
  });
});

describe('catalog approvals and roles', () => {
  const tree = definePermissions({
    doc: resource({
      actions: ['read', 'sign'],
      relations: { tenant: { field: 'tenant_id', memberOf: 'tenant' } },
    }),
  });
  const owner = role('owner', [allow(tree.doc.sign, { approval: 'human' })], {
    on: 'tenant',
    min: 1,
    max: 2,
    transferOnly: true,
  });
  const signer = role('signer', [allow(tree.doc.sign, { approval: 'human' })], {
    on: 'tenant',
    min: 0,
    activation: { maxDuration: '4h', justification: 'required' },
  });
  const approver = role('approver', [allow(tree.doc.read)], {
    on: 'tenant',
    activation: { justification: 'optional', approval: 'human' },
  });
  const reviewer = role('reviewer', [allow(tree.doc.read)], { on: tree.doc });
  const scopes: PolicyScopesInput = { tenant: { key: 'tenant_id' } };
  const rolesPolicy = definePolicy(tree, {
    scopes,
    roles: [
      owner,
      signer,
      approver,
      reviewer,
      supportAccess({
        role: 'support',
        actorRequired: true,
        consent: { by: 'owner', durations: ['1h', '1h', '1d'] },
        group: 'vendor',
      }),
    ],
    subject: () => null,
  });
  const catalog = buildCatalog(
    tree,
    { ...scan, roleNames: [] },
    '2026-10-01T00:00:00Z',
    rolesPolicy,
  );
  const roleOf = (key: string): unknown =>
    catalog.roles?.find((item) => item.key === key);
  const scoped = buildCatalog(tree, scan, '2026-10-01T00:00:00Z', rolesPolicy);

  it('lists one approval per distinct requirement', () => {
    expect(
      catalog.permissions.find((item) => item.key === 'doc.sign')?.approvals,
    ).toEqual(['human']);
  });

  it('lists the declared scopes', () => {
    expect(catalog.scopes).toEqual([{ name: 'tenant', key: 'tenant_id' }]);
  });

  it('describes ownership, activation, resource and support roles', () => {
    expect({
      owner: roleOf('owner'),
      signer: roleOf('signer'),
      approver: roleOf('approver'),
      reviewer: roleOf('reviewer'),
      support: roleOf('support'),
    }).toEqual({
      owner: {
        key: 'owner',
        on: 'tenant',
        assignable: expect.any(Boolean),
        min: 1,
        max: 2,
        transferOnly: true,
      },
      signer: {
        key: 'signer',
        on: 'tenant',
        assignable: expect.any(Boolean),
        activation: { maxDuration: '4h', justification: 'required' },
      },
      approver: {
        key: 'approver',
        on: 'tenant',
        assignable: expect.any(Boolean),
        activation: { justification: 'optional', approval: true },
      },
      reviewer: {
        key: 'reviewer',
        on: 'resource',
        assignable: expect.any(Boolean),
      },
      support: expect.objectContaining({
        key: 'support',
        on: 'tenant',
        for: ['support'],
        supportAccess: {
          actorRequired: true,
          group: 'vendor',
          durations: ['1h', '1d'],
        },
      }),
    });
  });

  it('omits roles when neither the scan nor the policy has any', () => {
    const bare = definePolicy(tree, { roles: [], subject: () => null });
    const empty = buildCatalog(
      tree,
      { ...scan, roleNames: [] },
      '2026-10-01T00:00:00Z',
      bare,
    );
    expect(empty).not.toHaveProperty('roles');
    expect(empty).not.toHaveProperty('scopes');
  });

  it('lists scanned roles as bare keys without a policy', () => {
    expect(buildCatalog(tree, scan, '2026-10-01T00:00:00Z').roles).toEqual([
      { key: 'clerk' },
    ]);
    expect(
      buildCatalog(tree, { ...scan, roleNames: [] }, '2026-10-01T00:00:00Z'),
    ).not.toHaveProperty('roles');
  });

  it('lists a scanned role the policy does not bind as a bare key', () => {
    expect(roleOf('clerk')).toBeUndefined();
    expect(scoped.roles?.map((item) => item.key)).toEqual([
      'approver',
      'clerk',
      'owner',
      'reviewer',
      'signer',
      'support',
    ]);
    expect(scoped.roles?.[1]).toEqual({ key: 'clerk' });
  });
});
