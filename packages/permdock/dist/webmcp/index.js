import { t as describe } from "../describe-BnKr1Gwo.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { r as PermDockValidationError } from "../errors-DDT8tC4N.js";
import { a as isRegistryTree, o as listPermissions, r as getRegistry } from "../permissions-WEkUHQtZ.js";
//#region src/webmcp/register.ts
const MISSING_CONTEXT = "permdock/webmcp: document.modelContext is absent; registerTools is a no-op.";
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function snapshotOf(permdock) {
	const value = permdock.snapshot();
	if (value instanceof Promise || typeof value === "string") return;
	return value;
}
function toolName(permission) {
	return permission.key.replaceAll(".", "_");
}
function readOnlyHint(permission) {
	if (permission.meta.readOnly !== void 0) return permission.meta.readOnly;
	return permission.action === "read" || permission.action === "list";
}
function untrustedHint(permission, fallback) {
	if (permission.meta.tags?.includes("untrusted") === true) return true;
	return fallback === true;
}
function schemaFor(group, permission, option) {
	if ("key" in group) return option;
	if (isRegistryTree(group)) return getRegistry(group).get(permission.resource)?.schema ?? option;
	return option;
}
function jsonSchemaOf(schema) {
	if (schema === void 0) return;
	const standard = schema["~standard"];
	if (isRecord(standard.jsonSchema)) return standard.jsonSchema;
	return { type: "object" };
}
function validateInput(schema, args, permission) {
	if (schema === void 0) return args;
	const result = schema["~standard"].validate(args);
	if (result !== null && typeof result === "object" && "then" in result && typeof result.then === "function") throw new PermDockValidationError({
		code: "async-schema",
		permission: permission.key,
		resource: permission.resource,
		boundary: "webmcp-args",
		message: `${permission.key}: inputSchema is async.`,
		issues: []
	});
	const sync = result;
	if ("issues" in sync && sync.issues !== void 0) throw new PermDockValidationError({
		code: "invalid-data",
		permission: permission.key,
		resource: permission.resource,
		boundary: "webmcp-args",
		message: `${permission.key}: invalid tool arguments.`,
		issues: [...sync.issues]
	});
	return "value" in sync ? sync.value : args;
}
function bindTenant(input, tenantKey, tenant) {
	if (tenantKey === void 0 || tenant === void 0) return {
		ok: true,
		input
	};
	if (!isRecord(input)) return {
		ok: true,
		input: { [tenantKey]: tenant }
	};
	const given = input[tenantKey];
	if (given !== void 0 && given !== tenant) return {
		ok: false,
		reason: "tenant-mismatch"
	};
	return {
		ok: true,
		input: {
			...input,
			[tenantKey]: tenant
		}
	};
}
function resourceRef(permission, data) {
	if (permission.kind === "collection" || !isRecord(data)) return { type: permission.resource };
	const id = data.id;
	return typeof id === "string" || typeof id === "number" ? {
		type: permission.resource,
		id: String(id)
	} : { type: permission.resource };
}
function alternativesOf(decision) {
	return decision.alternatives.map((leaf) => leaf.key);
}
function deniedResult(decision, permission, data) {
	const described = describe(decision);
	const alternatives = alternativesOf(decision);
	const suffix = alternatives.length === 0 ? "" : ` You may: ${alternatives.join(", ")}.`;
	return {
		isError: true,
		content: [{
			type: "text",
			text: `Denied: ${permission.key}.${suffix}`
		}],
		structuredContent: compact({
			outcome: "denied",
			permission: permission.key,
			resource: resourceRef(permission, data),
			denials: decision.denials,
			alternatives,
			detail: described.detail
		})
	};
}
function approvalResult(decision, permission, data) {
	return {
		content: [{
			type: "text",
			text: describe(decision).detail
		}],
		structuredContent: {
			outcome: "approval-required",
			permission: permission.key,
			resource: resourceRef(permission, data),
			token: decision.token,
			elicitation: {
				mode: "approval",
				token: decision.token
			}
		}
	};
}
function validationResult(error) {
	return {
		isError: true,
		content: [{
			type: "text",
			text: error.message
		}],
		structuredContent: {
			outcome: "denied",
			permission: error.permission,
			denials: [{
				role: null,
				reason: "validation"
			}],
			alternatives: [],
			issues: error.issues
		}
	};
}
function problemResult(error) {
	if (error !== null && typeof error === "object" && "toProblemDetails" in error && typeof error.toProblemDetails === "function") {
		const problem = error.toProblemDetails();
		return {
			isError: true,
			content: [{
				type: "text",
				text: `${problem.title}: ${problem.detail}`
			}],
			structuredContent: {
				outcome: "denied",
				problem
			}
		};
	}
	if (isRecord(error) && error.type === "application/problem+json") return {
		isError: true,
		content: [{
			type: "text",
			text: `${typeof error.title === "string" ? error.title : "Denied"}: ${typeof error.detail === "string" ? error.detail : ""}`
		}],
		structuredContent: {
			outcome: "denied",
			problem: error
		}
	};
}
function wrapResult(value) {
	if (isRecord(value) && Array.isArray(value.content) && value.content.every((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")) return value;
	if (typeof value === "string") return { content: [{
		type: "text",
		text: value
	}] };
	return { content: [{
		type: "text",
		text: JSON.stringify(value ?? null)
	}] };
}
function instanceAllowed(snapshot, permission) {
	return snapshot.grants.some((grant) => grant.permission === permission.key && grant.effect === "allow" && grant.portable !== false);
}
function shouldRegister(dock, snapshot, permission) {
	if (snapshot.simulated === true) return false;
	if (dock.status?.(permission) === "server-only" || dock.status?.(permission) === "pending") return false;
	if (permission.kind === "collection") return dock.can(permission);
	return instanceAllowed(snapshot, permission);
}
function warnMissing(warn) {
	if (warn !== void 0) {
		warn(MISSING_CONTEXT);
		return;
	}
	globalThis.console?.warn?.(MISSING_CONTEXT);
}
async function runTool(permission, raw, options, dock, schema) {
	try {
		const validated = validateInput(schema, raw, permission);
		const bound = bindTenant(validated, options.tenantKey, options.tenant);
		if (!bound.ok) return deniedResult({
			outcome: "denied",
			denials: [{
				role: null,
				reason: "tenant-mismatch"
			}],
			alternatives: []
		}, permission, validated);
		const decision = dock.decide(permission, bound.input);
		switch (decision.outcome) {
			case "denied": return deniedResult(decision, permission, bound.input);
			case "approval-required":
				if (await options.onApprovalRequired?.({
					permission,
					decision,
					input: bound.input
				}) !== true) return approvalResult(decision, permission, bound.input);
				break;
			case "granted": break;
			default: return decision;
		}
		const handler = options.handlers?.[permission.action];
		if (handler === void 0) return {
			isError: true,
			content: [{
				type: "text",
				text: `${permission.key}: no handler registered.`
			}]
		};
		return wrapResult(await handler(bound.input));
	} catch (error) {
		if (error instanceof PermDockValidationError) return validationResult(error);
		return problemResult(error) ?? {
			isError: true,
			content: [{
				type: "text",
				text: error instanceof Error ? error.message : "Tool failed."
			}]
		};
	}
}
function registerGeneration(modelContext, group, options, signal) {
	const dock = options.tenant !== void 0 && options.permdock.tenant !== void 0 ? options.permdock.tenant(options.tenant) : options.permdock;
	const snapshot = snapshotOf(dock);
	if (snapshot === void 0) return;
	for (const permission of listPermissions(group)) {
		if (!shouldRegister(dock, snapshot, permission)) continue;
		const schema = schemaFor(group, permission, options.schema);
		const tenantTitle = options.tenant === void 0 ? void 0 : ` [tenant ${options.tenant}]`;
		const description = `${permission.meta.description ?? permission.key}${tenantTitle ?? ""}`;
		modelContext.registerTool(compact({
			name: toolName(permission),
			title: permission.meta.title ?? permission.action,
			description,
			inputSchema: permission.kind === "instance" || schema !== void 0 ? jsonSchemaOf(schema) : void 0,
			annotations: compact({
				readOnlyHint: readOnlyHint(permission),
				untrustedContentHint: untrustedHint(permission, options.untrustedContentHint)
			}),
			execute: (input) => runTool(permission, input, options, dock, schema)
		}), { signal });
	}
}
function registerTools(modelContext, group, options) {
	if (modelContext === null || modelContext === void 0) {
		warnMissing(options.warn);
		return { unregister() {} };
	}
	let generation;
	const parent = options.signal;
	const start = () => {
		generation?.abort();
		if (parent?.aborted === true) return;
		generation = new AbortController();
		if (parent !== void 0) parent.addEventListener("abort", () => {
			generation?.abort();
		}, { once: true });
		registerGeneration(modelContext, group, options, generation.signal);
	};
	start();
	const unsubscribe = options.permdock.subscribe?.(start);
	const unregister = () => {
		generation?.abort();
		unsubscribe?.();
	};
	parent?.addEventListener("abort", unregister, { once: true });
	return { unregister };
}
//#endregion
export { registerTools };
