import type { DecisionEvent } from '../core/interfaces.ts';

export const GENAI_SEMCONV_PIN = '1.37.0';
export const GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
export const GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call.id';

export type StructuralLogger = {
  readonly debug?: (
    message: string,
    attributes?: Record<string, unknown>,
  ) => void;
  readonly info: (
    message: string,
    attributes?: Record<string, unknown>,
  ) => void;
  readonly warn: (
    message: string,
    attributes?: Record<string, unknown>,
  ) => void;
  readonly error?: (
    message: string,
    attributes?: Record<string, unknown>,
  ) => void;
};

export type OtelSpan = {
  readonly setAttribute?: (key: string, value: unknown) => void;
  readonly setAttributes?: (attributes: Record<string, unknown>) => void;
  readonly addEvent?: (
    name: string,
    attributes?: Record<string, unknown>,
  ) => void;
  readonly recordException?: (error: unknown) => void;
  readonly setStatus?: (status: { readonly code: number }) => void;
  readonly end?: () => void;
  readonly isRecording?: () => boolean;
  readonly attributes?: Record<string, unknown>;
};

export type OtelTracer = {
  readonly startSpan: (name: string) => OtelSpan;
};

export type OtelCounter = {
  readonly add: (value: number, attributes?: Record<string, unknown>) => void;
};

export type OtelHistogram = {
  readonly record: (
    value: number,
    attributes?: Record<string, unknown>,
  ) => void;
};

export type OtelMeter = {
  readonly createCounter: (name: string) => OtelCounter;
  readonly createHistogram: (name: string) => OtelHistogram;
};

export type OtelApi = {
  readonly trace: {
    readonly getTracer: (name: string) => OtelTracer;
    readonly getActiveSpan?: () => OtelSpan | undefined;
  };
  readonly metrics?: {
    readonly getMeter: (name: string) => OtelMeter;
  };
};

export type OtelOptions = {
  readonly tracer?: string;
  readonly logger?: StructuralLogger;
  readonly attributes?: (event: DecisionEvent) => Record<string, unknown>;
  readonly redact?: readonly string[];
  readonly errorOnDeny?: boolean;
  readonly api?: OtelApi;
};
