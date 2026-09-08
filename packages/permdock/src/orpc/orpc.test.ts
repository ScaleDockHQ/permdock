import { call, ORPCError, os } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { createPermDock } from './index.ts';

type Ctx = { readonly user: typeof memberUser | null };

describe('permdock/orpc', () => {
  it('grants and denies through call()', async () => {
    const { permdock, protect } = createPermDock<Ctx>(policy, {
      subject: (opts) => opts.context.user,
    });
    const base = os.$context<Ctx>().use(permdock());
    const update = base
      .input(z.object({ id: z.string() }))
      .use(
        protect(permissions.post.update, ({ input }) =>
          input !== undefined &&
          typeof input === 'object' &&
          'id' in input &&
          input.id === 'p1'
            ? ownPost
            : otherPost,
        ),
      )
      .handler(({ context }) => ({
        ok: true as const,
        via: context.permdock.subject.principal?.id,
      }));

    await expect(
      call(update, { id: 'p1' }, { context: { user: memberUser } }),
    ).resolves.toEqual({ ok: true, via: 'u1' });

    try {
      await call(update, { id: 'p2' }, { context: { user: memberUser } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      const denied = error as ORPCError<string, unknown>;
      expect(denied.code).toBe('FORBIDDEN');
      expect(denied.data).toEqual(
        expect.objectContaining({
          status: 403,
        }),
      );
    }
  });

  it('throws UNAUTHORIZED for an anonymous caller', async () => {
    const { permdock, protect } = createPermDock<Ctx>(policy, {
      subject: (opts) => opts.context.user,
    });
    const read = os
      .$context<Ctx>()
      .use(permdock())
      .use(protect(permissions.post.read, () => ownPost))
      .handler(() => ({ ok: true as const }));

    try {
      await call(read, undefined, { context: { user: null } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, unknown>).code).toBe('UNAUTHORIZED');
    }
  });

  it('answers AuthZEN evaluations over Fetch', async () => {
    const { permdockHandler, openapi } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const response = await permdockHandler(
      new Request('http://localhost/permdock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          evaluations: [
            {
              resource: { type: 'post', properties: ownPost },
              action: { name: 'update' },
            },
          ],
        }),
      }),
    );
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations[0]?.decision).toBe(true);
    expect(
      openapi.security(permissions.post.delete)['x-permdock-permissions'],
    ).toEqual([permissions.post.delete.key]);
  });
});
