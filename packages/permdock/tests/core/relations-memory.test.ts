import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { RelationSource } from '../../src/core/interfaces.ts';
import type { RelationCache } from '../../src/core/relations.ts';

import { definePermissions, resource } from '../../src/core/permissions.ts';
import { memoryRelations, relationReader } from '../../src/core/relations.ts';

const Room = z.object({
  id: z.string(),
  guestId: z.string().nullable(),
  hostId: z.string().nullable(),
  orgId: z.string(),
});

const permissions = definePermissions({
  room: resource(Room, {
    actions: ['enter'],
    relations: {
      guest: {
        principal: 'guestId',
        period: { startsAt: 'from', expiresAt: 'until' },
      },
      owner: { principal: 'hostId' },
      host: { field: 'hostId' },
      org: { field: 'orgId', memberOf: 'tenant' },
      member: { edge: 'room_members' },
      everyone: { includes: ['host', 'member'] },
    },
  }),
});

const at = Date.UTC(2026, 0, 1);

const source = memoryRelations(permissions, {
  rows: {
    room: [
      { guestId: 'ghost' },
      { id: 'date', guestId: 'gus', from: new Date(at), until: new Date('x') },
      {
        id: 'text',
        guestId: 'gus',
        from: '2026-01-01T00:00:00Z',
        until: 'soon',
      },
      { id: 'number', guestId: 'gus', from: 5, until: Number.NaN },
      { id: 'none', guestId: '', hostId: null, orgId: 'acme' },
    ],
  },
  tables: {
    room_members: [
      { room_id: 'number', user_id: 'mia' },
      { room_id: 'number', user_id: '' },
      { room_id: 'text', user_id: 'max' },
    ],
  },
});

function related(id: string, relation: string): unknown {
  return source.related({ resource: 'room', id, relation });
}

describe('memoryRelations', () => {
  it.each([
    {
      name: 'a Date period',
      id: 'date',
      holders: [{ principal: { id: 'gus' }, startsAt: at / 1000 }],
    },
    {
      name: 'a string period',
      id: 'text',
      holders: [{ principal: { id: 'gus' }, startsAt: at / 1000 }],
    },
    {
      name: 'a number period',
      id: 'number',
      holders: [{ principal: { id: 'gus' }, startsAt: 5 }],
    },
    { name: 'an empty holder column', id: 'none', holders: [] },
    { name: 'a row without an id', id: 'ghost', holders: [] },
  ])('reads $name, dropping a timestamp it cannot parse', ({ id, holders }) => {
    expect(related(id, 'guest')).toEqual(holders);
  });

  it.each([
    { name: 'an undeclared relation', id: 'none', relation: 'janitor' },
    { name: 'a computed relation', id: 'none', relation: 'everyone' },
    { name: 'a field holding a scope id', id: 'none', relation: 'org' },
    { name: 'an empty field', id: 'none', relation: 'host' },
    { name: 'an empty principal column', id: 'none', relation: 'owner' },
    { name: 'a missing row', id: 'nowhere', relation: 'host' },
  ])('holds nobody for $name', ({ id, relation }) => {
    expect(related(id, relation)).toEqual([]);
  });

  it('skips an edge row with no subject', () => {
    expect(related('number', 'member')).toEqual([{ principal: { id: 'mia' } }]);
  });

  it.each([
    { name: 'an unknown resource', query: { resource: 'hall', id: 'date' } },
    { name: 'a missing row', query: { resource: 'room', id: 'nowhere' } },
  ])('has no ancestors for $name', ({ query }) => {
    expect(source.ancestors({ ...query, depth: 4, through: 'parent' })).toEqual(
      { ancestors: [] },
    );
  });

  it('reads nothing without data', () => {
    expect(
      memoryRelations(permissions).related({
        resource: 'room',
        id: 'date',
        relation: 'guest',
      }),
    ).toEqual([]);
  });
});

function readerOver(answer: unknown) {
  // SAFETY: the fake returns malformed answers on purpose, so the reader's validation runs.
  const fake = {
    ancestors: () => answer,
    related: () => answer,
  } as RelationSource;
  const cache: RelationCache = new Map();
  return relationReader(fake, cache);
}

describe('relationReader validation', () => {
  it.each([
    { name: 'a list', answer: [] },
    { name: 'no ancestors', answer: {} },
    { name: 'an ancestor without an id', answer: { ancestors: [{ id: '' }] } },
    { name: 'a primitive ancestor', answer: { ancestors: ['a'] } },
  ])('fails a chain of $name', ({ answer }) => {
    expect(
      readerOver(answer).chain({ resource: 'room', id: 'a', depth: 2 }),
    ).toBe('failed');
  });

  it('keeps the flags of a valid chain', () => {
    expect(
      readerOver({
        ancestors: [{ id: 'b', restricted: true }, { id: 'c' }],
        restricted: true,
        truncated: true,
      }).chain({ resource: 'room', id: 'a', depth: 2, through: 'parent' }),
    ).toEqual({
      ancestors: [{ id: 'b', restricted: true }, { id: 'c' }],
      restricted: true,
      truncated: true,
    });
  });

  it.each([
    { name: 'not a list', answer: {} },
    { name: 'a primitive holder', answer: ['ada'] },
    {
      name: 'a non-numeric start',
      answer: [{ principal: { id: 'ada' }, startsAt: '1' }],
    },
    {
      name: 'an infinite expiry',
      answer: [{ principal: { id: 'ada' }, expiresAt: Infinity }],
    },
    { name: 'neither a principal nor a group', answer: [{}] },
    {
      name: 'a group without an id',
      answer: [{ group: { resource: 'team', id: '', relation: 'member' } }],
    },
    {
      name: 'a group without a relation',
      answer: [{ group: { resource: 'team', id: 't' } }],
    },
  ])('fails holders that are $name', ({ answer }) => {
    expect(
      readerOver(answer).holders({
        resource: 'room',
        id: 'a',
        relation: 'host',
      }),
    ).toBe('failed');
  });

  it('reads group holders with their period', () => {
    expect(
      readerOver([
        {
          group: { resource: 'team', id: 't', relation: 'member' },
          startsAt: 1,
          expiresAt: 2,
        },
      ]).holders({ resource: 'room', id: 'a', relation: 'host' }),
    ).toEqual([
      {
        group: { resource: 'team', id: 't', relation: 'member' },
        startsAt: 1,
        expiresAt: 2,
        relation: 'host',
      },
    ]);
  });
});
