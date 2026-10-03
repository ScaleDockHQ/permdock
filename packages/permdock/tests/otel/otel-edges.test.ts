import { describe, expect, it } from 'vitest';

import type { OtelApi } from '../../src/otel/types.ts';

import { createPermDock } from '../../src/core/permdock.ts';
import { applyOtel, instrument, withOtel } from '../../src/otel/instrument.ts';
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

const REGISTRY = Symbol.for('opentelemetry.js.api.1');

// SAFETY: globalThis is an ordinary object; tests write and restore one symbol key.
const globals = globalThis as Record<symbol, unknown>;

async function withRegistry<T>(
  value: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const previous = globals[REGISTRY];
  globals[REGISTRY] = value;
  try {
    return await run();
  } finally {
    globals[REGISTRY] = previous;
  }
}

function spanApi(recording: boolean): {
  readonly api: OtelApi;
  readonly exceptions: unknown[];
  readonly attributes: Record<string, unknown>[];
} {
  const exceptions: unknown[] = [];
  const attributes: Record<string, unknown>[] = [];
  return {
    exceptions,
    attributes,
    api: {
      trace: {
        getTracer: () => ({
          startSpan: () => ({
            isRecording: () => recording,
            setAttributes: (next: Record<string, unknown>) => {
              attributes.push(next);
            },
            recordException: (error: unknown) => {
              exceptions.push(error);
            },
          }),
        }),
      },
    },
  };
}

describe('permdock/otel registry fallbacks', () => {
  it('uses a no-op tracer and meter when the registry has no providers', async () => {
    const results = await withRegistry({}, async () => {
      const permdock = withOtel(await createPermDock(policy, memberUser));
      return [
        permdock.can(permissions.post.read, ownPost),
        permdock.decide(permissions.post.update, ownPost).outcome,
      ];
    });
    expect(results).toEqual([true, 'granted']);
  });

  it('ignores a non-object registry value', async () => {
    const result = await withRegistry('not-a-registry', async () => {
      const permdock = withOtel(await createPermDock(policy, memberUser));
      return permdock.can(permissions.post.read, ownPost);
    });
    expect(result).toBe(true);
  });
});

describe('permdock/otel logging and spans', () => {
  it('reports a failing logger to logger.error and survives a failing error', async () => {
    const errors: unknown[] = [];
    const permdock = await createPermDock(policy, memberUser);
    instrument(permdock, {
      logger: {
        info() {
          throw new Error('info failed');
        },
        warn() {
          return undefined;
        },
        error(message, attrs) {
          errors.push([message, attrs]);
        },
      },
    });
    const loud = await createPermDock(policy, memberUser);
    instrument(loud, {
      logger: {
        info() {
          throw new Error('info failed');
        },
        warn() {
          return undefined;
        },
        error() {
          throw new Error('error failed');
        },
      },
    });
    expect([
      permdock.can(permissions.post.read, ownPost),
      loud.can(permissions.post.read, ownPost),
    ]).toEqual([true, true]);
    expect(errors).toEqual([
      ['permdock.otel', { cause: 'Error: info failed' }],
    ]);
  });

  it('warns once per span when no provider records it', async () => {
    const warns: string[] = [];
    const { api } = spanApi(false);
    const permdock = await createPermDock(policy, memberUser);
    instrument(permdock, {
      api,
      logger: {
        info() {
          return undefined;
        },
        warn(message) {
          warns.push(message);
        },
      },
    });
    permdock.can(permissions.post.read, ownPost);
    expect(warns).toEqual([
      'permdock.otel: @opentelemetry/api is present but no provider is registered',
    ]);
  });

  it('records an exception for a validation denial', async () => {
    const { api, exceptions } = spanApi(true);
    const permdock = await createPermDock(policy, memberUser);
    instrument(permdock, { api });
    permdock.decide(permissions.post.update, { id: 5 });
    expect(exceptions.length).toBe(1);
  });

  it('redacts nested paths and reports the ones that do not match', async () => {
    const warns: string[] = [];
    const { api, attributes } = spanApi(true);
    const permdock = await createPermDock(policy, memberUser);
    instrument(permdock, {
      api,
      attributes: () => ({ app: { secret: 's', keep: 1 } }),
      redact: [
        'app.secret',
        'app.missing',
        'app.keep.deeper',
        'app.__proto__',
        'absent.key',
      ],
      logger: {
        info() {
          return undefined;
        },
        warn(message) {
          warns.push(message);
        },
      },
    });
    permdock.can(permissions.post.read, ownPost);
    expect({ app: attributes[0]?.['app'], warns }).toEqual({
      app: { keep: 1 },
      warns: [
        'permdock.otel unmatched redact: app.missing, app.keep.deeper, app.__proto__, absent.key',
      ],
    });
  });
});

describe('applyOtel', () => {
  it('returns the instance unchanged without options', async () => {
    const permdock = await createPermDock(policy, memberUser);
    expect({
      same: applyOtel(permdock, undefined) === permdock,
      wrapped: applyOtel(permdock, {}) === permdock,
    }).toEqual({ same: true, wrapped: false });
  });
});
