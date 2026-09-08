import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PermDockValidationError } from './errors.ts';
import { definePermissions, resource } from './permissions.ts';
import { validateBoundary } from './validation.ts';

const Post = z.object({ id: z.string(), authorId: z.string() });
const permissions = definePermissions({
  post: resource(Post, { actions: ['update'], collection: ['create'] }),
});

describe('validateBoundary', () => {
  it('returns data when trusted and mode is boundary', () => {
    expect(
      validateBoundary(
        permissions.post.update,
        undefined,
        { id: 1 },
        'boundary',
        true,
      ),
    ).toEqual({ id: 1 });
  });

  it('validates with Standard Schema and throws on invalid data', () => {
    expect(() =>
      validateBoundary(
        permissions.post.update,
        {
          name: 'post',
          path: 'post',
          schema: Post,
          id: 'id',
          parent: undefined,
          instanceActions: new Set(),
          collectionActions: new Set(),
        },
        { id: 1 },
        'always',
        true,
      ),
    ).toThrow(PermDockValidationError);
  });

  it('throws no-schema when validate is always', () => {
    expect(() =>
      validateBoundary(permissions.post.update, undefined, {}, 'always', false),
    ).toThrow(/no schema/);
  });

  it('rejects async schemas', () => {
    const asyncSchema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: () => Promise.resolve({ value: {} }),
      },
    };
    expect(() =>
      validateBoundary(
        permissions.post.update,
        {
          name: 'post',
          path: 'post',
          schema: asyncSchema,
          id: 'id',
          parent: undefined,
          instanceActions: new Set(),
          collectionActions: new Set(),
        },
        { id: 'p1', authorId: 'u1' },
        'always',
        false,
      ),
    ).toThrow(/async/);
  });
});
