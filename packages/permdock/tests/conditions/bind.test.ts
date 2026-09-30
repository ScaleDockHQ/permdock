import { describe, expect, it } from 'vitest';

import type { Subject } from '../../src/core/subject.ts';

import { bindConditionRefs } from '../../src/conditions/bind.ts';
import { context, principal } from '../../src/conditions/refs.ts';
import { sqlFunction } from '../../src/conditions/sql-function.ts';

const subject: Subject = {
  principal: { id: 'u1', teams: ['t1', 't2'] },
  context: { region: 'eu' },
};

describe('bindConditionRefs', () => {
  it('replaces refs with the subject values', () => {
    expect(
      bindConditionRefs(
        {
          op: 'and',
          conditions: [
            { op: 'eq', field: 'ownerId', value: principal.id },
            { op: 'in', field: 'teamId', value: principal['teams'] },
            {
              op: 'not',
              condition: {
                op: 'eq',
                field: 'region',
                value: context['region'],
              },
            },
          ],
        },
        subject,
      ),
    ).toEqual({
      op: 'and',
      conditions: [
        { op: 'eq', field: 'ownerId', value: 'u1' },
        { op: 'in', field: 'teamId', value: ['t1', 't2'] },
        {
          op: 'not',
          condition: { op: 'eq', field: 'region', value: 'eu' },
        },
      ],
    });
  });

  it('binds a missing ref to null, and to an empty list inside in / notIn', () => {
    expect(
      bindConditionRefs(
        { op: 'eq', field: 'ownerId', value: principal['missing'] },
        subject,
      ),
    ).toEqual({ op: 'eq', field: 'ownerId', value: null });
    expect(
      bindConditionRefs(
        { op: 'in', field: 'teamId', value: principal['missing'] },
        subject,
      ),
    ).toEqual({ op: 'in', field: 'teamId', value: [] });
  });

  it('binds refs inside lists and sqlFunction args, and keeps other nodes', () => {
    expect(
      bindConditionRefs(
        { op: 'in', field: 'teamId', value: [principal.id, 'x'] },
        subject,
      ),
    ).toEqual({ op: 'in', field: 'teamId', value: ['u1', 'x'] });
    expect(
      bindConditionRefs(
        {
          op: 'eq',
          field: 'teamId',
          value: { ref: 'principal.teams' },
        },
        {
          principal: { id: 'u1', teams: ['t1', { nested: true }] },
          context: {},
        },
      ),
    ).toEqual({ op: 'eq', field: 'teamId', value: ['t1'] });
    const fn = sqlFunction('is_member', {
      args: [{ field: 'orgId' }, principal.id],
      twin: { ownerId: principal.id },
    });
    expect(bindConditionRefs(fn, subject)).toMatchObject({
      op: 'sqlFunction',
      args: [{ field: 'orgId' }, 'u1'],
      twin: { op: 'eq', field: 'ownerId', value: 'u1' },
    });
    const kept = { op: 'isNull', field: 'deletedAt' } as const;
    expect(bindConditionRefs(kept, subject)).toBe(kept);
    const either = bindConditionRefs(
      {
        op: 'or',
        conditions: [{ op: 'eq', field: 'ownerId', value: principal.id }],
      },
      subject,
    );
    expect(either).toEqual({
      op: 'or',
      conditions: [{ op: 'eq', field: 'ownerId', value: 'u1' }],
    });
  });
});
