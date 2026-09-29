import { describe, expect, it } from 'vitest';

import type { ScanResult } from './types.ts';

import {
  allow,
  catalogFingerprint,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../index.ts';
import { buildCatalog } from './catalog-doc.ts';

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
    expect(catalog.resources.invoice?.version).toBe('updatedAt');
    expect(catalog.resources.note).not.toHaveProperty('version');
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
