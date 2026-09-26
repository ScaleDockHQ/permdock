import type { MembershipsMapping } from 'permdock/drizzle';

import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const itemTable = pgTable('item', {
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  teamId: text('teamId'),
  folderId: text('folderId'),
  owner: text('owner'),
  status: text('status'),
  score: integer('score'),
  title: text('title').notNull(),
  tags: text('tags').array(),
  due: timestamp('due', { withTimezone: true }),
  archived: boolean('archived'),
});

export const projectTable = pgTable('project', {
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  ownerId: text('ownerId').notNull(),
  name: text('name').notNull(),
  archived: boolean('archived').notNull(),
});

export const docTable = pgTable('doc', {
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  teamId: text('teamId'),
  title: text('title').notNull(),
  locked: boolean('locked').notNull(),
});

/** Kysely's view of the same tables; only `id` is ever selected. */
export type OrmDatabase = {
  readonly item: { readonly id: string };
  readonly project: { readonly id: string };
  readonly doc: { readonly id: string };
};

/** The saas domain's `org_member` table, for the `exists` form. */
export const saasMemberships: MembershipsMapping = {
  tenant: {
    table: 'org_member',
    user: 'user_id',
    role: 'role',
    tenant: 'org_id',
    expiresAt: 'expires_at',
  },
  team: {
    table: 'org_member',
    user: 'user_id',
    role: 'role',
    tenant: 'org_id',
    team: 'team_id',
    expiresAt: 'expires_at',
  },
};
