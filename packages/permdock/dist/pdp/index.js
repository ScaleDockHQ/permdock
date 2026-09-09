import { t as decisionToken } from "../token-DOBVfZ_i.js";
import { t as freezeDeep } from "../freeze-BF4IK5al.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { a as deniedMessage, i as approvalMessage, n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "../errors-DDT8tC4N.js";
import { t as createPermDock$1 } from "../permdock-C-YFXzhV.js";
import { i as getResource, o as listPermissions } from "../permissions-WEkUHQtZ.js";
import { o as isRecord } from "../map-BA2lzIVj.js";
//#region src/pdp/create.ts
function withoutProviders(policy) {
	if (policy.providers === void 0 || policy.providers.length === 0) return policy;
	return freezeDeep(compact({
		permissions: policy.permissions,
		roles: policy.roles,
		rolesByName: policy.rolesByName,
		scopes: policy.scopes,
		subject: policy.subject,
		context: policy.context,
		validate: policy.validate,
		onDenied: policy.onDenied,
		fingerprint: policy.fingerprint,
		resources: policy.resources
	}));
}
function providerFor(providers, permission) {
	for (const provider of providers) if (provider.handles(permission)) return provider;
}
function isExplicitDeny(decision) {
	return decision.outcome === "denied" && decision.denials.some((denial) => denial.reason === "deny");
}
function isLocalShortCircuit(decision) {
	if (decision.outcome !== "denied") return false;
	if (isExplicitDeny(decision)) return true;
	return decision.denials.some((denial) => {
		switch (denial.reason) {
			case "no-grant": return false;
			case "pdp-denied":
			case "pdp-unavailable":
			case "pdp-invalid-response": return false;
			case "anonymous":
			case "validation":
			case "not-delegated":
			case "no-delegation":
			case "condition":
			case "deny":
			case "closure-error":
			case "opaque-condition":
			case "insufficient-user-authentication":
			case "limit":
			case "limit-unavailable":
			case "tenant-mismatch":
			case "no-membership":
			case "scope":
			case "expired-membership":
			case "unknown-role":
			case "approval": return true;
			default: return denial.reason;
		}
	});
}
function wrap(dock, policy, subject, providers) {
	const decideLocal = dock.decide;
	const decide = (permission, data, options) => {
		const local = decideLocal(permission, data, options);
		const provider = providerFor(providers, permission);
		if (provider === void 0 || isLocalShortCircuit(local)) return Promise.resolve(local);
		return provider.decide({
			permission,
			data,
			subject,
			local
		});
	};
	const can = async (permission, data, options) => {
		try {
			return (await decide(permission, data, options)).outcome === "granted";
		} catch {
			return false;
		}
	};
	const assert = async (permission, data, options) => {
		const decision = await decide(permission, data, {
			...options,
			source: options?.source ?? "assert"
		});
		if (decision.outcome === "granted") return decision;
		const onDenied = options?.onDenied ?? policy.onDenied;
		if (onDenied !== void 0) onDenied(decision);
		const resource = getResource(policy.permissions, permission.resource);
		const resourceId = data !== null && typeof data === "object" ? data[resource?.id ?? "id"] : void 0;
		const resourceRef = compact({
			type: permission.resource,
			id: resourceId === void 0 ? void 0 : String(resourceId)
		});
		if (decision.outcome === "approval-required") throw new PermDockApprovalRequiredError({
			decision,
			permission: permission.key,
			scope: permission.scope,
			resource: resourceRef,
			message: approvalMessage(permission.key, decision.reason, decision.token)
		});
		if (decision.denials.some((denial) => denial.reason === "validation")) {
			const detail = decision.denials[0]?.detail;
			if (detail instanceof PermDockValidationError) throw detail;
		}
		throw new PermDockDeniedError({
			decision,
			permission: permission.key,
			scope: permission.scope,
			resource: resourceRef,
			subject,
			message: deniedMessage(permission.key, subject.principal?.id, decision.denials, decision.alternatives.map((leaf) => leaf.key))
		});
	};
	const simulate = ((input) => {
		if (Array.isArray(input)) return Promise.all(input.map(([permission, data]) => decide(permission, data, { source: "simulate" })));
		return wrap(dock.simulate(input), policy, subject, providers);
	});
	return {
		can,
		decide,
		assert,
		async filter(permission, rows, options) {
			const decisions = await Promise.all(rows.map((row) => decide(permission, row, {
				...options,
				source: "filter"
			})));
			return rows.filter((_, index) => decisions[index]?.outcome === "granted");
		},
		pick: dock.pick.bind(dock),
		where: dock.where.bind(dock),
		simulate,
		snapshot: dock.snapshot.bind(dock),
		on: dock.on.bind(dock),
		tenant: (id) => {
			const next = dock.tenant(id);
			return wrap(next, policy, next.subject, providers);
		},
		team: (id) => {
			const next = dock.team(id);
			return wrap(next, policy, next.subject, providers);
		},
		memberships: dock.memberships.bind(dock),
		tenants: dock.tenants.bind(dock),
		roles: dock.roles.bind(dock),
		assignable: dock.assignable.bind(dock),
		subject
	};
}
async function createPermDock(policy, user, options = {}) {
	const localPolicy = withoutProviders(policy);
	const dock = await createPermDock$1(localPolicy, user, options);
	return wrap(dock, localPolicy, dock.subject, policy.providers ?? []);
}
//#endregion
//#region src/pdp/remote.ts
const DEFAULT_TIMEOUT_MS = 300;
const DEFAULT_EVALUATION = "/access/v1/evaluation";
const DEFAULT_EVALUATIONS = "/access/v1/evaluations";
function ttlMs(ttl) {
	if (ttl === void 0) return 0;
	if (typeof ttl.ttl === "number") return ttl.ttl;
	if (ttl.ttl.endsWith("ms")) return Number(ttl.ttl.slice(0, -2));
	return Number(ttl.ttl.slice(0, -1)) * 1e3;
}
function joinUrl(base, path) {
	if (path.startsWith("http://") || path.startsWith("https://")) return path;
	return `${base.endsWith("/") ? base.slice(0, -1) : base}${path.startsWith("/") ? path : `/${path}`}`;
}
function delegatedKeys(listed) {
	if (listed === void 0) return null;
	const keys = /* @__PURE__ */ new Set();
	for (const item of listed) for (const leaf of listPermissions(item)) keys.add(leaf.key);
	return keys;
}
function resourceIdOf(data) {
	if (data === null || typeof data !== "object") return "*";
	const id = data.id;
	if (typeof id === "string" || typeof id === "number") return String(id);
	return "*";
}
function cacheKey(subject, permission, data) {
	return [
		subject.principal?.id ?? "",
		subject.actor?.id ?? "",
		permission.key,
		resourceIdOf(data)
	].join(":");
}
function denied(reason) {
	return {
		outcome: "denied",
		denials: [{
			role: null,
			reason
		}],
		alternatives: []
	};
}
function granted(permission, subject, fingerprint, data) {
	const principal = subject.principal;
	return {
		outcome: "granted",
		subject: {
			...subject,
			principal
		},
		matched: {
			role: "pdp",
			permission: permission.key,
			provider: "pdp"
		},
		token: decisionToken({
			key: permission.key,
			resourceId: resourceIdOf(data),
			principal,
			actor: subject.actor,
			fingerprint
		})
	};
}
function parseDiscovery(url, body) {
	if (!isRecord(body)) return null;
	const evaluation = typeof body.access_evaluation_endpoint === "string" ? body.access_evaluation_endpoint : typeof body.policy_decision_point === "string" ? joinUrl(body.policy_decision_point, DEFAULT_EVALUATION) : joinUrl(url, DEFAULT_EVALUATION);
	return compact({
		evaluation,
		evaluations: typeof body.access_evaluations_endpoint === "string" ? body.access_evaluations_endpoint : joinUrl(url, DEFAULT_EVALUATIONS),
		searchResource: typeof body.search_resource_endpoint === "string" ? body.search_resource_endpoint : void 0
	});
}
function mapEvaluationBody(permission, data, subject, mapping) {
	const defaultId = data !== null && typeof data === "object" ? data.id : void 0;
	const mappedSubject = mapping?.subject?.(subject) ?? compact({
		type: "user",
		id: subject.principal?.id,
		properties: compact({
			orgId: subject.principal?.tenant,
			roles: subject.principal?.roles,
			actor: subject.actor,
			delegation: subject.delegation
		})
	});
	const mappedResource = mapping?.resource?.(permission, data) ?? compact({
		type: permission.resource,
		id: typeof defaultId === "string" || typeof defaultId === "number" ? String(defaultId) : resourceIdOf(data),
		properties: data
	});
	return {
		subject: mappedSubject,
		action: mapping?.action?.(permission) ?? { name: permission.action },
		resource: mappedResource,
		context: compact({
			tenant: subject.principal?.tenant,
			actor: subject.actor,
			delegation: subject.delegation
		})
	};
}
function parseRemoteDecision(body, permission, subject, fingerprint, data) {
	if (!isRecord(body) || typeof body.decision !== "boolean") return denied("pdp-invalid-response");
	if (body.decision) return granted(permission, subject, fingerprint, data);
	const context = isRecord(body.context) ? body.context : {};
	if (context.outcome === "approval-required") {
		const token = typeof context.token === "string" ? context.token : "";
		return {
			outcome: "approval-required",
			grant: {
				role: "pdp",
				permission: permission.key,
				provider: "pdp",
				approval: "human"
			},
			reason: "human",
			token
		};
	}
	if (Array.isArray(context.denials)) {
		const denials = context.denials.flatMap((item) => {
			if (!isRecord(item) || typeof item.reason !== "string") return [];
			return [compact({
				role: typeof item.role === "string" ? item.role : null,
				reason: item.reason,
				detail: item.detail
			})];
		});
		if (denials.length > 0) return {
			outcome: "denied",
			denials,
			alternatives: []
		};
	}
	return denied("pdp-denied");
}
function remotePdp(options) {
	const keys = delegatedKeys(options.permissions);
	const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
	const cacheTtl = ttlMs(options.cache);
	const cache = /* @__PURE__ */ new Map();
	const fetcher = options.fetch ?? fetch;
	let discovery = options.endpoints?.evaluation === void 0 ? null : compact({
		evaluation: options.endpoints.evaluation,
		evaluations: options.endpoints.evaluations,
		searchResource: options.endpoints.searchResource
	});
	async function bearer() {
		const auth = options.auth;
		if (auth === void 0) return null;
		try {
			const token = typeof auth.bearer === "function" ? await auth.bearer() : auth.bearer;
			return token === "" ? null : token;
		} catch {
			return null;
		}
	}
	async function discover() {
		if (discovery !== null) return discovery;
		try {
			const signal = AbortSignal.timeout(timeout);
			const response = await fetcher(joinUrl(options.url, "/.well-known/authzen-configuration"), { signal });
			if (!response.ok) return null;
			const parsed = parseDiscovery(options.url, await response.json());
			if (parsed === null) return null;
			discovery = parsed;
			return parsed;
		} catch {
			return null;
		}
	}
	async function post(url, body) {
		const token = await bearer();
		const headers = {
			"content-type": "application/json",
			accept: "application/json"
		};
		if (token !== null) headers.authorization = `Bearer ${token}`;
		try {
			const response = await fetcher(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeout)
			});
			if (!response.ok) return { ok: false };
			return {
				ok: true,
				body: await response.json()
			};
		} catch {
			return { ok: false };
		}
	}
	return {
		name: "pdp",
		handles(permission) {
			return keys === null || keys.has(permission.key);
		},
		async decide(request) {
			if (request.subject.principal === null) return denied("anonymous");
			const key = cacheKey(request.subject, request.permission, request.data);
			if (cacheTtl > 0) {
				const hit = cache.get(key);
				if (hit !== void 0 && Date.now() - hit.at < cacheTtl) return hit.decision;
			}
			const endpoints = await discover();
			if (endpoints === null) return denied("pdp-unavailable");
			const posted = await post(endpoints.evaluation, mapEvaluationBody(request.permission, request.data, request.subject, options.mapping));
			if (!posted.ok) return denied("pdp-unavailable");
			const decision = parseRemoteDecision(posted.body, request.permission, request.subject, "pdp", request.data);
			const cacheable = decision.outcome === "granted" || decision.outcome === "approval-required" || decision.outcome === "denied" && decision.denials[0]?.reason === "pdp-denied";
			if (cacheTtl > 0 && cacheable) cache.set(key, {
				at: Date.now(),
				decision
			});
			return decision;
		}
	};
}
//#endregion
export { createPermDock, remotePdp };
