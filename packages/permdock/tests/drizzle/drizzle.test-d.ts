import type { SQL } from 'drizzle-orm';

import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expectTypeOf, it } from 'vitest';

import { toWhere } from '../../src/drizzle/to-where.ts';

const posts = pgTable('posts', { id: text('id'), authorId: text('author_id') });
const users = pgTable('users', { id: text('id') });
const condition = { op: 'eq', field: 'author', value: 'u1' } as const;

describe('permdock/drizzle toWhere types', () => {
  it('returns SQL', () => {
    expectTypeOf(toWhere(condition, posts)).toEqualTypeOf<SQL>();
  });

  it('maps fields only to columns of the same table or SQL', () => {
    toWhere(condition, posts, { columns: { author: posts.authorId } });
    toWhere(condition, posts, { columns: { author: sql`lower(author_id)` } });
    // @ts-expect-error a column of another table
    toWhere(condition, posts, { columns: { author: users.id } });
    // @ts-expect-error not a column
    toWhere(condition, posts, { columns: { author: 'author_id' } });
  });
});
