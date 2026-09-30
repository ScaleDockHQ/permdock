import { call, ORPCError, os } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { memoryRevocationFeed } from '../../src/core/revocations.ts';
import { createPermDock } from '../../src/orpc/index.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

type Ctx = { readonly user: typeof memberUser | null };

function channel<T>() {
  const queue: T[] = [];
  let wake: (() => void) | undefined;
  const nextPush = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  };
  return {
    push(...items: T[]): void {
      queue.push(...items);
      wake?.();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) {
          await nextPush();
        } else {
          yield next;
        }
      }
    },
  };
}

describe('permdock/orpc event iterators', () => {
  it('drops unreadable items and ends on session revocation', async () => {
    const revocations = memoryRevocationFeed();
    const { protect } = createPermDock(policy, {
      subject: (opts) => opts.context.user,
      revocations,
    });
    const posts = channel<typeof ownPost>();
    const feed = os
      .$context<Ctx>()
      .use(
        protect(permissions.post.list, undefined, {
          items: permissions.post.update,
        }),
      )
      .handler(async function* () {
        yield* posts.drain();
      });
    const stream = (await call(feed, undefined, {
      context: { user: memberUser },
    })) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();
    posts.push(otherPost, ownPost);
    await expect(iterator.next()).resolves.toMatchObject({ value: ownPost });
    const pending = iterator.next();
    await revocations.revoke({ principal: 'u1', kind: 'session-revoked' });
    const error: unknown = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code: 'UNAUTHORIZED',
      data: { status: 401, detail: 'session-revoked' },
    });
  });
});

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

  it('maps assert inside a handler to FORBIDDEN with the Problem', async () => {
    const { permdock } = createPermDock<Ctx>(policy, {
      subject: (opts) => opts.context.user,
    });
    const update = os
      .$context<Ctx>()
      .use(permdock())
      .handler(({ context }) => {
        context.permdock.assert(permissions.post.update, otherPost);
        return { ok: true as const };
      });
    const error: unknown = await call(update, undefined, {
      context: { user: memberUser },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ORPCError);
    const denied = error as ORPCError<string, unknown>;
    expect(denied.code).toBe('FORBIDDEN');
    expect(denied.data).toEqual(
      expect.objectContaining({
        status: 403,
        type: 'https://permdock.dev/problems/denied',
      }),
    );
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

  it('runs the subject resolver once when permdock() is applied twice', async () => {
    let resolved = 0;
    const { permdock } = createPermDock<Ctx>(policy, {
      subject: (opts) => {
        resolved += 1;
        return opts.context.user;
      },
    });
    const ping = os
      .$context<Ctx>()
      .use(permdock())
      .use(permdock())
      .handler(({ context }) => ({
        ok: true as const,
        via: context.permdock.subject.principal?.id,
      }));

    await expect(
      call(ping, undefined, { context: { user: memberUser } }),
    ).resolves.toEqual({ ok: true, via: 'u1' });
    expect(resolved).toBe(1);
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
