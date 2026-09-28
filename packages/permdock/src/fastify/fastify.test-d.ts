import type {
  FastifySchema,
  FastifyTypeProvider,
  RouteGenericInterface,
} from 'fastify';

import Fastify from 'fastify';
import { describe, expectTypeOf, it } from 'vitest';

import { ownPost, permissions, policy } from '../fixtures/quick-start.ts';
import { createPermDock } from './index.ts';

type PostBody = typeof ownPost;

/** Stands in for the zod and TypeBox providers. */
interface PostProvider extends FastifyTypeProvider {
  readonly validator: PostBody;
  readonly serializer: unknown;
}

const { protect } = createPermDock(policy, { subject: () => null });

describe('permdock/fastify protect inference', () => {
  it('infers route generics from the preHandler slot', () => {
    Fastify().get<{ Params: { readonly id: string } }>(
      '/posts/:id',
      {
        preHandler: protect(permissions.post.read, (request) => {
          expectTypeOf(request.params.id).toEqualTypeOf<string>();
          return ownPost;
        }),
      },
      () => null,
    );
  });

  it('types a type provider body when the provider is passed', () => {
    Fastify()
      .withTypeProvider<PostProvider>()
      .put(
        '/posts/:id',
        {
          preHandler: protect<
            RouteGenericInterface,
            FastifySchema,
            PostProvider
          >(permissions.post.update, (request) => {
            expectTypeOf(request.body).toEqualTypeOf<PostBody>();
            return request.body;
          }),
        },
        (request) => {
          expectTypeOf(request.body).toEqualTypeOf<PostBody>();
          return null;
        },
      );
  });
});
