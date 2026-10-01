import { describe, expect, it, vi } from 'vitest';

import type {
  ApprovalListQuery,
  ApprovalPage,
  ApprovalRequest,
  ApprovalStore,
} from '../../src/approvals/types.ts';

import { listAll, pageOf } from '../../src/approvals/page.ts';
import { memoryApprovalStore } from '../../src/approvals/store.ts';

function request(createdAt: string, token: string): ApprovalRequest {
  // SAFETY: pageOf and listAll only read createdAt and token.
  return { createdAt, token } as ApprovalRequest;
}

const rows = [
  request('2026-01-02', 'b'),
  request('2026-01-01', 'z'),
  request('2026-01-02', 'a'),
  request('2026-01-03', 'c'),
];

const tokens = (page: ApprovalPage): string[] =>
  page.items.map((item) => item.token);

describe('pageOf', () => {
  it('orders by createdAt then token and follows the cursor', () => {
    const first = pageOf(rows, { limit: 2 });
    expect({ tokens: tokens(first), next: first.next }).toEqual({
      tokens: ['z', 'a'],
      next: '["2026-01-02","a"]',
    });
    const second = pageOf(rows, { limit: 2, cursor: first.next ?? '' });
    expect({ tokens: tokens(second), next: second.next }).toEqual({
      tokens: ['b', 'c'],
      next: undefined,
    });
  });

  it('keeps an equal position out of the next page', () => {
    expect(tokens(pageOf(rows, { cursor: '["2026-01-02","b"]' }))).toEqual([
      'c',
    ]);
    expect(
      tokens(
        pageOf([...rows, request('2026-01-02', 'b')], {
          cursor: '["2026-01-02","a"]',
        }),
      ),
    ).toEqual(['b', 'b', 'c']);
  });

  it.each<[string, ApprovalListQuery, number]>([
    ['the default size', {}, 4],
    ['a size below one', { limit: 0 }, 1],
    ['a fractional size', { limit: 2.9 }, 2],
    ['a non-finite size', { limit: Number.NaN }, 4],
  ])('pages with %s', (_label, query, count) => {
    expect(pageOf(rows, query).items.length).toBe(count);
  });

  it.each<[string]>([
    ['not json'],
    ['{"a":1}'],
    ['["x"]'],
    ['[1,2]'],
    ['["x",2]'],
  ])('answers an empty page for the cursor %s', (cursor) => {
    expect(pageOf(rows, { cursor })).toEqual({ items: [] });
  });

  it('caps a page at 200', () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      request('2026-01-01', String(index).padStart(3, '0')),
    );
    expect(pageOf(many, { limit: 1_000 }).items.length).toBe(200);
  });
});

describe('listAll', () => {
  it('follows next until the last page', async () => {
    const pages: ApprovalPage[] = [
      { items: [request('1', 'a')], next: 'c1' },
      { items: [request('2', 'b')], next: 'c2' },
      { items: [request('3', 'c')] },
    ];
    const list = vi.fn<ApprovalStore['list']>(
      async () => pages.shift() ?? { items: [] },
    );
    const store: ApprovalStore = { ...memoryApprovalStore(), list };
    const all = await listAll(store, { status: 'pending' });
    expect(all.map((item) => item.token)).toEqual(['a', 'b', 'c']);
    expect(list.mock.calls.map(([query]) => query)).toEqual([
      { status: 'pending', limit: 200 },
      { status: 'pending', limit: 200, cursor: 'c1' },
      { status: 'pending', limit: 200, cursor: 'c2' },
    ]);
  });

  it('stops after 1000 pages from a store that never ends', async () => {
    const list = vi.fn<ApprovalStore['list']>(async () => ({
      items: [],
      next: 'again',
    }));
    const store: ApprovalStore = { ...memoryApprovalStore(), list };
    expect(await listAll(store, {})).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1_000);
  });
});
