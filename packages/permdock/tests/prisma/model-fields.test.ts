import { describe, expect, it } from 'vitest';

import { prismaModelFields } from '../../src/prisma/model-fields.ts';
import { toWhere } from '../../src/prisma/to-where.ts';

const SCHEMA = `
enum Status {
  open
  closed
}

model Post {
  id       String   @id
  orgId    String   @map("org_id") // tenant
  teamId   String?
  status   Status
  tags     String[]
  author   User     @relation(fields: [authorId], references: [id])
  authorId String
  owner    supabase:auth.AuthUser @relation(fields: [ownerId], references: [id])
  ownerId  Uuid
  legacy   Unsupported("tsvector")?
  @@index([orgId])
}

model User {
  id    String @id
  posts Post[]
}
`;

describe('prismaModelFields', () => {
  it('reads required and list scalars from schema.prisma, skipping relations', () => {
    expect(prismaModelFields(SCHEMA, 'Post')).toEqual({
      required: ['id', 'orgId', 'status', 'authorId', 'ownerId'],
      lists: ['tags'],
    });
    expect(prismaModelFields(SCHEMA, 'User')).toEqual({
      required: ['id'],
      lists: [],
    });
  });

  it('reads a DMMF datamodel', () => {
    expect(
      prismaModelFields(
        {
          models: [
            {
              name: 'Post',
              fields: [
                { name: 'id', kind: 'scalar', isRequired: true, isList: false },
                {
                  name: 'teamId',
                  kind: 'scalar',
                  isRequired: false,
                  isList: false,
                },
                {
                  name: 'tags',
                  kind: 'scalar',
                  isRequired: true,
                  isList: true,
                },
                {
                  name: 'status',
                  kind: 'enum',
                  isRequired: true,
                  isList: false,
                },
                {
                  name: 'author',
                  kind: 'object',
                  isRequired: true,
                  isList: false,
                },
              ],
            },
          ],
        },
        'Post',
      ),
    ).toEqual({ required: ['id', 'status'], lists: ['tags'] });
  });

  it('throws for an unknown model', () => {
    expect(() => prismaModelFields(SCHEMA, 'Missing')).toThrow(
      /not in the datamodel/,
    );
    expect(() => prismaModelFields({ models: [] }, 'Post')).toThrow(
      /not in the datamodel/,
    );
  });

  it('skips lines inside a model that are not field declarations', () => {
    expect(
      prismaModelFields('model Note {\n  id String @id\n  1x\n}\n', 'Note'),
    ).toEqual({ required: ['id'], lists: [] });
  });

  it('feeds toWhere through the field mapping', () => {
    const model = prismaModelFields(SCHEMA, 'Post');
    const negated = {
      op: 'not',
      condition: { op: 'eq', field: 'org', value: 'acme' },
    } as const;
    expect(toWhere(negated, { model, fields: { org: 'orgId' } })).toEqual({
      NOT: { orgId: { equals: 'acme' } },
    });
    expect(
      toWhere({ op: 'contains', field: 'tags', value: 'a' }, { model }),
    ).toEqual({ tags: { has: 'a' } });
  });
});
