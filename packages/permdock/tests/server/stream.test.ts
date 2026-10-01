import { describe, expect, it, vi } from 'vitest';

import type { ProblemDetails } from '../../src/core/errors.ts';

import { PermDockRevokedError } from '../../src/core/errors.ts';
import { memoryRevocationFeed } from '../../src/core/revocations.ts';
import { createPermDock } from '../../src/server/index.ts';
import {
  POLICY_VIOLATION,
  guardIterable,
  isAsyncIterable,
  onRevoked,
} from '../../src/server/stream.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

function kernel() {
  const revocations = memoryRevocationFeed();
  const server = createPermDock(policy, {
    revocations,
    subject: () => memberUser,
  });
  const open = () =>
    server.connection(new Request('https://api.example/stream'), {
      permission: permissions.post.list,
    });
  return { revocations, open };
}

async function* items(
  values: readonly unknown[],
): AsyncGenerator<unknown, string> {
  for (const value of values) {
    yield value;
  }
  return 'done';
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

describe('isAsyncIterable', () => {
  it.each<[unknown, boolean]>([
    [items([]), true],
    [{ [Symbol.asyncIterator]: 1 }, false],
    [[1, 2], false],
    [null, false],
    ['text', false],
  ])('%#', (value, expected) => {
    expect(isAsyncIterable(value)).toBe(expected);
  });
});

describe('guardIterable', () => {
  it('yields every item without an items permission and returns the source value', async () => {
    const { open } = kernel();
    const real = await open();
    const close = vi.fn<() => void>(() => real.close());
    const connection = { ...real, close };
    const guarded = guardIterable(items([1, 2]), connection, {
      onRevoked: (error) => error,
    });
    expect(await guarded.next()).toEqual({ value: 1, done: false });
    expect(await guarded.next()).toEqual({ value: 2, done: false });
    expect(await guarded.next()).toEqual({ value: 'done', done: true });
    expect(close).toHaveBeenCalledOnce();
  });

  it('drops items the subscriber cannot read, checking the unwrapped row', async () => {
    const { open } = kernel();
    const connection = await open();
    const updatable = await collect(
      guardIterable(
        items([{ data: ownPost }, { data: otherPost }, { data: { id: 1 } }]),
        connection,
        {
          items: permissions.post.update,
          unwrap: (item) =>
            // SAFETY: the test source yields { data } envelopes.
            (item as { readonly data: unknown }).data,
          onRevoked: (error) => error,
        },
      ),
    );
    expect(updatable).toEqual([{ data: ownPost }]);
  });

  it('throws the framework error when the connection is revoked mid-stream', async () => {
    const { open, revocations } = kernel();
    const connection = await open();
    let release: (() => void) | undefined;
    const parked: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve) => {
            release = () => resolve({ value: undefined, done: true });
          }),
        return: () => Promise.reject(new Error('return failed')),
      }),
    };
    const framework = new Error('closed by policy');
    const onRevokedSpy = vi.fn<(error: PermDockRevokedError) => unknown>(
      () => framework,
    );
    const pending = collect(
      guardIterable(parked, connection, { onRevoked: onRevokedSpy }),
    );
    await revocations.revoke({ principal: 'u1', kind: 'session-revoked' });
    await expect(pending).rejects.toBe(framework);
    expect(onRevokedSpy.mock.calls[0]?.[0]).toBeInstanceOf(
      PermDockRevokedError,
    );
    release?.();
  });

  it('fails at once on an already aborted connection', async () => {
    const { open, revocations } = kernel();
    const connection = await open();
    await revocations.revoke({ principal: 'u1', kind: 'session-revoked' });
    expect(connection.signal.aborted).toBe(true);
    const guarded = guardIterable(items([1]), connection, {
      onRevoked: (error) => new Error(`revoked:${error.code}`),
    });
    await expect(guarded.next()).rejects.toThrow(/^revoked:/u);
  });

  it('maps a foreign abort reason to a denied revocation and rethrows source errors', async () => {
    const controller = new AbortController();
    const { open } = kernel();
    const real = await open();
    const fake = { ...real, signal: controller.signal };
    controller.abort('just because');
    const codes: string[] = [];
    await expect(
      collect(
        guardIterable(items([1]), fake, {
          onRevoked: (error) => {
            codes.push(error.code);
            return error;
          },
        }),
      ),
    ).rejects.toBeInstanceOf(PermDockRevokedError);
    expect(codes).toEqual(['denied']);

    const failing: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('source broke')),
      }),
    };
    await expect(
      collect(
        guardIterable(failing, await open(), { onRevoked: (error) => error }),
      ),
    ).rejects.toThrow('source broke');
  });
});

describe('onRevoked', () => {
  it('ends once with the revocation Problem Details, now or on abort', async () => {
    const { open, revocations } = kernel();
    const connection = await open();
    const ended: ProblemDetails[] = [];
    onRevoked(connection, (problem) => {
      ended.push(problem);
    });
    expect(ended).toEqual([]);
    await revocations.revoke({ principal: 'u1', kind: 'session-revoked' });
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ status: expect.any(Number) });
    onRevoked(connection, (problem) => {
      ended.push(problem);
    });
    expect(ended).toHaveLength(2);

    const controller = new AbortController();
    controller.abort();
    const foreign: ProblemDetails[] = [];
    onRevoked({ ...connection, signal: controller.signal }, (problem) => {
      foreign.push(problem);
    });
    expect(foreign[0]?.type).toBe(
      new PermDockRevokedError({ code: 'denied' }).toProblemDetails().type,
    );
    expect(POLICY_VIOLATION).toBe(1008);
  });
});
