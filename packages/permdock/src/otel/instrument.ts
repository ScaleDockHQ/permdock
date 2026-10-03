import type { DecisionEvent } from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { PolicyVocabulary } from '../core/policy.ts';
import type {
  OtelApi,
  OtelOptions,
  OtelSpan,
  OtelTracer,
  StructuralLogger,
} from './types.ts';

import { compact } from '../core/compact.ts';
import {
  GENAI_SEMCONV_PIN,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_NAME,
} from './types.ts';

export { GENAI_SEMCONV_PIN };

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const SPAN_STATUS_ERROR = 2;

// `@opentelemetry/api` 1.x keeps registered providers on this global, so
// reading it needs neither the package nor a Node module loader.
const OTEL_REGISTRY = Symbol.for('opentelemetry.js.api.1');
const OTEL_SPAN_KEY = Symbol.for('OpenTelemetry Context Key SPAN');

type OtelRegistry = {
  readonly trace?: { readonly getTracer?: OtelApi['trace']['getTracer'] };
  readonly metrics?: {
    readonly getMeter?: NonNullable<OtelApi['metrics']>['getMeter'];
  };
  readonly context?: {
    readonly active?: () =>
      | { readonly getValue?: (key: symbol) => unknown }
      | undefined;
  };
};

function registry(): OtelRegistry | undefined {
  // SAFETY: reading one symbol key of globalThis; the value stays unknown until checked.
  const value = (globalThis as Record<symbol, unknown>)[OTEL_REGISTRY];
  // SAFETY: the object @opentelemetry/api registers there; every member is optional and read with ?.
  return typeof value === 'object' && value !== null
    ? (value as OtelRegistry)
    : undefined;
}

const NOOP_TRACER: OtelTracer = {
  startSpan: () => ({}),
};

// Looked up per call, so a provider registered after `instrument()` is used.
const registryApi: OtelApi = {
  trace: {
    getTracer: (name) => registry()?.trace?.getTracer?.(name) ?? NOOP_TRACER,
    getActiveSpan: () =>
      // SAFETY: the OpenTelemetry context stores the active Span under OTEL_SPAN_KEY.
      registry()?.context?.active?.()?.getValue?.(OTEL_SPAN_KEY) as
        | OtelSpan
        | undefined,
  },
  metrics: {
    getMeter: (name) =>
      registry()?.metrics?.getMeter?.(name) ?? {
        createCounter: () => ({ add: () => undefined }),
        createHistogram: () => ({ record: () => undefined }),
      },
  },
};

function resolveApi(injected: OtelApi | undefined): OtelApi | undefined {
  if (injected !== undefined) {
    return injected;
  }
  return registry() === undefined ? undefined : registryApi;
}

function safeCall(fn: () => void, logger: StructuralLogger | undefined): void {
  try {
    fn();
  } catch (error) {
    if (logger?.error !== undefined) {
      try {
        logger.error('permdock.otel', { cause: String(error) });
      } catch {
        // A throwing logger must never surface to decide.
      }
    }
  }
}

function omitPath(
  attributes: Record<string, unknown>,
  path: string,
): { readonly attributes: Record<string, unknown>; readonly matched: boolean } {
  if (Object.hasOwn(attributes, path)) {
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(attributes)) {
      if (key !== path) {
        next[key] = attributes[key];
      }
    }
    return { attributes: next, matched: true };
  }
  const parts = path.split('.');
  if (parts.some((part) => FORBIDDEN.has(part))) {
    return { attributes, matched: false };
  }
  const [head, ...rest] = parts;
  if (
    head === undefined ||
    rest.length === 0 ||
    !Object.hasOwn(attributes, head)
  ) {
    return { attributes, matched: false };
  }
  const nested = attributes[head];
  if (nested === null || typeof nested !== 'object') {
    return { attributes, matched: false };
  }
  // SAFETY: nested was checked to be a non-null object above; its values stay unknown.
  const child = omitPath(nested as Record<string, unknown>, rest.join('.'));
  if (!child.matched) {
    return { attributes, matched: false };
  }
  return {
    attributes: { ...attributes, [head]: child.attributes },
    matched: true,
  };
}

function attributesOf(
  event: DecisionEvent,
  options: OtelOptions,
  parent: OtelSpan | undefined,
): Record<string, unknown> {
  const extra =
    options.attributes === undefined ? {} : options.attributes(event);
  const attributes = compact<Record<string, unknown>>({
    'permdock.outcome': event.outcome,
    'permdock.permission': event.permission,
    'permdock.scope': event.scope,
    'permdock.resource.type': event.resource.type,
    'permdock.resource.id': event.resource.id,
    'permdock.subject.id': event.subject.principal?.id,
    'permdock.actor.id': event.subject.actor?.id,
    'permdock.actor.kind': event.subject.actor?.kind,
    'permdock.delegation.scopes': event.subject.delegation?.scopes?.join(','),
    'permdock.matched.role': event.matched?.role,
    'permdock.denials.count': event.denials?.length,
    'permdock.token': event.token,
    'permdock.validate': event.trusted ? 'trusted' : 'boundary',
    'permdock.adapter': event.adapter,
    'permdock.filter.total':
      event.counts === undefined
        ? undefined
        : event.counts.granted +
          event.counts.denied +
          event.counts.approvalRequired,
    'permdock.filter.kept': event.counts?.granted,
    [GEN_AI_TOOL_NAME]: parent?.attributes?.[GEN_AI_TOOL_NAME],
    [GEN_AI_TOOL_CALL_ID]: parent?.attributes?.[GEN_AI_TOOL_CALL_ID],
    ...extra,
  });
  let redacted = attributes;
  const unmatched: string[] = [];
  for (const path of options.redact ?? []) {
    const result = omitPath(redacted, path);
    redacted = result.attributes;
    if (!result.matched) {
      unmatched.push(path);
    }
  }
  if (unmatched.length > 0) {
    safeCall(() => {
      options.logger?.warn(
        `permdock.otel unmatched redact: ${unmatched.join(', ')}`,
      );
    }, options.logger);
  }
  return redacted;
}

/** Epoch milliseconds with sub-millisecond precision, the OTel `TimeInput` form. */
function now(): number {
  return performance.timeOrigin + performance.now();
}

type Timing = { readonly start: number; readonly end: number };

function recordSignals(
  event: DecisionEvent,
  options: OtelOptions,
  api: OtelApi | undefined,
  timing: Timing | undefined,
): void {
  const parent = api?.trace.getActiveSpan?.();
  const attributes = attributesOf(event, options, parent);
  if (options.logger !== undefined) {
    safeCall(() => {
      options.logger?.info('permdock.decision', attributes);
    }, options.logger);
  }
  if (api === undefined) {
    return;
  }
  const name = options.tracer ?? 'permdock';
  const tracer = api.trace.getTracer(name);
  const span = tracer.startSpan(
    'permdock.decide',
    timing === undefined ? undefined : { startTime: timing.start },
  );
  if (span.isRecording?.() === false) {
    safeCall(() => {
      options.logger?.warn(
        'permdock.otel: @opentelemetry/api is present but no provider is registered',
      );
    }, options.logger);
  }
  span.setAttributes?.(attributes);
  if (event.outcome === 'denied') {
    span.addEvent?.(
      'permdock.denied',
      compact({
        role: event.denials?.map((denial) => denial.role).join(','),
        reason: event.denials?.map((denial) => denial.reason).join(','),
        alternatives: event.alternatives?.join(','),
      }),
    );
    if (
      event.denials?.some((denial) => denial.reason === 'validation') === true
    ) {
      span.recordException?.(new Error('validation'));
    }
    if (options.errorOnDeny === true) {
      span.setStatus?.({ code: SPAN_STATUS_ERROR });
    }
  }
  span.end?.(timing?.end);
  const meter = api.metrics?.getMeter(name);
  const counterAttrs = compact<Record<string, unknown>>({
    'permdock.outcome': event.outcome,
    'permdock.permission': event.permission,
    'permdock.adapter': event.adapter,
  });
  meter?.createCounter('permdock.decisions').add(1, counterAttrs);
  if (timing !== undefined) {
    meter
      ?.createHistogram('permdock.decide.duration', { unit: 's' })
      .record((timing.end - timing.start) / 1000, counterAttrs);
  }
}

function listen(
  permdock: PermDock,
  options: OtelOptions,
  api: OtelApi | undefined,
  startedAt: () => number | undefined,
): () => void {
  return permdock.on('decision', (payload) => {
    const end = now();
    const start = startedAt();
    // SAFETY: the instance emits a DecisionEvent as the payload of every 'decision' event.
    const event = payload as DecisionEvent;
    safeCall(() => {
      recordSignals(
        event,
        options,
        api,
        start === undefined ? undefined : { start, end },
      );
    }, options.logger);
  });
}

/**
 * Listens on one instance. Spans carry no duration and no histogram is
 * recorded, because a listener only sees a decision after it is made; use
 * `withOtel` for timings and for `tenant()` / `team()` derived instances.
 */
export function instrument(
  permdock: PermDock,
  options: OtelOptions = {},
): () => void {
  return listen(permdock, options, resolveApi(options.api), () => undefined);
}

function instrumented<V extends PolicyVocabulary>(
  permdock: PermDock<V>,
  options: OtelOptions,
  api: OtelApi | undefined,
): PermDock<V> {
  let started: number | undefined;
  listen(permdock, options, api, () => started);
  const timed =
    <TArgs extends unknown[], TResult>(
      fn: (...args: TArgs) => TResult,
    ): ((...args: TArgs) => TResult) =>
    (...args: TArgs): TResult => {
      const outer = started === undefined;
      if (outer) {
        started = now();
      }
      try {
        return fn(...args);
      } finally {
        if (outer) {
          started = undefined;
        }
      }
    };
  // SAFETY: timed() forwards its arguments and result unchanged; the casts restore the overloads.
  return Object.freeze({
    ...permdock,
    can: timed(permdock.can) as PermDock<V>['can'],
    decide: timed(permdock.decide) as PermDock<V>['decide'],
    assert: timed(permdock.assert) as PermDock<V>['assert'],
    explain: timed(permdock.explain) as PermDock<V>['explain'],
    filter: timed(permdock.filter) as PermDock<V>['filter'],
    pick: timed(permdock.pick) as PermDock<V>['pick'],
    actions: timed(permdock.actions),
    tenant: (id: string): PermDock<V> =>
      instrumented(permdock.tenant(id), options, api),
    team: (id: string): PermDock<V> =>
      instrumented(permdock.team(id), options, api),
  });
}

/** Returns an instrumented instance: timed spans and histogram, derived instances included. */
export function withOtel<V extends PolicyVocabulary = PolicyVocabulary>(
  permdock: PermDock<V>,
  options: OtelOptions = {},
): PermDock<V> {
  return instrumented(permdock, options, resolveApi(options.api));
}
