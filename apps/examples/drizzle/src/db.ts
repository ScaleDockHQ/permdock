import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

const client = new PGlite();

export const db = drizzle({ client });

export const ready: Promise<unknown> = client.exec(`
  create table post (
    id text primary key,
    "authorId" text not null,
    "orgId" text not null,
    title text not null,
    published boolean not null default false
  );
  insert into post (id, "authorId", "orgId", title) values
    ('p1', 'u1', 'o1', 'Mine'),
    ('p2', 'u2', 'o1', 'Theirs');
`);
