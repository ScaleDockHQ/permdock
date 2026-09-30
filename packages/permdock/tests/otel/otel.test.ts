import { describe, expect, it, vi } from 'vitest';

import type { OtelApi, StructuralLogger } from '../../src/otel/types.ts';

import { createPermDock } from '../../src/core/permdock.ts';
import {
  GENAI_SEMCONV_PIN,
  instrument,
  withOtel,
} from '../../src/otel/instrument.ts';
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

type RecordedSpan = {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  readonly events: readonly {
    readonly name: string;
    readonly attributes: Record<string, unknown>;
  }[];
  readonly exceptions: readonly unknown[];
  readonly status: { readonly code?: number } | undefined;
  readonly ended: boolean;
  readonly startTime: number | undefined;
  readonly endTime: number | undefined;
};

function fakeApi(parent?: Record<string, unknown>): {
  readonly api: OtelApi;
  readonly spans: RecordedSpan[];
  readonly counters: {
    readonly name: string;
    readonly value: number;
    readonly attributes: Record<string, unknown>;
  }[];
  readonly histograms: {
    readonly name: string;
    readonly value: number;
    readonly attributes: Record<string, unknown>;
  }[];
} {
  const spans: RecordedSpan[] = [];
  const counters: {
    name: string;
    value: number;
    attributes: Record<string, unknown>;
  }[] = [];
  const histograms: {
    name: string;
    value: number;
    attributes: Record<string, unknown>;
  }[] = [];
  const api: OtelApi = {
    trace: {
      getTracer() {
        return {
          startSpan(name: string, spanOptions?: { startTime?: number }) {
            const attributes: Record<string, unknown> = {};
            const events: {
              name: string;
              attributes: Record<string, unknown>;
            }[] = [];
            const exceptions: unknown[] = [];
            const recorded: RecordedSpan = {
              name,
              attributes,
              events,
              exceptions,
              status: undefined,
              ended: false,
              startTime: spanOptions?.startTime,
              endTime: undefined,
            };
            // SAFETY: recorded is the fake's own object; only its readonly view is exposed.
            const mutable = recorded as {
              status: { readonly code?: number } | undefined;
              ended: boolean;
              endTime: number | undefined;
            };
            spans.push(recorded);
            return {
              setAttribute(key: string, value: unknown) {
                attributes[key] = value;
              },
              setAttributes(next: Record<string, unknown>) {
                Object.assign(attributes, next);
              },
              addEvent(eventName: string, attrs?: Record<string, unknown>) {
                events.push({ name: eventName, attributes: attrs ?? {} });
              },
              recordException(error: unknown) {
                exceptions.push(error);
              },
              setStatus(status: { readonly code?: number }) {
                mutable.status = status;
              },
              end(endTime?: number) {
                mutable.ended = true;
                mutable.endTime = endTime;
              },
              isRecording() {
                return true;
              },
            };
          },
        };
      },
      getActiveSpan() {
        if (parent === undefined) {
          return undefined;
        }
        return {
          attributes: parent,
        };
      },
    },
    metrics: {
      getMeter() {
        return {
          createCounter(name: string) {
            return {
              add(value: number, attributes?: Record<string, unknown>) {
                counters.push({ name, value, attributes: attributes ?? {} });
              },
            };
          },
          createHistogram(name: string) {
            return {
              record(value: number, attributes?: Record<string, unknown>) {
                histograms.push({ name, value, attributes: attributes ?? {} });
              },
            };
          },
        };
      },
    },
  };
  return { api, spans, counters, histograms };
}

describe('permdock/otel', () => {
  it('pins the GenAI attribute names to semconv 1.37.0', () => {
    expect(GENAI_SEMCONV_PIN).toBe('1.37.0');
  });

  it('writes a structured log and no spans when the API is absent', async () => {
    const lines: { readonly message: string; readonly attrs: unknown }[] = [];
    const logger: StructuralLogger = {
      info(message, attrs) {
        lines.push({ message, attrs });
      },
      warn() {
        return undefined;
      },
    };
    const permdock = await createPermDock(policy, memberUser);
    instrument(permdock, { logger });
    expect(permdock.can(permissions.post.read)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe('permdock.decision');
    expect(lines[0]?.attrs).toMatchObject({
      'permdock.outcome': 'granted',
      'permdock.permission': permissions.post.read.key,
    });
  });

  it('records a span, counter and histogram per decide', async () => {
    const { api, spans, counters, histograms } = fakeApi();
    const permdock = withOtel(await createPermDock(policy, memberUser), {
      api,
      tracer: 'permdock-test',
    });
    permdock.decide(permissions.post.update, ownPost);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('permdock.decide');
    expect(spans[0]?.ended).toBe(true);
    expect(spans[0]?.attributes).toMatchObject({
      'permdock.outcome': 'granted',
      'permdock.permission': permissions.post.update.key,
      'permdock.scope': permissions.post.update.scope,
      'permdock.resource.type': 'post',
      'permdock.resource.id': ownPost.id,
      'permdock.subject.id': memberUser.id,
    });
    expect(counters).toEqual([
      {
        name: 'permdock.decisions',
        value: 1,
        attributes: {
          'permdock.outcome': 'granted',
          'permdock.permission': permissions.post.update.key,
        },
      },
    ]);
    expect(histograms[0]?.name).toBe('permdock.decide.duration');
  });

  it('copies pinned GenAI tool attributes from the parent span', async () => {
    const { api, spans } = fakeApi({
      'gen_ai.tool.name': 'update_post',
      'gen_ai.tool.call.id': 'call-1',
    });
    const permdock = await createPermDock(policy, memberUser);
    instrument(permdock, { api });
    expect(permdock.can(permissions.post.read)).toBe(true);
    expect(spans[0]?.attributes['gen_ai.tool.name']).toBe('update_post');
    expect(spans[0]?.attributes['gen_ai.tool.call.id']).toBe('call-1');
  });

  it('adds a denied event and leaves span status unset', async () => {
    const { api, spans } = fakeApi();
    const permdock = await createPermDock(policy, memberUser);
    instrument(permdock, { api });
    permdock.decide(permissions.post.publish, ownPost);
    expect(spans[0]?.attributes['permdock.outcome']).toBe('denied');
    expect(spans[0]?.status).toBeUndefined();
    expect(spans[0]?.events[0]?.name).toBe('permdock.denied');
  });

  it('puts the approval token on an approval-required span', async () => {
    const { api, spans } = fakeApi();
    const permdock = await createPermDock(policy, memberUser);
    instrument(permdock, { api });
    const decision = permdock.decide(permissions.post.delete, ownPost);
    expect(decision.outcome).toBe('approval-required');
    expect(spans[0]?.attributes['permdock.token']).toBe(
      decision.outcome === 'approval-required' ? decision.token : undefined,
    );
  });

  it('marks denied spans ERROR when errorOnDeny is set', async () => {
    const { api, spans } = fakeApi();
    const permdock = await createPermDock(policy, memberUser);
    instrument(permdock, { api, errorOnDeny: true });
    permdock.decide(permissions.post.publish, ownPost);
    expect(spans[0]?.status).toEqual({ code: 2 });
  });

  it('redacts extra attributes and warns on unmatched paths', async () => {
    const warns: string[] = [];
    const { api, spans } = fakeApi();
    const permdock = await createPermDock(policy, memberUser);
    instrument(permdock, {
      api,
      attributes: () => ({ 'app.secret': 'hidden', 'app.ok': 'yes' }),
      redact: ['app.secret', 'subject.email'],
      logger: {
        info() {
          return undefined;
        },
        warn(message) {
          warns.push(message);
        },
      },
    });
    expect(permdock.can(permissions.post.read)).toBe(true);
    expect(spans[0]?.attributes['app.secret']).toBeUndefined();
    expect(spans[0]?.attributes['app.ok']).toBe('yes');
    expect(warns.some((line) => line.includes('subject.email'))).toBe(true);
  });

  it('records filter totals on a single span', async () => {
    const { api, spans } = fakeApi();
    const permdock = await createPermDock(policy, memberUser);
    instrument(permdock, { api });
    permdock.filter(permissions.post.update, [
      ownPost,
      { ...ownPost, id: 'p2' },
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes['permdock.filter.total']).toBe(2);
    expect(spans[0]?.attributes['permdock.filter.kept']).toBe(2);
  });

  it('reads providers from the OpenTelemetry global registry without importing the API', async () => {
    const { api, spans } = fakeApi({ 'gen_ai.tool.name': 'from_registry' });
    const key = Symbol.for('opentelemetry.js.api.1');
    const spanKey = Symbol.for('OpenTelemetry Context Key SPAN');
    const parent = api.trace.getActiveSpan?.();
    // SAFETY: globalThis is an ordinary object; the test writes and restores one symbol key.
    const registry = globalThis as Record<symbol, unknown>;
    const previous = registry[key];
    registry[key] = {
      version: '1.9.0',
      trace: { getTracer: (name: string) => api.trace.getTracer(name) },
      metrics: api.metrics,
      context: {
        active: () => ({
          getValue: (lookup: symbol) =>
            lookup === spanKey ? parent : undefined,
        }),
      },
    };
    try {
      const permdock = await createPermDock(policy, memberUser);
      instrument(permdock, {});
      expect(permdock.can(permissions.post.read)).toBe(true);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.attributes['gen_ai.tool.name']).toBe('from_registry');
    } finally {
      registry[key] = previous;
    }
  });

  it('does nothing when neither logger nor API is present', async () => {
    const permdock = await createPermDock(policy, memberUser);
    const off = instrument(permdock, {});
    expect(permdock.can(permissions.post.read)).toBe(true);
    off();
  });

  it('never throws from a failing logger', async () => {
    const permdock = await createPermDock(policy, memberUser);
    instrument(permdock, {
      logger: {
        info() {
          throw new Error('log failed');
        },
        warn() {
          throw new Error('warn failed');
        },
      },
    });
    expect(() => permdock.can(permissions.post.read)).not.toThrow();
  });

  it('times the span and histogram around the decision, in seconds', async () => {
    const { api, spans, histograms } = fakeApi();
    const permdock = withOtel(await createPermDock(policy, memberUser), {
      api,
    });
    permdock.can(permissions.post.update, ownPost);
    const [span] = spans;
    expect(span?.startTime).toBeTypeOf('number');
    expect(span?.endTime).toBeGreaterThanOrEqual(span?.startTime ?? Infinity);
    expect(histograms[0]?.value).toBeGreaterThanOrEqual(0);
    expect(histograms[0]?.value).toBe(
      ((span?.endTime ?? 0) - (span?.startTime ?? 0)) / 1000,
    );
  });

  it('instruments instances derived through tenant() and team()', async () => {
    const { api, spans } = fakeApi();
    const permdock = withOtel(await createPermDock(policy, memberUser), {
      api,
    });
    permdock.tenant('acme').can(permissions.post.update, ownPost);
    permdock.team('red').tenant('acme').can(permissions.post.update, ownPost);
    expect(spans).toHaveLength(2);
    expect(spans.every((span) => span.startTime !== undefined)).toBe(true);
  });
});
