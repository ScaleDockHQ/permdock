import { pgTable, text } from 'drizzle-orm/pg-core';

export const posts = pgTable('post', {
  id: text('id').primaryKey(),
  authorId: text('authorId').notNull(),
  orgId: text('orgId').notNull(),
  published: text('published').notNull(),
});
