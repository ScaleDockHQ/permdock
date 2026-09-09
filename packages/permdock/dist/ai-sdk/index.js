import { t as compact } from "../compact-CxSqQNw0.js";
import { t as createAgentKernel } from "../kernel-VLBvhR_D.js";
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
