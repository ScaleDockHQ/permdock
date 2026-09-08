import { createRequire } from 'node:module';

import type { DecisionEvent } from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type {
  OtelApi,
  OtelOptions,
  OtelSpan,
  StructuralLogger,
} from './types.ts';

import { compact } from '../core/compact.ts';
import {
  GENAI_SEMCONV_PIN,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_NAME,
} from './types.ts';

export { GENAI_SEMCONV_PIN, GEN_AI_TOOL_CALL_ID, GEN_AI_TOOL_NAME };

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const SPAN_STATUS_ERROR = 2;

function resolveApi(injected: OtelApi | undefined): OtelApi | undefined {
  if (injected !== undefined) {
    return injected;
  }
  try {
    return createRequire(import.meta.url)('@opentelemetry/api') as OtelApi;
  } catch {
    return undefined;
  }
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
  if (head === undefined || !Object.hasOwn(attributes, head)) {
    return { attributes, matched: false };
  }
  if (rest.length === 0) {
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(attributes)) {
      if (key !== head) {
        next[key] = attributes[key];
      }
    }
    return { attributes: next, matched: true };
  }
  const nested = attributes[head];
  if (nested === null || typeof nested !== 'object') {
    return { attributes, matched: false };
  }
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

function recordSignals(
  event: DecisionEvent,
  options: OtelOptions,
  api: OtelApi | undefined,
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
  const span = tracer.startSpan('permdock.decide');
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
      event.denials !== undefined &&
      event.denials.some((denial) => denial.reason === 'validation')
    ) {
      span.recordException?.(new Error('validation'));
    }
    if (options.errorOnDeny === true) {
      span.setStatus?.({ code: SPAN_STATUS_ERROR });
    }
  }
  span.end?.();
  const meter = api.metrics?.getMeter(name);
  const counterAttrs = compact<Record<string, unknown>>({
    'permdock.outcome': event.outcome,
    'permdock.permission': event.permission,
    'permdock.adapter': event.adapter,
  });
  meter?.createCounter('permdock.decisions').add(1, counterAttrs);
  meter?.createHistogram('permdock.decide.duration').record(0, counterAttrs);
}

export function instrument(
  permdock: PermDock,
  options: OtelOptions = {},
): () => void {
  const api = resolveApi(options.api);
  return permdock.on('decision', (payload) => {
    const event = payload as DecisionEvent;
    safeCall(() => {
      recordSignals(event, options, api);
    }, options.logger);
  });
}

export function withOtel(
  permdock: PermDock,
  options: OtelOptions = {},
): PermDock {
  instrument(permdock, options);
  return permdock;
}

export function applyOtel(
  permdock: PermDock,
  options: OtelOptions | undefined,
): PermDock {
  if (options !== undefined) {
    instrument(permdock, options);
  }
  return permdock;
}
