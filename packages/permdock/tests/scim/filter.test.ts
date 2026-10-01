import { describe, expect, it } from 'vitest';

import type { ScimFilter } from '../../src/scim/types.ts';

import {
  filterSupported,
  matchFilter,
  parseScimFilter,
} from '../../src/scim/filter.ts';

describe('parseScimFilter', () => {
  it.each<[string, ScimFilter]>([
    ['userName eq "ada"', { op: 'eq', attribute: 'userName', value: 'ada' }],
    ['userName EQ "ada"', { op: 'eq', attribute: 'userName', value: 'ada' }],
    ['  userName ne "a"  ', { op: 'ne', attribute: 'userName', value: 'a' }],
    ['userName co "d"', { op: 'co', attribute: 'userName', value: 'd' }],
    ['userName sw "a"', { op: 'sw', attribute: 'userName', value: 'a' }],
    ['active eq true', { op: 'eq', attribute: 'active', value: true }],
    ['active eq FALSE', { op: 'eq', attribute: 'active', value: false }],
    ['id eq u_1', { op: 'eq', attribute: 'id', value: 'u_1' }],
    ['externalId pr', { op: 'pr', attribute: 'externalId' }],
    [
      'name.givenName eq "A"',
      { op: 'eq', attribute: 'name.givenName', value: 'A' },
    ],
    ['userName eq "a\\"b"', { op: 'eq', attribute: 'userName', value: 'a"b' }],
    [
      'userName eq "a\\\\b"',
      { op: 'eq', attribute: 'userName', value: 'a\\b' },
    ],
    [
      'id eq "1" and active eq true',
      {
        op: 'and',
        filters: [
          { op: 'eq', attribute: 'id', value: '1' },
          { op: 'eq', attribute: 'active', value: true },
        ],
      },
    ],
    [
      'id eq "1" or id eq "2" OR id eq "3"',
      {
        op: 'or',
        filters: [
          { op: 'eq', attribute: 'id', value: '1' },
          { op: 'eq', attribute: 'id', value: '2' },
          { op: 'eq', attribute: 'id', value: '3' },
        ],
      },
    ],
    [
      '(id eq "1" or id eq "2") and active eq true',
      {
        op: 'and',
        filters: [
          {
            op: 'or',
            filters: [
              { op: 'eq', attribute: 'id', value: '1' },
              { op: 'eq', attribute: 'id', value: '2' },
            ],
          },
          { op: 'eq', attribute: 'active', value: true },
        ],
      },
    ],
    ['( id pr )', { op: 'pr', attribute: 'id' }],
  ])('parses %s', (input, expected) => {
    expect(parseScimFilter(input)).toEqual(expected);
  });

  it.each([
    '',
    '   ',
    'userName',
    'userName eq',
    'userName gt "a"',
    'userName eq "unterminated',
    'userName eq "a\\',
    '1abc eq "a"',
    '(id eq "1"',
    '(id eq "1" or',
    '()',
    'id eq "1" and',
    'id eq "1" or',
    'id eq "1" or id',
    'id eq "1" extra',
    'id eq "1")',
    'userName eq (',
  ])('rejects %j', (input) => {
    expect(parseScimFilter(input)).toBeUndefined();
  });
});

describe('matchFilter', () => {
  const user = {
    id: 'u_1',
    userName: 'ada',
    active: true,
    externalId: '',
    name: { givenName: 'Ada' },
    emails: [{ value: 'ada@example.com' }, { value: 'a@example.org' }],
    nothing: null,
  };
  const group = {
    id: 'g_1',
    displayName: 'Eng',
    members: [{ value: 'u_1' }, { value: 'u_2' }, null, { other: 1 }],
  };

  it.each<[string, Record<string, unknown>, boolean]>([
    ['userName eq "ada"', user, true],
    ['userName eq "ADA"', user, false],
    ['userName ne "ada"', user, false],
    ['userName ne "bob"', user, true],
    ['userName co "d"', user, true],
    ['userName co "z"', user, false],
    ['userName sw "a"', user, true],
    ['userName sw "d"', user, false],
    ['active eq true', user, true],
    ['active eq "TRUE"', user, true],
    ['active ne true', user, false],
    ['active ne false', user, true],
    ['active co true', user, false],
    ['userName eq true', user, false],
    ['missing eq "x"', user, false],
    ['missing ne "x"', user, true],
    ['nothing eq "x"', user, false],
    ['name.givenName eq "Ada"', user, true],
    ['userName.deep eq "x"', user, false],
    ['members.value eq "u_2"', group, true],
    ['members.value eq "u_3"', group, false],
    ['members.value pr', group, true],
    ['members.value eq "u_1"', user, false],
    ['externalId pr', user, false],
    ['userName pr', user, true],
    ['missing pr', user, false],
    ['nothing pr', user, false],
    ['id eq "u_1" and active eq false', user, false],
    ['id eq "u_1" and active eq true', user, true],
    ['id eq "x" or userName eq "ada"', user, true],
    ['id eq "x" or userName eq "bob"', user, false],
  ])('%s', (input, target, expected) => {
    const filter = parseScimFilter(input);
    expect({ input, matched: matchFilter(target, filter) }).toEqual({
      input,
      matched: expected,
    });
  });

  it('matches everything without a filter', () => {
    expect(matchFilter(user, undefined)).toBe(true);
  });

  it('treats an empty multi-valued attribute as not present', () => {
    expect(
      matchFilter({ members: [] }, { op: 'pr', attribute: 'members.value' }),
    ).toBe(false);
    expect(
      matchFilter(
        { members: [{ value: '' }, null] },
        { op: 'pr', attribute: 'members.value' },
      ),
    ).toBe(false);
  });
});

describe('filterSupported', () => {
  it.each<[string, boolean]>([
    ['id eq "1"', true],
    ['userName sw "a"', true],
    ['externalId pr', true],
    ['active eq true', true],
    ['displayName co "x"', true],
    ['members.value eq "u"', true],
    ['emails.value eq "x"', false],
    ['id eq "1" and title eq "x"', false],
    ['id eq "1" or userName eq "x"', true],
    ['(title pr) or id pr', false],
  ])('%s is %s', (input, expected) => {
    const filter = parseScimFilter(input);
    if (filter === undefined) {
      throw new Error(`unparsed ${input}`);
    }
    expect(filterSupported(filter)).toBe(expected);
  });
});
