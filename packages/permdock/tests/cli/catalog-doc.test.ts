import { describe, expect, it } from 'vitest';

import type { ScanResult } from '../../src/cli/types.ts';

import { buildCatalog } from '../../src/cli/catalog-doc.ts';
import {
  allow,
  catalogFingerprint,
  definePermissions,
  definePolicy,
  plan,
  resource,
  role,
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
});
