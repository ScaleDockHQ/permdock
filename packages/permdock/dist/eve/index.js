import { t as compact } from "../compact-CxSqQNw0.js";
import { n as isApprovalError } from "../errors-BQyxzFvZ.js";
import { c as memoryApprovalStore, i as resolveApproval } from "../helpers-Ce24VOuf.js";
import { t as createAgentKernel } from "../kernel-DFQs_97k.js";
//#region src/eve/create.ts
function serverRoles(attributes) {
	const roles = attributes?.roles;
	if (!Array.isArray(roles)) return [];
	return roles.filter((role) => typeof role === "string");
}
function subjectFromSession(context) {
	const initiator = context.session?.auth?.initiator;
	if (initiator === void 0) return null;
	return {
		id: initiator.principalId,
		roles: serverRoles(initiator.attributes)
	};
}
function actorFromSession(context) {
	const auth = context.session?.auth;
	const initiator = auth?.initiator;
	const current = auth?.current;
	if (current !== void 0 && initiator !== void 0 && current.principalId !== initiator.principalId) return {
		id: current.principalId,
		kind: "eve"
	};
	return {
		id: "eve:app",
		kind: "eve"
	};
}
function mapVerdict(verdict) {
	if (verdict.outcome === "granted") return "not-applicable";
	if (verdict.outcome === "approval-required") return "user-approval";
	return {
		type: "denied",
		reason: verdict.reason
	};
}
function mayApprove(approvers, responder, request) {
	if (approvers === void 0) return true;
	if (typeof approvers === "function") return approvers(responder, request);
	const held = new Set(responder.roles ?? []);
	return approvers.roles.some((role) => held.has(role));
}
function createPermDock(policy, options) {
	const store = options.store ?? memoryApprovalStore();
	const tokensByCall = /* @__PURE__ */ new Map();
	const kernel = createAgentKernel(policy, {
		...compact({
			tenant: options.tenant,
			memberships: options.memberships,
			customRoles: options.customRoles,
			sink: options.sink,
			snapshots: options.snapshots
		}),
		subject: options.subject ?? subjectFromSession,
		actor: options.actor ?? actorFromSession,
		tools: options.tools,
		store,
		adapter: "eve"
	});
	const pairFor = (decide) => {
		const request = async (ctx, args) => {
			const resumeToken = (args.callId === void 0 ? void 0 : tokensByCall.get(args.callId)) ?? ctx.token;
			const verdict = await decide(ctx, args);
			if (verdict.outcome === "approval-required" && args.callId !== void 0) tokensByCall.set(args.callId, verdict.token);
			if (resumeToken !== void 0 && verdict.outcome === "granted") return "not-applicable";
			return mapVerdict(verdict);
		};
		const response = async (responder, args) => {
			const token = args.token ?? (args.callId === void 0 ? void 0 : tokensByCall.get(args.callId));
			if (token === void 0) return {
				status: "rejected",
				reason: "approval-not-found"
			};
			const current = await store.get(token);
			if (current === null) return {
				status: "rejected",
				reason: "approval-not-found"
			};
			if (current.subject.actor?.id === responder.principalId) return {
				status: "rejected",
				reason: "approver is the actor of this request"
			};
			if (!mayApprove(options.approvers, responder, current)) return {
				status: "rejected",
				reason: "approver is not eligible"
			};
			try {
				await resolveApproval(store, token, {
					status: "approved",
					by: {
						principal: {
							id: responder.principalId,
							roles: responder.roles ?? []
						},
						context: {}
					}
				});
				return { status: "allowed" };
			} catch (error) {
				if (isApprovalError(error)) return {
					status: "rejected",
					reason: error.message
				};
				return {
					status: "rejected",
					reason: "approval-not-found"
				};
			}
		};
		return {
			request,
			response
		};
	};
	const approval = pairFor((ctx, args) => {
		const resumeToken = (args.callId === void 0 ? void 0 : tokensByCall.get(args.callId)) ?? ctx.token;
		return kernel.decideTool(args.toolName, args.toolInput, ctx, compact({ resumeToken }));
	});
	const approvalFor = (permission, data) => {
		const binding = compact({
			permission,
			data
		});
		return pairFor((ctx, args) => {
			const resumeToken = (args.callId === void 0 ? void 0 : tokensByCall.get(args.callId)) ?? ctx.token;
			return kernel.evaluate(binding, args.toolName, args.toolInput, ctx, compact({ resumeToken }));
		});
	};
	return {
		approval,
		approvalFor,
		permdock: (ctx) => kernel.instance(ctx)
	};
}
//#endregion
export { actorFromSession, createPermDock, subjectFromSession };
