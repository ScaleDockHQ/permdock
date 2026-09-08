import { m as deniedMessage } from "../snapshot-BqmIo2XQ.js";
import { t as compact } from "../compact-CxCColYy.js";
import { t as describe } from "../describe-BnKr1Gwo.js";
import { t as createPermDock$1 } from "../permdock-B0coaaS6.js";
import { r as requestApproval, t as inspectApproval } from "../helpers-BHqWg20R.js";
//#region src/agent/reason.ts
function modelReason(decision, permission, subjectId) {
	if (decision.outcome === "denied") return deniedMessage(permission?.key ?? "unknown", subjectId, decision.denials, decision.alternatives.map((leaf) => leaf.key));
	return describe(decision).detail;
}
function unmappedReason(toolName) {
	return `Denied: unmapped tool ${toolName}.`;
}
function thrownReason(toolName) {
	return `Denied: ${toolName} failed closed.`;
}
//#endregion
//#region src/agent/kernel.ts
function asActor(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return;
	const record = value;
	if (typeof record.id !== "string" || typeof record.kind !== "string") return;
	return {
		id: record.id,
		kind: record.kind
	};
}
async function resolveTenant(tenant, context) {
	if (tenant === void 0 || typeof tenant === "string") return tenant;
	try {
		return await tenant(context);
	} catch {
		return;
	}
}
function idOf(data) {
	if (data === null || typeof data !== "object") return;
	const id = data.id;
	if (typeof id === "string" || typeof id === "number") return String(id);
}
function resourceRef(permission, data) {
	return compact({
		type: permission.resource,
		id: idOf(data)
	});
}
function approvalDenied(detail) {
	return {
		outcome: "denied",
		denials: [{
			role: null,
			reason: "approval",
			detail
		}],
		alternatives: []
	};
}
function resumeMatches(inspected, permission, resource, decision) {
	if (!inspected.ok) return false;
	if (inspected.request.token !== decision.token) return false;
	if (inspected.request.permission !== permission.key) return false;
	if (inspected.request.resource.id !== void 0 && inspected.request.resource.id !== resource.id) return false;
	return true;
}
async function applyResume(decision, permission, dock, store, resource, adapter, resumeToken) {
	if (resumeToken === void 0) {
		if (decision.outcome === "approval-required" && store !== void 0) await requestApproval(store, decision, compact({
			permission,
			resource,
			subject: dock.subject,
			adapter
		}));
		return decision;
	}
	if (store === void 0) return approvalDenied("approval-not-found");
	const inspected = await inspectApproval(store, resumeToken);
	if (!inspected.ok) return approvalDenied(inspected.detail);
	if (decision.outcome === "granted" || decision.outcome === "denied") return decision;
	if (!resumeMatches(inspected, permission, resource, decision)) return approvalDenied("approval-mismatch");
	const principal = dock.subject.principal;
	if (principal === null) return approvalDenied("approval-mismatch");
	return {
		outcome: "granted",
		subject: {
			...dock.subject,
			principal
		},
		matched: decision.grant,
		token: decision.token
	};
}
function runDecide(dock, permission, data, adapter) {
	return dock.decide(permission, data, compact({
		source: "adapter",
		adapter
	}));
}
function hasAnyGrant(policy, dock, permission) {
	const principal = dock.subject.principal;
	if (principal === null) return false;
	const names = new Set(principal.roles ?? []);
	for (const membership of principal.memberships ?? []) for (const role of membership.roles) names.add(role);
	for (const role of policy.roles) {
		if (!names.has(role.name)) continue;
		for (const grant of role.grants) if (grant.effect === "allow" && grant.permission.key === permission.key) return true;
	}
	return false;
}
function createAgentKernel(policy, options) {
	const cache = /* @__PURE__ */ new WeakMap();
	const instance = (context) => {
		if (typeof context === "object" && context !== null) {
			const hit = cache.get(context);
			if (hit !== void 0) return hit;
		}
		const built = (async () => {
			let user = null;
			try {
				user = await options.subject(context);
			} catch {
				user = null;
			}
			let actor;
			if (options.actor !== void 0) try {
				actor = asActor(await options.actor(context));
			} catch {
				actor = void 0;
			}
			const tenant = await resolveTenant(options.tenant, context);
			return createPermDock$1(policy, user, compact({
				tenant,
				actor,
				memberships: options.memberships,
				customRoles: options.customRoles,
				sink: options.sink
			}));
		})();
		if (typeof context === "object" && context !== null) cache.set(context, built);
		return built;
	};
	const decideTool = async (toolName, args, context, decideOptions = {}) => {
		const binding = options.tools[toolName];
		if (binding === void 0) return {
			outcome: "denied",
			decision: null,
			permission: void 0,
			reason: unmappedReason(toolName)
		};
		try {
			const dock = await instance(context);
			let data;
			if (binding.data !== void 0) {
				data = await binding.data(args);
				if (data === null || data === void 0) {
					const decision = {
						outcome: "denied",
						denials: [{
							role: null,
							reason: "validation"
						}],
						alternatives: []
					};
					return {
						outcome: "denied",
						decision,
						permission: binding.permission,
						reason: modelReason(decision, binding.permission, dock.subject.principal?.id)
					};
				}
			}
			const decision = await applyResume(runDecide(dock, binding.permission, data, options.adapter), binding.permission, dock, options.store, resourceRef(binding.permission, data), options.adapter, decideOptions.resumeToken);
			if (decision.outcome === "granted") return {
				outcome: "granted",
				decision,
				permission: binding.permission,
				data
			};
			if (decision.outcome === "approval-required") return {
				outcome: "approval-required",
				decision,
				permission: binding.permission,
				data,
				token: decision.token,
				summary: modelReason(decision, binding.permission, dock.subject.principal?.id)
			};
			return {
				outcome: "denied",
				decision,
				permission: binding.permission,
				reason: modelReason(decision, binding.permission, dock.subject.principal?.id)
			};
		} catch {
			return {
				outcome: "denied",
				decision: null,
				permission: binding.permission,
				reason: thrownReason(toolName)
			};
		}
	};
	const allowedToolNames = async (context) => {
		const dock = await instance(context);
		const allowed = /* @__PURE__ */ new Set();
		for (const [name, binding] of Object.entries(options.tools)) if (hasAnyGrant(policy, dock, binding.permission)) allowed.add(name);
		return allowed;
	};
	return {
		instance,
		decideTool,
		allowedToolNames
	};
}
//#endregion
//#region src/ai-sdk/create.ts
function contextOf(call) {
	const runtime = call.runtimeContext !== null && typeof call.runtimeContext === "object" ? call.runtimeContext : {};
	return compact({
		...runtime,
		runtimeContext: call.runtimeContext
	});
}
function resumeTokenOf(context) {
	if (typeof context.approval === "string" && context.approval !== "") return context.approval;
	if (typeof context.token === "string" && context.token !== "") return context.token;
}
function isToolList(tools) {
	return Array.isArray(tools);
}
function createPermDock(policy, options) {
	const kernel = createAgentKernel(policy, {
		...compact({
			actor: options.actor,
			tenant: options.tenant,
			memberships: options.memberships,
			customRoles: options.customRoles,
			store: options.store,
			sink: options.sink,
			snapshots: options.snapshots
		}),
		subject: options.subject,
		tools: options.tools,
		adapter: "ai-sdk"
	});
	const byPermission = /* @__PURE__ */ new Map();
	for (const [name, binding] of Object.entries(options.tools)) byPermission.set(binding.permission.key, name);
	const toolApproval = async (call) => {
		const context = contextOf(call);
		const args = call.toolCall.input ?? call.toolCall.args;
		const verdict = await kernel.decideTool(call.toolCall.toolName, args, context, compact({ resumeToken: resumeTokenOf(context) }));
		if (verdict.outcome === "granted") return "approved";
		if (verdict.outcome === "approval-required") return {
			type: "user-approval",
			reason: verdict.summary,
			token: verdict.token
		};
		return {
			type: "denied",
			reason: verdict.reason
		};
	};
	const capabilityMiddleware = {
		specificationVersion: "v3",
		transformParams: async ({ params }) => {
			const tools = params.tools;
			if (tools === void 0) return params;
			const allowed = await kernel.allowedToolNames({});
			if (isToolList(tools)) return {
				...params,
				tools: tools.filter((tool) => {
					const name = tool.name;
					return typeof name === "string" && allowed.has(name);
				})
			};
			const next = {};
			for (const [name, tool] of Object.entries(tools)) if (allowed.has(name)) next[name] = tool;
			return {
				...params,
				tools: next
			};
		}
	};
	const needsApproval = (permission) => async (input, context = {}) => {
		const toolName = byPermission.get(permission.key);
		if (toolName === void 0) return true;
		return (await kernel.decideTool(toolName, input, context, compact({ resumeToken: resumeTokenOf(context) }))).outcome !== "granted";
	};
	return {
		toolApproval,
		capabilityMiddleware,
		needsApproval
	};
}
//#endregion
export { createPermDock };
