import { t as compact } from "../compact-CxSqQNw0.js";
import { n as PermDockDeniedError, t as PermDockApprovalRequiredError } from "../errors-DDT8tC4N.js";
import { t as createPermDock$1 } from "../permdock-Kp60ds1F.js";
//#region src/a2a/create.ts
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function firstScheme(options) {
	return Object.keys(options.securitySchemes)[0];
}
function skillOf(id, permission, description, scheme) {
	return compact({
		id,
		name: id,
		description: description ?? permission.key,
		securityRequirements: scheme === void 0 ? [] : [{ [scheme]: [permission.scope] }]
	});
}
function publicSkills(options) {
	const scheme = firstScheme(options);
	return Object.entries(options.skills).map(([id, config]) => skillOf(id, config.permission, config.description, scheme));
}
function cardOf(options, skills) {
	return compact({
		name: options.card.name,
		description: options.card.description,
		url: options.card.url,
		version: options.card.version,
		protocolVersion: "1.0",
		securitySchemes: options.securitySchemes,
		skills
	});
}
function delegationOf(auth) {
	return compact({
		scopes: auth.scopes,
		authorizationDetails: auth.extra?.authorizationDetails
	});
}
function actorOf(auth) {
	return typeof auth.clientId === "string" && auth.clientId !== "" ? {
		id: auth.clientId,
		kind: "oauth-client"
	} : void 0;
}
async function resolveTenant(tenant, auth) {
	if (tenant === void 0 || typeof tenant === "string") return tenant;
	try {
		return await tenant(auth);
	} catch {
		return;
	}
}
function hasScope(auth, scope) {
	return auth.scopes?.includes(scope) === true;
}
function snapshotAllows(dock, permission) {
	const snapshot = dock.snapshot();
	if (typeof snapshot === "string" || snapshot instanceof Promise) return false;
	return snapshot.grants.some((grant) => grant.permission === permission.key && grant.effect === "allow");
}
function skillAllowed(dock, permission) {
	if (permission.kind === "collection") return dock.can(permission);
	return snapshotAllows(dock, permission);
}
function resourceRef(permission, data) {
	if (!isRecord(data)) return { type: permission.resource };
	const id = data.id;
	return typeof id === "string" || typeof id === "number" ? {
		type: permission.resource,
		id: String(id)
	} : { type: permission.resource };
}
function wwwAuthenticate(scope, held) {
	return `Bearer error="insufficient_scope", scope="${[.../* @__PURE__ */ new Set([...held, scope])].toSorted().join(" ")}"`;
}
function deniedOutcome(decision, permission, data, dock) {
	return {
		ok: false,
		status: 403,
		state: "failed",
		problem: new PermDockDeniedError({
			decision,
			permission: permission.key,
			scope: permission.scope,
			resource: resourceRef(permission, data),
			subject: dock.subject,
			message: `${permission.key} denied.`
		}).toProblemDetails()
	};
}
function approvalOutcome(decision, permission, data) {
	return {
		ok: false,
		status: 403,
		state: "input-required",
		problem: new PermDockApprovalRequiredError({
			decision,
			permission: permission.key,
			scope: permission.scope,
			resource: resourceRef(permission, data),
			message: `${permission.key} requires human approval.`
		}).toProblemDetails()
	};
}
async function signCard(card, signPayload) {
	return {
		card,
		signature: await signPayload(JSON.stringify(card))
	};
}
function missingScope(permission, auth) {
	return {
		ok: false,
		status: 401,
		state: "failed",
		problem: {
			type: "https://permdock.dev/problems/unauthenticated",
			title: "Insufficient scope",
			status: 401,
			detail: `insufficient_scope: ${permission.scope}`,
			permission: permission.key,
			scope: permission.scope
		},
		wwwAuthenticate: wwwAuthenticate(permission.scope, auth.scopes ?? [])
	};
}
function createPermDock(policy, options) {
	const instanceFor = async (auth) => {
		let user = null;
		try {
			user = await options.subject(auth);
		} catch {
			user = null;
		}
		const tenant = await resolveTenant(options.tenant, auth);
		return createPermDock$1(policy, user, compact({
			tenant,
			actor: actorOf(auth),
			delegation: delegationOf(auth),
			memberships: options.memberships,
			customRoles: options.customRoles,
			sink: options.sink
		}));
	};
	const agentCard = () => cardOf(options, publicSkills(options));
	const extendedAgentCard = async (auth) => {
		const dock = await instanceFor(auth);
		const scheme = firstScheme(options);
		const skills = [];
		for (const [id, config] of Object.entries(options.skills)) if (skillAllowed(dock, config.permission)) skills.push(skillOf(id, config.permission, config.description, scheme));
		return cardOf(options, skills);
	};
	const protectSkill = (selector) => async (task, auth) => {
		const id = selector(task);
		const config = options.skills[id];
		if (config === void 0) return {
			ok: false,
			status: 403,
			state: "failed",
			problem: {
				type: "https://permdock.dev/problems/denied",
				title: "Permission denied",
				status: 403,
				detail: "unknown skill"
			}
		};
		if (!hasScope(auth, config.permission.scope)) return missingScope(config.permission, auth);
		let data = task;
		if (config.data !== void 0) data = await config.data(task);
		const dock = await instanceFor(auth);
		const decision = dock.decide(config.permission, data, compact({
			source: "adapter",
			adapter: "a2a"
		}));
		switch (decision.outcome) {
			case "granted": return { ok: true };
			case "denied": return deniedOutcome(decision, config.permission, data, dock);
			case "approval-required": return approvalOutcome(decision, config.permission, data);
			default: return decision;
		}
	};
	return {
		agentCard,
		extendedAgentCard,
		protectSkill,
		sign: signCard
	};
}
//#endregion
export { createPermDock };
