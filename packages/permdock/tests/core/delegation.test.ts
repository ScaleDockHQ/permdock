import { describe, expect, it } from 'vitest';

import { coveredByDelegation } from '../../src/index.ts';

const update = { scope: 'post:update', resource: 'post', action: 'update' };

describe('coveredByDelegation', () => {
  it('covers a caller with no delegation only when there is no actor', () => {
    expect(coveredByDelegation(update, undefined)).toBeUndefined();
    expect(coveredByDelegation(update, undefined, undefined, true)).toBe(
      'no-delegation',
    );
    expect(coveredByDelegation(update, {}, 'p1', true)).toBe('no-delegation');
  });

  it('treats empty scopes or access as no delegation', () => {
    expect(coveredByDelegation(update, { scopes: [] })).toBe('no-delegation');
    expect(coveredByDelegation(update, { access: [] })).toBe('no-delegation');
    expect(coveredByDelegation(update, { scopes: [], access: [] })).toBe(
      'no-delegation',
    );
  });

  it('matches OAuth scopes by permission scope', () => {
    expect(
      coveredByDelegation(update, { scopes: ['post:update'] }),
    ).toBeUndefined();
    expect(coveredByDelegation(update, { scopes: ['post:read'] })).toBe(
      'not-delegated',
    );
  });

  it('matches RFC 9396 authorization details by type, actions and identifier', () => {
    const details = {
      authorizationDetails: [
        { type: 'post', actions: ['update'], identifier: 'p1' },
      ],
    };
    expect(coveredByDelegation(update, details, 'p1')).toBeUndefined();
    expect(coveredByDelegation(update, details, 'p2')).toBe('not-delegated');
    expect(
      coveredByDelegation(update, {
        authorizationDetails: [{ type: 'post' }],
      }),
    ).toBeUndefined();
    expect(
      coveredByDelegation(update, {
        authorizationDetails: [{ type: 'post', actions: ['read'] }],
      }),
    ).toBe('not-delegated');
    expect(
      coveredByDelegation(update, { authorizationDetails: [] }, 'p1', true),
    ).toBe('not-delegated');
  });

  it('rejects a detail or access entry whose identifier or actions has the wrong type', () => {
    // SAFETY: the wrong-typed fields stand for an unvalidated token payload.
    const detailId = {
      authorizationDetails: [{ type: 'post', identifier: ['p2'] }],
    } as unknown as Parameters<typeof coveredByDelegation>[1];
    expect(coveredByDelegation(update, detailId, 'p1')).toBe('not-delegated');
    // SAFETY: as above, `actions` is a string instead of an array.
    const detailActions = {
      authorizationDetails: [{ type: 'post', actions: 'read' }],
    } as unknown as Parameters<typeof coveredByDelegation>[1];
    expect(coveredByDelegation(update, detailActions, 'p1')).toBe(
      'not-delegated',
    );
    const accessWrong = {
      access: [
        { type: 'post', identifier: 7 },
        { type: 'post', actions: 'update' },
      ],
    };
    expect(coveredByDelegation(update, accessWrong, 'p1')).toBe(
      'not-delegated',
    );
  });

  it('matches GNAP access by reference string or typed object', () => {
    expect(
      coveredByDelegation(update, { access: ['post:update'] }),
    ).toBeUndefined();
    expect(
      coveredByDelegation(
        update,
        {
          access: [
            {
              type: 'https://api.example.com/post',
              actions: ['update'],
              identifier: 'p1',
            },
          ],
        },
        'p1',
      ),
    ).toBeUndefined();
    expect(
      coveredByDelegation(
        update,
        { access: [{ type: 'post', identifier: 'p1' }] },
        'p2',
      ),
    ).toBe('not-delegated');
    expect(coveredByDelegation(update, { access: [{ type: 'repost' }] })).toBe(
      'not-delegated',
    );
  });

  it('accepts a permission leaf that crossed a serialisation boundary', () => {
    // SAFETY: a JSON round trip of the update leaf keeps its key, resource, action and scope.
    const leaf = JSON.parse(
      JSON.stringify({ key: 'post.update', meta: {}, ...update }),
    ) as typeof update;
    expect(
      coveredByDelegation(leaf, { scopes: ['post:update'] }, 'p1', true),
    ).toBeUndefined();
  });
});
