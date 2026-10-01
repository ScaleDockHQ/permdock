import { describe, expect, it } from 'vitest';

import type { RelationGrantee } from '../../src/core/grantee.ts';
import type { Subject } from '../../src/core/subject.ts';

import {
  actor,
  asGrantee,
  assurance,
  matchGrantee,
  relation,
  relationHops,
  relationStart,
  resourceRoleCondition,
} from '../../src/core/grantee.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { definePolicy } from '../../src/core/policy.ts';

const permissions = definePermissions({
  folder: resource({
    id: 'id',
    actions: ['read'],
    parent: { field: 'parentId', resource: 'folder' },
  }),
  team: resource({ id: 'id', actions: ['read'] }),
  doc: resource({
    id: 'id',
    actions: ['read'],
    parent: { field: 'folderId', resource: 'folder' },
    links: { team: { field: 'teamId', resource: 'team' } },
  }),
  note: resource({ id: 'id', actions: ['read'] }),
});

const { resources } = definePolicy(permissions, { subject: () => null });

function node(name: string) {
  const found = resources.get(name);
  if (found === undefined) {
    throw new Error(`no resource ${name}`);
  }
  return found;
}

const NOW = 1_800_000_000;
const anonymous: Subject = { principal: null, context: {} };
const user = (
  extra: Partial<NonNullable<Subject['principal']>> = {},
): Subject => ({
  principal: { id: 'u1', ...extra },
  context: {},
});

describe('relation() validation', () => {
  it.each([
    {
      name: 'an empty tree',
      run: () => relation({}, 'owner'),
      error: /requires a resource tree/u,
    },
    {
      name: 'an empty link list',
      run: () => relation(permissions.doc, 'owner', { through: [] }),
      error: /at least one link/u,
    },
    {
      name: 'parent inside a link list',
      run: () => relation(permissions.doc, 'owner', { through: ['parent'] }),
      error: /lists link names/u,
    },
    {
      name: 'an unknown through',
      run: () =>
        // SAFETY: an untyped caller passing a through the types forbid.
        relation(permissions.doc, 'owner', { through: 'sideways' as never }),
      error: /must be 'parent' or a list/u,
    },
    {
      name: 'a depth that the link hops push past the limit',
      run: () =>
        relation(permissions.doc, 'owner', { through: ['team'], depth: 32 }),
      error: /counting each link/u,
    },
  ])('refuses $name', ({ run, error }) => {
    expect(run).toThrow(error);
  });

  it('accepts a depth under a link list', () => {
    expect(
      relation(permissions.team, 'member', { through: ['team'], depth: 2 }),
    ).toMatchObject({ through: ['team'], depth: 2 });
  });
});

describe('asGrantee', () => {
  it('refuses a value that is no grantee', () => {
    // SAFETY: an untyped caller passing a non-grantee value.
    expect(() => asGrantee(42 as never)).toThrow(/invalid grantee/u);
  });
});

describe('matchGrantee', () => {
  it.each([
    { name: 'an empty list', to: [], subject: user(), reason: 'no-grant' },
    {
      name: 'assurance for an anonymous subject',
      to: assurance({ amr: 'mfa' }),
      subject: anonymous,
      reason: 'anonymous',
    },
    {
      name: 'assurance without any methods',
      to: assurance({ amr: ['mfa'] }),
      subject: user(),
      reason: 'insufficient-user-authentication',
    },
    {
      name: 'an actor of another kind',
      to: actor('agent'),
      subject: { ...user(), actor: { kind: 'human', id: 'h1' } },
      reason: 'no-grant',
    },
  ])('denies $name', ({ to, subject, reason }) => {
    expect(matchGrantee(to, subject, NOW, undefined)).toEqual({
      matched: false,
      reason,
    });
  });

  it('never matches a grantee kind it does not know, whatever fields it carries', () => {
    // SAFETY: a forged grantee, as an untrusted snapshot or document could carry.
    const forged = { kind: 'wizard', matched: true } as never;
    expect({
      anonymous: matchGrantee(forged, anonymous, NOW, undefined),
      listed: matchGrantee([forged], user(), NOW, undefined),
    }).toEqual({
      anonymous: { matched: false, reason: 'no-grant', unknown: true },
      listed: { matched: false, reason: 'no-grant', unknown: true },
    });
  });

  it('lets an unknown kind match only when asked, for a deny, and keeps the known checks', () => {
    // SAFETY: a forged grantee, as an untrusted snapshot or document could carry.
    const forged = { kind: 'wizard' } as never;

    expect({
      alone: matchGrantee(
        forged,
        anonymous,
        NOW,
        undefined,
        undefined,
        undefined,
        true,
      ),
      withKnown: matchGrantee(
        [forged, actor()],
        user(),
        NOW,
        undefined,
        undefined,
        undefined,
        true,
      ),
    }).toEqual({
      alone: { matched: true },
      withKnown: { matched: false, reason: 'no-grant' },
    });
  });
});

describe('relation graph starts', () => {
  const folderOwner: RelationGrantee = {
    kind: 'relation',
    resource: 'folder',
    relation: 'owner',
    through: 'parent',
  };

  it('starts on the row or its parent and refuses what it cannot reach', () => {
    expect({
      own: relationStart(folderOwner, node('folder'), node('folder')),
      parent: relationStart(folderOwner, node('doc'), node('folder')),
      fractional: relationStart(
        { ...folderOwner, depth: 1.5 },
        node('folder'),
        node('folder'),
      ),
      unrelated: relationStart(folderOwner, node('note'), node('folder')),
      links: relationStart(
        { ...folderOwner, through: ['team'] },
        node('doc'),
        node('folder'),
      ),
    }).toEqual({
      own: { field: 'id', parent: false, depth: 16 },
      parent: { field: 'folderId', parent: true, depth: 16 },
      fractional: { field: 'id', parent: false, depth: 0 },
      unrelated: undefined,
      links: undefined,
    });
  });

  it('walks a resource role from the row or its parent', () => {
    expect({
      own: resourceRoleCondition(
        node('folder'),
        'folder',
        ['f2', 'f1', 'f1'],
        resources,
      ),
      parent: resourceRoleCondition(node('doc'), 'folder', ['f1'], resources),
      unrelated: resourceRoleCondition(
        node('note'),
        'folder',
        ['f1'],
        resources,
      ),
      flat: resourceRoleCondition(node('doc'), 'team', ['t1'], resources),
    }).toEqual({
      own: {
        op: 'related',
        resource: 'folder',
        relation: '',
        ids: ['f1', 'f2'],
        field: 'id',
        depth: 16,
      },
      parent: {
        op: 'related',
        resource: 'folder',
        relation: '',
        ids: ['f1'],
        field: 'folderId',
        depth: 16,
        parent: true,
      },
      unrelated: undefined,
      flat: undefined,
    });
  });

  it('follows declared links only and walks parents only on a self-parented target', () => {
    const teamMember: RelationGrantee = {
      kind: 'relation',
      resource: 'team',
      relation: 'member',
      through: ['team'],
    };
    expect({
      hops: relationHops(teamMember, node('doc'), resources),
      parentWalk: relationHops(
        { ...teamMember, through: 'parent' },
        node('doc'),
        resources,
      ),
      undeclared: relationHops(
        { ...teamMember, through: ['owner'] },
        node('doc'),
        resources,
      ),
      deep: relationHops({ ...teamMember, depth: 1 }, node('doc'), resources),
    }).toEqual({
      hops: {
        field: 'teamId',
        hops: [{ link: 'team', resource: 'team' }],
        depth: 0,
      },
      parentWalk: undefined,
      undeclared: undefined,
      deep: undefined,
    });
  });
});
