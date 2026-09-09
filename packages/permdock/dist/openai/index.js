import { t as compact } from "../compact-CxSqQNw0.js";
import { c as memoryApprovalStore, t as inspectApproval } from "../helpers-Ce24VOuf.js";
import { t as createAgentKernel } from "../kernel-DGng0YWC.js";
//#region src/openai/create.ts
function resumeTokenOf(context) {
	if (typeof context.approval === "string" && context.approval !== "") return context.approval;
	if (typeof context.token === "string" && context.token !== "") return context.token;
}
function createPermDock(policy, options) {
	const store = options.store ?? memoryApprovalStore();
	const tokensByCall = /* @__PURE__ */ new Map();
	const kernel = createAgentKernel(policy, {
		...compact({
			actor: options.actor,
			tenant: options.tenant,
			memberships: options.memberships,
			customRoles: options.customRoles,
			sink: options.sink,
			snapshots: options.snapshots
		}),
		subject: options.subject,
		tools: options.tools,
		store,
		adapter: "openai"
	});
	const byPermission = /* @__PURE__ */ new Map();
	for (const [name, binding] of Object.entries(options.tools)) byPermission.set(binding.permission.key, name);
	const needsApproval = (permission) => async (context, args) => {
		const toolName = byPermission.get(permission.key);
		if (toolName === void 0) return true;
		return (await kernel.decideTool(toolName, args, context, compact({ resumeToken: resumeTokenOf(context) }))).outcome !== "granted";
	};
	const guardTools = async (tools, context) => {
		const allowed = await kernel.allowedToolNames(context);
		return tools.filter((tool) => allowed.has(tool.name));
	};
	const resolveOne = async (state, interruption, context) => {
		const toolName = interruption.rawItem?.name;
		if (toolName === void 0) {
			await state.reject(interruption, { message: "approval-not-found" });
			return null;
		}
		const storedToken = tokensByCall.get(interruption.callId);
		const inspected = storedToken === void 0 ? void 0 : await inspectApproval(store, storedToken);
		if (inspected !== void 0 && inspected.ok) {
			const verdict = await kernel.decideTool(toolName, interruption.rawItem?.arguments, context, compact({ resumeToken: storedToken }));
			if (verdict.outcome === "granted") {
				await state.approve(interruption);
				return null;
			}
			await state.reject(interruption, { message: verdict.outcome === "denied" ? verdict.reason : "approval-mismatch" });
			return null;
		}
		if (inspected !== void 0 && !inspected.ok) {
			await state.reject(interruption, { message: inspected.detail });
			return null;
		}
		const verdict = await kernel.decideTool(toolName, interruption.rawItem?.arguments, context);
		if (verdict.outcome === "granted") {
			await state.approve(interruption);
			return null;
		}
		if (verdict.outcome === "denied") {
			await state.reject(interruption, { message: verdict.reason });
			return null;
		}
		tokensByCall.set(interruption.callId, verdict.token);
		return await store.get(verdict.token) ?? null;
	};
	const resolveInterruptions = async (state, interruptions, resolveOptions) => {
		return (await Promise.all(interruptions.map((interruption) => resolveOne(state, interruption, resolveOptions.context)))).filter((record) => record !== null);
	};
	return {
		needsApproval,
		guardTools,
		resolveInterruptions,
		permdock: (context) => kernel.instance(context)
	};
}
//#endregion
export { createPermDock };
