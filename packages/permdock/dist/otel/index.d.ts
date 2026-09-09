import { r as PermDock } from "../permdock-BHYt07KR.js";
import { a as OtelOptions, i as OtelApi, n as GEN_AI_TOOL_CALL_ID, o as StructuralLogger, r as GEN_AI_TOOL_NAME, t as GENAI_SEMCONV_PIN } from "../types-AyNP587R.js";
//#region src/otel/instrument.d.ts
export declare function instrument(permdock: PermDock, options?: OtelOptions): () => void;
export declare function withOtel(permdock: PermDock, options?: OtelOptions): PermDock;
export declare function applyOtel(permdock: PermDock, options: OtelOptions | undefined): PermDock;
//#endregion
export { GENAI_SEMCONV_PIN, GEN_AI_TOOL_CALL_ID, GEN_AI_TOOL_NAME, type OtelApi, type OtelOptions, type StructuralLogger };