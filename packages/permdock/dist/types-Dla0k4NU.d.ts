import { _ as DecisionEvent } from "./policy-DdqgAkJT.js";
//#region src/otel/types.d.ts
declare const GENAI_SEMCONV_PIN = "1.37.0";
declare const GEN_AI_TOOL_NAME = "gen_ai.tool.name";
declare const GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";
type StructuralLogger = {
  readonly debug?: (message: string, attributes?: Record<string, unknown>) => void;
  readonly info: (message: string, attributes?: Record<string, unknown>) => void;
  readonly warn: (message: string, attributes?: Record<string, unknown>) => void;
  readonly error?: (message: string, attributes?: Record<string, unknown>) => void;
};
type OtelSpan = {
  readonly setAttribute?: (key: string, value: unknown) => void;
  readonly setAttributes?: (attributes: Record<string, unknown>) => void;
  readonly addEvent?: (name: string, attributes?: Record<string, unknown>) => void;
  readonly recordException?: (error: unknown) => void;
  readonly setStatus?: (status: {
    readonly code: number;
  }) => void;
  readonly end?: () => void;
  readonly isRecording?: () => boolean;
  readonly attributes?: Record<string, unknown>;
};
type OtelTracer = {
  readonly startSpan: (name: string) => OtelSpan;
};
type OtelCounter = {
  readonly add: (value: number, attributes?: Record<string, unknown>) => void;
};
type OtelHistogram = {
  readonly record: (value: number, attributes?: Record<string, unknown>) => void;
};
type OtelMeter = {
  readonly createCounter: (name: string) => OtelCounter;
  readonly createHistogram: (name: string) => OtelHistogram;
};
type OtelApi = {
  readonly trace: {
    readonly getTracer: (name: string) => OtelTracer;
    readonly getActiveSpan?: () => OtelSpan | undefined;
  };
  readonly metrics?: {
    readonly getMeter: (name: string) => OtelMeter;
  };
};
type OtelOptions = {
  readonly tracer?: string;
  readonly logger?: StructuralLogger;
  readonly attributes?: (event: DecisionEvent) => Record<string, unknown>;
  readonly redact?: readonly string[];
  readonly errorOnDeny?: boolean;
  readonly api?: OtelApi;
};
//#endregion
export { OtelOptions as a, OtelApi as i, GEN_AI_TOOL_CALL_ID as n, StructuralLogger as o, GEN_AI_TOOL_NAME as r, GENAI_SEMCONV_PIN as t };