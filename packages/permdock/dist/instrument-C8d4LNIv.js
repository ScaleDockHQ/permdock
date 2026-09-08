import { t as compact } from "./compact-CxSqQNw0.js";
import { createRequire } from "node:module";
//#region src/otel/types.ts
const GENAI_SEMCONV_PIN = "1.37.0";
const GEN_AI_TOOL_NAME = "gen_ai.tool.name";
const GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";
//#endregion
//#region src/otel/instrument.ts
const FORBIDDEN = /* @__PURE__ */ new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
const SPAN_STATUS_ERROR = 2;
function resolveApi(injected) {
	if (injected !== void 0) return injected;
	try {
		return createRequire(import.meta.url)("@opentelemetry/api");
	} catch {
		return;
	}
}
function safeCall(fn, logger) {
	try {
		fn();
	} catch (error) {
		if (logger?.error !== void 0) try {
			logger.error("permdock.otel", { cause: String(error) });
		} catch {}
	}
}
function omitPath(attributes, path) {
	if (Object.hasOwn(attributes, path)) {
		const next = {};
		for (const key of Object.keys(attributes)) if (key !== path) next[key] = attributes[key];
		return {
			attributes: next,
			matched: true
		};
	}
	const parts = path.split(".");
	if (parts.some((part) => FORBIDDEN.has(part))) return {
		attributes,
		matched: false
	};
	const [head, ...rest] = parts;
	if (head === void 0 || !Object.hasOwn(attributes, head)) return {
		attributes,
		matched: false
	};
	if (rest.length === 0) {
		const next = {};
		for (const key of Object.keys(attributes)) if (key !== head) next[key] = attributes[key];
		return {
			attributes: next,
			matched: true
		};
	}
	const nested = attributes[head];
	if (nested === null || typeof nested !== "object") return {
		attributes,
		matched: false
	};
	const child = omitPath(nested, rest.join("."));
	if (!child.matched) return {
		attributes,
		matched: false
	};
	return {
		attributes: {
			...attributes,
			[head]: child.attributes
		},
		matched: true
	};
}
function attributesOf(event, options, parent) {
	const extra = options.attributes === void 0 ? {} : options.attributes(event);
	let redacted = compact({
		"permdock.outcome": event.outcome,
		"permdock.permission": event.permission,
		"permdock.scope": event.scope,
		"permdock.resource.type": event.resource.type,
		"permdock.resource.id": event.resource.id,
		"permdock.subject.id": event.subject.principal?.id,
		"permdock.actor.id": event.subject.actor?.id,
		"permdock.actor.kind": event.subject.actor?.kind,
		"permdock.delegation.scopes": event.subject.delegation?.scopes?.join(","),
		"permdock.matched.role": event.matched?.role,
		"permdock.denials.count": event.denials?.length,
		"permdock.validate": event.trusted ? "trusted" : "boundary",
		"permdock.adapter": event.adapter,
		"permdock.filter.total": event.counts === void 0 ? void 0 : event.counts.granted + event.counts.denied + event.counts.approvalRequired,
		"permdock.filter.kept": event.counts?.granted,
		[GEN_AI_TOOL_NAME]: parent?.attributes?.[GEN_AI_TOOL_NAME],
		[GEN_AI_TOOL_CALL_ID]: parent?.attributes?.[GEN_AI_TOOL_CALL_ID],
		...extra
	});
	const unmatched = [];
	for (const path of options.redact ?? []) {
		const result = omitPath(redacted, path);
		redacted = result.attributes;
		if (!result.matched) unmatched.push(path);
	}
	if (unmatched.length > 0) safeCall(() => {
		options.logger?.warn(`permdock.otel unmatched redact: ${unmatched.join(", ")}`);
	}, options.logger);
	return redacted;
}
function recordSignals(event, options, api) {
	const parent = api?.trace.getActiveSpan?.();
	const attributes = attributesOf(event, options, parent);
	if (options.logger !== void 0) safeCall(() => {
		options.logger?.info("permdock.decision", attributes);
	}, options.logger);
	if (api === void 0) return;
	const name = options.tracer ?? "permdock";
	const span = api.trace.getTracer(name).startSpan("permdock.decide");
	if (span.isRecording?.() === false) safeCall(() => {
		options.logger?.warn("permdock.otel: @opentelemetry/api is present but no provider is registered");
	}, options.logger);
	span.setAttributes?.(attributes);
	if (event.outcome === "denied") {
		span.addEvent?.("permdock.denied", compact({
			role: event.denials?.map((denial) => denial.role).join(","),
			reason: event.denials?.map((denial) => denial.reason).join(","),
			alternatives: event.alternatives?.join(",")
		}));
		if (event.denials !== void 0 && event.denials.some((denial) => denial.reason === "validation")) span.recordException?.(/* @__PURE__ */ new Error("validation"));
		if (options.errorOnDeny === true) span.setStatus?.({ code: SPAN_STATUS_ERROR });
	}
	span.end?.();
	const meter = api.metrics?.getMeter(name);
	const counterAttrs = compact({
		"permdock.outcome": event.outcome,
		"permdock.permission": event.permission,
		"permdock.adapter": event.adapter
	});
	meter?.createCounter("permdock.decisions").add(1, counterAttrs);
	meter?.createHistogram("permdock.decide.duration").record(0, counterAttrs);
}
function instrument(permdock, options = {}) {
	const api = resolveApi(options.api);
	return permdock.on("decision", (payload) => {
		const event = payload;
		safeCall(() => {
			recordSignals(event, options, api);
		}, options.logger);
	});
}
function withOtel(permdock, options = {}) {
	instrument(permdock, options);
	return permdock;
}
function applyOtel(permdock, options) {
	if (options !== void 0) instrument(permdock, options);
	return permdock;
}
//#endregion
export { GEN_AI_TOOL_CALL_ID as a, GENAI_SEMCONV_PIN as i, instrument as n, GEN_AI_TOOL_NAME as o, withOtel as r, applyOtel as t };
