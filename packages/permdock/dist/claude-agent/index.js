import { t as compact } from "../compact-CxCColYy.js";
import { t as createAgentKernel } from "../kernel-BqxFy2yx.js";
//#region src/claude-agent/create.ts
function resumeTokenOf(context) {
	if (context === void 0) return;
	if (typeof context.approval === "string" && context.approval !== "") return context.approval;
	if (typeof context.token === "string" && context.token !== "") return context.token;
}
function asInput(input) {
	if (input !== null && typeof input === "object" && !Array.isArray(input)) return input;
	return {};
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
		adapter: "claude-agent"
	});
	const canUseTool = async (toolName, input, context = {}) => {
		const verdict = await kernel.decideTool(toolName, input, context, compact({ resumeToken: resumeTokenOf(context) }));
		if (verdict.outcome === "granted") return {
			behavior: "allow",
			updatedInput: input
		};
		if (verdict.outcome === "denied") return {
			behavior: "deny",
			message: verdict.reason
		};
		return null;
	};
	const permissionRequestHook = async (input) => {
		const context = compact({
			approval: input.approval,
			token: input.token
		});
		const verdict = await kernel.decideTool(input.tool_name, input.tool_input, context, compact({ resumeToken: resumeTokenOf(context) }));
		if (verdict.outcome === "granted") return { hookSpecificOutput: {
			hookEventName: "PermissionRequest",
			decision: {
				behavior: "allow",
				updatedInput: asInput(input.tool_input)
			}
		} };
		if (verdict.outcome === "denied") return { hookSpecificOutput: {
			hookEventName: "PermissionRequest",
			decision: {
				behavior: "deny",
				message: verdict.reason
			}
		} };
		return compact({
			hookSpecificOutput: { hookEventName: "PermissionRequest" },
			additionalContext: `${verdict.summary} Token: ${verdict.token}.`,
			token: verdict.token
		});
	};
	return {
		canUseTool,
		permissionRequestHook
	};
}
//#endregion
export { createPermDock };
