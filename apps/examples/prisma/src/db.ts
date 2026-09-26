import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaPg } from '@prisma/adapter-pg';
import { permdockExtension } from 'permdock/prisma';

import { PrismaClient } from './generated/client.ts';

async function connect() {
  const pglite = await PGlite.create();
  await pglite.exec(`
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
  const server = new PGLiteSocketServer({ db: pglite, port: 0 });
  await server.start();
  // pglite-socket serves one connection at a time.
  const adapter = new PrismaPg({
    connectionString: `postgres://postgres@${server.getServerConn()}/postgres`,
    max: 1,
  });
  return new PrismaClient({ adapter }).$extends(permdockExtension());
}

export const db: ReturnType<typeof connect> = connect();

export const requiredFields = ['id', 'authorId', 'orgId', 'title', 'published'];
