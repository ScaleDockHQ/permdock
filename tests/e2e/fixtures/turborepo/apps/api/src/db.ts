import { PGlite } from '@electric-sql/pglite';
import { projectsOf } from '@permdock/e2e-saas-kit';
import { eq } from 'drizzle-orm';
import { boolean, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';

export const projects = pgTable('project', {
  id: text('id').primaryKey(),
  orgId: text('orgId').notNull(),
  ownerId: text('ownerId').notNull(),
  name: text('name').notNull(),
  archived: boolean('archived').notNull(),
});

const client = new PGlite();

export const db = drizzle(client);

const created = client.exec(`
  create table project (
    id text primary key,
    "orgId" text not null,
    "ownerId" text not null,
    name text not null,
    archived boolean not null
  );
`);

/** Drops every row and inserts the seed projects of the kit orgs again. */
export async function reseed(): Promise<void> {
  await created;
  await db.delete(projects);
  await db
    .insert(projects)
    .values([...projectsOf('acme'), ...projectsOf('globex')]);
}

await reseed();

export async function findRow(id: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  return row;
}

export async function archive(id: string): Promise<void> {
  await db.update(projects).set({ archived: true }).where(eq(projects.id, id));
}
