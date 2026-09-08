import { t as describe } from "../describe-BnKr1Gwo.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { r as PermDockValidationError } from "../errors-DDT8tC4N.js";
import { t as createPermDock$1 } from "../permdock-CpyyhpgH.js";
import { r as requestApproval, t as inspectApproval } from "../helpers-Ce24VOuf.js";
import { t as applyOtel } from "../instrument-C8d4LNIv.js";
//#region src/mcp/errors.ts
var InsufficientScopeError = class extends Error {
	name = "InsufficientScopeError";
	code = "insufficient_scope";
	missing;
	scope;
	wwwAuthenticate;
	constructor(missing, held) {
		const scope = [.../* @__PURE__ */ new Set([...held, missing])].toSorted().join(" ");
		super(`insufficient_scope: ${missing}`);
		this.missing = missing;
		this.scope = scope;
		this.wwwAuthenticate = `Bearer error="insufficient_scope", scope="${scope}"`;
	}
};
//#endregion
//#region src/mcp/create.ts
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isAuthInfo(value) {
	return isRecord(value);
}
function authInfoOf(extra) {
	if (!isRecord(extra)) return {};
	if (isAuthInfo(extra.authInfo)) return extra.authInfo;
	if (isRecord(extra.http) && isAuthInfo(extra.http.authInfo)) return extra.http.authInfo;
	return extra;
}
function approvalTokenOf(authInfo) {
	const token = authInfo.extra?.approval;
	return typeof token === "string" && token !== "" ? token : void 0;
}
function authorizationDetailsOf(authInfo) {
	return authInfo.extra?.authorizationDetails;
}
function delegationOf(authInfo) {
	return compact({
		scopes: authInfo.scopes,
		authorizationDetails: authorizationDetailsOf(authInfo)
	});
}
async function resolveTenant(tenant, authInfo) {
	if (tenant === void 0 || typeof tenant === "string") return tenant;
	try {
		return await tenant(authInfo);
	} catch {
		return;
	}
}
function hasScope(authInfo, scope) {
	const scopes = authInfo.scopes;
	if (scopes === void 0) return false;
	return scopes.includes(scope);
}
function validateInput(schema, args, permission) {
	if (schema === void 0) return args;
	const result = schema["~standard"].validate(args);
	if (result !== null && typeof result === "object" && "then" in result && typeof result.then === "function") throw new PermDockValidationError({
		code: "async-schema",
		permission: permission.key,
		resource: permission.resource,
		boundary: "mcp-args",
		message: `${permission.key}: inputSchema is async.`
	});
	const sync = result;
	if ("issues" in sync && sync.issues !== void 0) throw new PermDockValidationError({
		code: "invalid-data",
		permission: permission.key,
		resource: permission.resource,
		issues: sync.issues,
		boundary: "mcp-args",
		message: `${permission.key}: invalid tool arguments.`
	});
	return sync.value;
}
function resourceRef(permission, data) {
	if (data !== null && typeof data === "object" && "id" in data) {
		const id = data.id;
		if (typeof id === "string" || typeof id === "number") return {
			type: permission.resource,
			id: String(id)
		};
	}
	return { type: permission.resource };
}
function refusal(decision, permission, data) {
	const described = describe(decision);
	const alternatives = decision.alternatives.map((leaf) => leaf.key);
	const resource = resourceRef(permission, data);
	return {
		isError: true,
		content: [{
			type: "text",
			text: `Denied: ${resource.id === void 0 ? permission.key : `${permission.key} on ${resource.id}`}.${alternatives.length === 0 ? "" : ` You may: ${alternatives.join(", ")}.`}`
		}],
		structuredContent: {
			outcome: "denied",
			permission: permission.key,
			resource,
			denials: decision.denials,
			alternatives,
			detail: described.detail
		}
	};
}
function validationRefusal(error) {
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
function elicitation(decision, permission, data) {
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
function resumeMatches(inspected, permission, resource, decision) {
	if (!inspected.ok) return false;
	if (inspected.request.token !== decision.token) return false;
	if (inspected.request.permission !== permission.key) return false;
	if (inspected.request.resource.id !== void 0 && inspected.request.resource.id !== resource.id) return false;
	return true;
}
function grantedDecision(dock, decision) {
	const principal = dock.subject.principal;
	if (principal === null) return {
		outcome: "denied",
		denials: [{
			role: null,
			reason: "approval"
		}],
		alternatives: []
	};
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
async function applyResume(decision, permission, dock, store, authInfo, data) {
	const header = approvalTokenOf(authInfo);
	const resource = resourceRef(permission, data);
	if (header === void 0) {
		if (decision.outcome === "approval-required" && store !== void 0) await requestApproval(store, decision, compact({
			permission,
			resource,
			subject: dock.subject,
			adapter: "mcp"
		}));
		return decision;
	}
	if (store === void 0) return {
		outcome: "denied",
		denials: [{
			role: null,
			reason: "approval",
			detail: "approval-not-found"
		}],
		alternatives: []
	};
	const inspected = await inspectApproval(store, header);
	if (!inspected.ok) return {
		outcome: "denied",
		denials: [{
			role: null,
			reason: "approval",
			detail: inspected.detail
		}],
		alternatives: []
	};
	switch (decision.outcome) {
		case "granted":
		case "denied": return decision;
		case "approval-required":
			if (!resumeMatches(inspected, permission, resource, decision)) return {
				outcome: "denied",
				denials: [{
					role: null,
					reason: "approval",
					detail: "approval-mismatch"
				}],
				alternatives: []
			};
			return grantedDecision(dock, decision);
		default: return decision;
	}
}
function snapshotAllows(dock, permission) {
	const snapshot = dock.snapshot();
	if (typeof snapshot === "string" || snapshot instanceof Promise) return false;
	return snapshot.grants.some((grant) => grant.permission === permission.key && grant.effect === "allow");
}
function createPermDock(policy, options) {
	const instanceFor = async (authInfo) => {
		let user = null;
		try {
			user = await options.subject(authInfo);
		} catch {
			user = null;
		}
		const tenant = await resolveTenant(options.tenant, authInfo);
		const actor = typeof authInfo.clientId === "string" && authInfo.clientId !== "" ? {
			id: authInfo.clientId,
			kind: "mcp-client"
		} : void 0;
		return applyOtel(await createPermDock$1(policy, user, compact({
			tenant,
			actor,
			delegation: delegationOf(authInfo),
			memberships: options.memberships,
			customRoles: options.customRoles,
			sink: options.sink
		})), options.otel);
	};
	const protectServer = (server) => {
		const registered = [];
		const original = server.registerTool.bind(server);
		const registerTool = (name, config, handler) => {
			const permission = config.permission;
			registered.push({
				name,
				permission
			});
			const wrapped = async (args, extra) => {
				const authInfo = authInfoOf(extra);
				if (!hasScope(authInfo, permission.scope)) throw new InsufficientScopeError(permission.scope, authInfo.scopes ?? []);
				let validated;
				try {
					validated = validateInput(config.inputSchema, args, permission);
				} catch (error) {
					if (error instanceof PermDockValidationError) return validationRefusal(error);
					throw error;
				}
				let data;
				if (config.data !== void 0) data = await config.data(validated);
				const dock = await instanceFor(authInfo);
				const decision = await applyResume(dock.decide(permission, data, compact({
					source: "adapter",
					adapter: "mcp",
					boundary: "mcp-args"
				})), permission, dock, options.store, authInfo, data);
				switch (decision.outcome) {
					case "granted": return handler(validated, extra);
					case "denied": return refusal(decision, permission, data);
					case "approval-required": return elicitation(decision, permission, data);
					default: return decision;
				}
			};
			return original(name, compact({
				description: config.description,
				inputSchema: config.inputSchema,
				scopeChallenge: { scope: permission.scope }
			}), wrapped);
		};
		const listTools = async (authInfo) => {
			const dock = await instanceFor(authInfo);
			const visible = [];
			for (const tool of registered) if (tool.permission.kind === "collection" ? dock.can(tool.permission) : snapshotAllows(dock, tool.permission)) visible.push({ name: tool.name });
			return visible;
		};
		server.registerTool = registerTool;
		const guarded = server;
		guarded.listTools = listTools;
		return guarded;
	};
	return { protectServer };
}
//#endregion
export { InsufficientScopeError, createPermDock };
