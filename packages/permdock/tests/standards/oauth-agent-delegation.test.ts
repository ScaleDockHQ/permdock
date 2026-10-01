import { describe, expect, it } from 'vitest';

import type { Delegation } from '../../src/core/subject.ts';

import { createPermDock } from '../../src/core/permdock.ts';
import { mapClaimsToSubject } from '../../src/jwt/map-claims.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

const agent = { id: 'agent-1', kind: 'mcp-client' as const };

async function asAgent(
  delegation: Delegation | undefined,
  user: typeof memberUser = memberUser,
) {
  return createPermDock(policy, user, {
    actor: agent,
    ...(delegation === undefined ? {} : { delegation }),
  });
}

describe('two-principal subject: decision = principal grants intersected with delegation', () => {
  it('an OAuth scope covers the permission whose scope it names, and only that one', async () => {
    const dock = await asAgent({ scopes: ['post:update'] });
    expect(dock.can(permissions.post.update, ownPost)).toBe(true);
    expect(dock.decide(permissions.post.read, ownPost)).toMatchObject({
      outcome: 'denied',
      denials: [{ reason: 'not-delegated' }],
    });
  });

  it('a delegation never adds a grant the principal lacks', async () => {
    const dock = await asAgent({
      scopes: ['post:update', 'post:publish'],
      authorizationDetails: [{ type: 'post' }],
    });
    expect(dock.can(permissions.post.update, otherPost)).toBe(false);
    const admin = await asAgent({ scopes: ['post:update'] }, adminUser);
    expect(admin.can(permissions.post.update, otherPost)).toBe(true);
  });

  it('an empty scopes list is no delegated authority: no-delegation', async () => {
    const dock = await asAgent({ scopes: [] });
    expect(dock.decide(permissions.post.read, ownPost)).toMatchObject({
      outcome: 'denied',
      denials: [{ reason: 'no-delegation' }],
    });
  });

  it('an actor with no delegation at all is denied no-delegation', async () => {
    const dock = await asAgent(undefined);
    expect(dock.decide(permissions.post.read, ownPost)).toMatchObject({
      outcome: 'denied',
      denials: [{ reason: 'no-delegation' }],
    });
  });

  it('a subject with no actor is a human call and is not narrowed', async () => {
    const human = await createPermDock(policy, memberUser);
    expect(human.can(permissions.post.read, ownPost)).toBe(true);
  });
});

describe('RFC 9396 Rich Authorization Requests', () => {
  it('section 2: type matches the resource name and actions the action', async () => {
    const dock = await asAgent({
      authorizationDetails: [{ type: 'post', actions: ['read'] }],
    });
    expect(dock.can(permissions.post.read, ownPost)).toBe(true);
    expect(dock.decide(permissions.post.update, ownPost)).toMatchObject({
      denials: [{ reason: 'not-delegated' }],
    });
  });

  it('an entry without actions covers every action of its type, another type covers none', async () => {
    const all = await asAgent({ authorizationDetails: [{ type: 'post' }] });
    expect(all.can(permissions.post.update, ownPost)).toBe(true);
    const otherType = await asAgent({
      authorizationDetails: [{ type: 'invoice' }],
    });
    expect(otherType.can(permissions.post.read, ownPost)).toBe(false);
  });

  it('an empty actions array covers nothing', async () => {
    const dock = await asAgent({
      authorizationDetails: [{ type: 'post', actions: [] }],
    });
    expect(dock.can(permissions.post.read, ownPost)).toBe(false);
  });

  it('an identifier narrows the entry to that one resource', async () => {
    const dock = await asAgent(
      {
        authorizationDetails: [
          { type: 'post', actions: ['read'], identifier: otherPost.id },
        ],
      },
      adminUser,
    );
    expect(dock.can(permissions.post.read, otherPost)).toBe(true);
    expect(dock.can(permissions.post.read, ownPost)).toBe(false);
  });

  it('locations and datatypes neither widen nor narrow the grant', async () => {
    const dock = await asAgent({
      authorizationDetails: [
        {
          type: 'post',
          actions: ['update'],
          locations: ['https://elsewhere.example'],
          datatypes: ['nothing'],
        },
      ],
    });
    expect(dock.can(permissions.post.update, ownPost)).toBe(true);
    expect(dock.can(permissions.post.update, otherPost)).toBe(false);
  });
});

describe('RFC 8693 token exchange claims', () => {
  const base = { iss: 'https://as.example', sub: 'u1', roles: ['member'] };

  it('section 4.1: the outermost act is the current actor; nested acts are prior actors kept for audit', () => {
    const chain = { sub: 'agent-b', act: { sub: 'agent-a' } };
    const { subject } = mapClaimsToSubject({ ...base, act: chain }, {});
    expect(subject.actor).toMatchObject({ id: 'agent-b' });
    expect(subject.delegation?.chain).toEqual(chain);
  });

  it('a malformed chain is the anonymous subject', () => {
    for (const act of [
      'agent',
      { iss: 'x' },
      { sub: 'agent-b', act: 'agent-a' },
      { sub: 'agent-b', act: { sub: '' } },
    ]) {
      const mapped = mapClaimsToSubject({ ...base, act }, {});
      expect({ act, invalid: mapped.invalidChain }).toEqual({
        act,
        invalid: true,
      });
    }
  });

  it('section 4.2: scope is the space-separated delegated scopes', () => {
    const { subject } = mapClaimsToSubject(
      { ...base, act: { sub: 'agent-b' }, scope: 'post:read post:update' },
      {},
    );
    expect(subject.delegation?.scopes).toEqual(['post:read', 'post:update']);
  });

  it('section 4.4: may_act names who may become the actor and never makes one', () => {
    const { subject } = mapClaimsToSubject(
      { ...base, may_act: { sub: 'agent-z' } },
      {},
    );
    expect(subject.actor).toBeUndefined();
    expect(subject.delegation).toBeUndefined();
  });

  it('RFC 9396 section 9.1: authorization_details in the token reach delegation', () => {
    const details = [{ type: 'post', actions: ['read'] }];
    const { subject } = mapClaimsToSubject(
      { ...base, act: { sub: 'agent-b' }, authorization_details: details },
      {},
    );
    expect(subject.delegation?.authorizationDetails).toEqual(details);
  });
});
