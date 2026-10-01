import { describe, expect, it } from 'vitest';

import {
  asRoles,
  asStatements,
  expiresAtSeconds,
  parseMemberRows,
  parseOrganizationRoles,
  parseTeamRows,
  statementsCover,
} from '../../src/better-auth/parse.ts';

describe('asRoles and asStatements', () => {
  it('reads comma lists and string arrays only', () => {
    expect([
      asRoles(''),
      asRoles('admin, member,,'),
      asRoles(['a', 1, 'b']),
      asRoles(7),
    ]).toEqual([[], ['admin', 'member'], ['a', 'b'], []]);
  });

  it('keeps string actions of array-valued resources', () => {
    expect([
      asStatements(null),
      asStatements(['x']),
      asStatements({ post: ['read', 2], skip: 'write' }),
    ]).toEqual([{}, {}, { post: ['read'] }]);
  });
});

describe('expiresAtSeconds', () => {
  it('accepts seconds, milliseconds, dates and date strings', () => {
    expect([
      expiresAtSeconds(1_700_000_000),
      expiresAtSeconds(1_700_000_000_500),
      expiresAtSeconds(Number.NaN),
      expiresAtSeconds(new Date(1_700_000_000_000)),
      expiresAtSeconds(new Date(Number.NaN)),
      expiresAtSeconds('2023-11-14T22:13:20.000Z'),
      expiresAtSeconds('not a date'),
      expiresAtSeconds(true),
    ]).toEqual([
      1_700_000_000,
      1_700_000_000,
      undefined,
      1_700_000_000,
      undefined,
      1_700_000_000,
      undefined,
      undefined,
    ]);
  });
});

describe('parseMemberRows', () => {
  it('keeps only rows of the caller with a tenant and roles', () => {
    expect(
      parseMemberRows(
        {
          members: [
            null,
            { userId: 'u1', organizationId: 'acme', role: 'admin' },
            { userId: 'u2', organizationId: 'acme', role: 'admin' },
            { userId: 'u1', role: 'admin' },
            { userId: 'u1', organizationId: 'globex', roles: [] },
            { organizationId: 'initech', role: 'member' },
          ],
        },
        'u1',
      ),
    ).toEqual([{ tenant: 'acme', roles: ['admin'] }]);
  });

  it('accepts a single row and rows without userId when allowed', () => {
    expect([
      parseMemberRows(
        { userId: 'u1', organizationId: 'acme', role: 'owner' },
        'u1',
      ),
      parseMemberRows(
        { data: [{ organizationId: 'acme', role: 'member' }] },
        'u1',
        false,
      ),
      parseMemberRows({ unknown: [] }, 'u1'),
      parseMemberRows('rows', 'u1'),
    ]).toEqual([
      [{ tenant: 'acme', roles: ['owner'] }],
      [{ tenant: 'acme', roles: ['member'] }],
      [],
      [],
    ]);
  });
});

describe('parseTeamRows', () => {
  it('reads the team and tenant from the row or the nested team', () => {
    expect(
      parseTeamRows(
        {
          teams: [
            'skip',
            { userId: 'u2', teamId: 't0', role: 'lead' },
            {
              userId: 'u1',
              teamId: 't1',
              organizationId: 'acme',
              role: 'lead',
            },
            { team: { id: 't2', organizationId: 'globex' }, roles: ['member'] },
            { team: { id: 't3' }, roles: ['member'] },
            { team: { organizationId: 'x' }, roles: ['member'] },
            { teamId: 't4', roles: [] },
          ],
        },
        'u1',
      ),
    ).toEqual([
      { tenant: 'acme', team: 't1', roles: ['lead'], via: 'team:t1' },
      { tenant: 'globex', team: 't2', roles: ['member'], via: 'team:t2' },
      { team: 't3', roles: ['member'], via: 'team:t3' },
    ]);
  });
});

describe('parseOrganizationRoles', () => {
  it('reads role or name and any statements key', () => {
    expect(
      parseOrganizationRoles({
        roles: [
          1,
          { role: 'editor', permission: { post: ['update'] } },
          { name: 'viewer', permissions: { post: ['read'] } },
          { name: 'auditor', statements: { log: ['read'] } },
          { name: '' },
          { id: 'nameless' },
        ],
      }),
    ).toEqual([
      { name: 'editor', statements: { post: ['update'] } },
      { name: 'viewer', statements: { post: ['read'] } },
      { name: 'auditor', statements: { log: ['read'] } },
    ]);
  });
});

describe('statementsCover', () => {
  it('requires every resource and action', () => {
    const held = { post: ['read', 'update'] };
    expect([
      statementsCover(held, { post: ['read'] }),
      statementsCover(held, { post: ['delete'] }),
      statementsCover(held, { team: ['read'] }),
      statementsCover(held, {}),
    ]).toEqual([true, false, false, true]);
  });
});
