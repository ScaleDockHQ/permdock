import { describe, expect, it } from 'vitest';

import type { Subject } from '../../src/core/subject.ts';

import { fromSnapshot } from '../../src/core/from-snapshot.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, role } from '../../src/core/policy.ts';
import { defineScopes, normalizeMemberships } from '../../src/core/scopes.ts';
import { parseSnapshot } from '../../src/core/snapshot.ts';
import {
  matchScopedMembership,
  resolveActiveTenant,
  tenantsOf,
} from '../../src/core/tenancy.ts';
import { defineRoles } from '../../src/core/vocabulary.ts';

describe('tenancy', () => {
  it('never defaults the active tenant', () => {
    const scopes = defineScopes({ tenant: { key: 'orgId' } });
    const principal = {
      id: 'u1',
      memberships: normalizeMemberships(
        [{ tenant: 'o1', roles: ['viewer'] }],
        scopes,
      ),
    };
    expect(resolveActiveTenant(principal, 'o2', scopes)).toBeUndefined();
    expect(resolveActiveTenant(principal, 'o1', scopes)).toBe('o1');
    expect(tenantsOf(principal, scopes)).toEqual(['o1']);
  });

  it('matches tenant, team and expired memberships', () => {
    const now = 1000;
    const scopes = defineScopes({
      tenant: { key: 'orgId' },
      team: { key: 'teamId', within: 'tenant' },
    });
    const subject: Subject = {
      principal: {
        id: 'u1',
        tenant: 'o1',
        memberships: normalizeMemberships(
          [
            { tenant: 'o1', roles: ['viewer'] },
            { tenant: 'o1', team: 't1', roles: ['lead'] },
            { tenant: 'o1', roles: ['stale'], expiresAt: 10 },
          ],
          scopes,
        ),
      },
      context: {},
    };
    expect(
      matchScopedMembership(
        subject,
        'tenant',
        'viewer',
        { orgId: 'o1' },
        scopes,
        undefined,
        new Map(),
        now,
      ).ok,
    ).toBe(true);
    expect(
      matchScopedMembership(
        subject,
        'team',
        'lead',
        { orgId: 'o1', teamId: 't1' },
        scopes,
        undefined,
        new Map(),
        now,
      ).ok,
    ).toBe(true);
    expect(
      matchScopedMembership(
        subject,
        'team',
        'lead',
        { orgId: 'o2', teamId: 't1' },
        scopes,
        undefined,
        new Map(),
        now,
      ),
    ).toEqual({ ok: false, reason: 'tenant-mismatch' });
    expect(
      matchScopedMembership(
        subject,
        'tenant',
        'lead',
        { orgId: 'o1' },
        scopes,
        undefined,
        new Map(),
        now,
      ).ok,
    ).toBe(false);
    const expired = matchScopedMembership(
      subject,
      'tenant',
      'stale',
      { orgId: 'o1' },
      scopes,
      undefined,
      new Map(),
      now,
    );
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.reason).toBe('expired-membership');
    }
  });

  it('keys a parent-resource role by the parent field, never the row id', () => {
    const permissions = definePermissions({
      folder: resource({ actions: ['read'] }),
      file: resource({
        parent: { field: 'folderId', resource: 'folder' },
        actions: ['read'],
      }),
    });
    const roles = defineRoles({ editor: { assignable: true } });
    const policy = definePolicy(
      { permissions, roles },
      {
        subject: (user: Subject) => user.principal,
        roles: [
          role(
            roles.editor,
            [allow(permissions.file.read, { to: roles.editor })],
            {
              on: permissions.folder,
            },
          ),
        ],
      },
    );
    const dock = createPermDock(policy, {
      principal: {
        id: 'u1',
        memberships: [
          { on: { resource: 'folder', id: 'f1' }, roles: ['editor'] },
        ],
      },
      context: {},
    });
    if (dock instanceof Promise) {
      throw new TypeError('expected a synchronous instance');
    }
    const inFolder = { id: 'x1', folderId: 'f1' };
    const sameIdElsewhere = { id: 'f1', folderId: 'f9' };
    expect(dock.can(permissions.file.read, inFolder)).toBe(true);
    expect(dock.can(permissions.file.read, sameIdElsewhere)).toBe(false);
    const where = dock.where(permissions.file.read);
    expect(where.subject?.principal?.id).toBe('u1');
    expect(Object.keys(where)).not.toContain('subject');
    expect(where.condition).toEqual({
      op: 'eq',
      field: 'folderId',
      value: 'f1',
    });
    const snapshotDock = fromSnapshot(
      parseSnapshot(JSON.stringify(dock.snapshot())),
    );
    expect(snapshotDock.can(permissions.file.read, sameIdElsewhere)).toBe(
      false,
    );
  });

  it('walks the row parent chain to the membership resource', () => {
    const permissions = definePermissions({
      org: resource({ actions: ['read'] }),
      project: resource({
        parent: { field: 'orgId', resource: 'org' },
        actions: ['read'],
      }),
      folder: resource({
        parent: { field: 'projectId', resource: 'project' },
        actions: ['read'],
      }),
      doc: resource({
        parent: { field: 'folderId', resource: 'folder' },
        actions: ['read'],
      }),
    });
    const roles = defineRoles({ editor: { assignable: true } });
    const policy = definePolicy(
      { permissions, roles },
      {
        subject: (user: Subject) => user.principal,
        roles: [
          role(roles.editor, [allow(permissions.doc.read)], {
            on: permissions.folder,
          }),
        ],
      },
    );
    const docFor = (on: { resource: string; id: string }) => {
      const dock = createPermDock(policy, {
        principal: { id: 'u1', memberships: [{ on, roles: ['editor'] }] },
        context: {},
      });
      if (dock instanceof Promise) {
        throw new TypeError('expected a synchronous instance');
      }
      return dock;
    };
    const row = { id: 'd1', folderId: 'f1', projectId: 'p1', orgId: 'o1' };
    expect(
      docFor({ resource: 'folder', id: 'f1' }).can(permissions.doc.read, row),
    ).toBe(true);
    expect(
      docFor({ resource: 'project', id: 'p1' }).can(permissions.doc.read, row),
    ).toBe(true);
    expect(
      docFor({ resource: 'project', id: 'f1' }).can(permissions.doc.read, row),
    ).toBe(false);
    expect(
      docFor({ resource: 'folder', id: 'd1' }).can(permissions.doc.read, row),
    ).toBe(false);
    expect(
      docFor({ resource: 'project', id: 'p1' }).where(permissions.doc.read)
        .condition,
    ).toEqual({ op: 'eq', field: 'projectId', value: 'p1' });
    expect(
      docFor({ resource: 'doc', id: 'd1' }).can(permissions.doc.read, row),
    ).toBe(false);
  });
});
