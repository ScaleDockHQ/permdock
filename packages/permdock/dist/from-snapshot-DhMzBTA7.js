import { a as isMembershipExpired, c as resolveActiveTenant, i as decisionToken, s as nowSeconds, u as evaluateCondition } from "./snapshot-N9NikhGh.js";
import { n as freezeDeep, t as compact } from "./compact-CxCColYy.js";
import { a as deniedMessage, i as approvalMessage, n as PermDockDeniedError, t as PermDockApprovalRequiredError } from "./errors-Q-hDyBns.js";
//#region src/core/from-snapshot.ts
function isRowPair(value) {
	return value !== null && typeof value === "object" && "current" in value && "next" in value;
}
function coveredByInclude(snapshot, permission) {
	const include = snapshot.include;
	if (include === void 0 || include.length === 0) return true;
	return include.some((prefix) => permission.key === prefix || permission.key.startsWith(`${prefix}.`) || permission.resource === prefix);
}
function rowId(data) {
	if (data === null || typeof data !== "object") return "*";
	const id = data.id;
	return typeof id === "string" || typeof id === "number" ? String(id) : "*";
}
function subjectFromSnapshot(snapshot, tenant) {
	const principal = snapshot.subject.principal;
	const nextTenant = principal === null ? void 0 : tenant === void 0 ? principal.tenant : resolveActiveTenant(compact({
		...principal,
		memberships: principal.memberships ?? []
	}), tenant);
	return freezeDeep(compact({
		principal: principal === null ? null : compact({
			...principal,
			tenant: nextTenant
		}),
		delegation: snapshot.subject.delegation,
		context: snapshot.subject.context,
		expiresAt: snapshot.expiresAt
	}));
}
function scopeOk(grant, subject, data, team, now) {
	const scope = grant.scope;
	if (scope === void 0) return { ok: true };
	const principal = subject.principal;
	if (principal === null) return {
		ok: false,
		reason: "no-membership"
	};
	const membership = grant.membership;
	if (membership !== void 0 && isMembershipExpired(membership, now)) return {
		ok: false,
		reason: "expired-membership"
	};
	if (scope === "tenant") {
		if (principal.tenant === void 0) return {
			ok: false,
			reason: "no-membership"
		};
		if (membership?.tenant !== void 0 && membership.tenant !== principal.tenant) return {
			ok: false,
			reason: "tenant-mismatch"
		};
		return { ok: true };
	}
	if (scope === "team") {
		if (principal.tenant === void 0) return {
			ok: false,
			reason: "no-membership"
		};
		if (team !== void 0 && membership?.team !== team) return {
			ok: false,
			reason: "scope"
		};
		if (membership?.tenant !== void 0 && membership.tenant !== principal.tenant) return {
			ok: false,
			reason: "tenant-mismatch"
		};
		return { ok: true };
	}
	const on = membership?.on;
	if (on === void 0 || on.resource !== scope.resource) return {
		ok: false,
		reason: "scope"
	};
	if (on.id !== rowId(data)) return {
		ok: false,
		reason: "scope"
	};
	return { ok: true };
}
function conditionOk(grant, permission, current, next, subject, now) {
	if (grant.portable === false) return {
		matched: false,
		reason: "opaque-condition"
	};
	if (grant.where !== void 0) {
		if (permission.kind === "collection" || current === void 0) return {
			matched: false,
			reason: "condition"
		};
		if (grant.where.op === "opaque" || grant.check?.op === "opaque") return {
			matched: false,
			reason: "opaque-condition"
		};
		if (!evaluateCondition(grant.where, current, subject, now)) return {
			matched: false,
			reason: "condition"
		};
	}
	const check = grant.check;
	if (check !== void 0) {
		if (check.op === "opaque") return {
			matched: false,
			reason: "opaque-condition"
		};
		if (next === void 0) return {
			matched: false,
			reason: "condition"
		};
		if (!evaluateCondition(check, next, subject, now)) return {
			matched: false,
			reason: "condition"
		};
	}
	return { matched: true };
}
function coveredByDelegation(permission, subject) {
	const delegation = subject.delegation;
	if (delegation === void 0) return;
	const hasScopes = delegation.scopes !== void 0;
	const hasDetails = delegation.authorizationDetails !== void 0;
	if (!hasScopes && !hasDetails) return;
	if (hasScopes && (delegation.scopes?.length ?? 0) === 0 && !hasDetails) return "no-delegation";
	const scopeAllowed = delegation.scopes?.includes(permission.scope) ?? false;
	const detailOk = delegation.authorizationDetails?.some((detail) => {
		if (detail.type !== permission.resource) return false;
		return detail.actions === void 0 || detail.actions.includes(permission.action);
	}) ?? false;
	if (scopeAllowed || detailOk) return;
	return "not-delegated";
}
function evaluateSnapshot(snapshot, subject, permission, data, team, options) {
	const now = options.now ?? nowSeconds();
	if (subject.principal === null) return freezeDeep({
		outcome: "denied",
		denials: [{
			role: null,
			reason: "anonymous"
		}],
		alternatives: []
	});
	if (!coveredByInclude(snapshot, permission)) return freezeDeep({
		outcome: "denied",
		denials: [{
			role: null,
			reason: "opaque-condition"
		}],
		alternatives: []
	});
	let current = data;
	let next = data;
	if (permission.kind === "instance" && isRowPair(data)) {
		current = data.current;
		next = data.next;
	}
	if (permission.kind === "collection") {
		current = void 0;
		next = data;
	}
	const denials = [];
	const allows = [];
	for (const grant of snapshot.grants) {
		if (grant.permission !== permission.key) continue;
		const scoped = scopeOk(grant, subject, current, team, now);
		if (!scoped.ok) {
			denials.push({
				role: grant.role,
				reason: scoped.reason
			});
			continue;
		}
		const condition = conditionOk(grant, permission, current, next, subject, now);
		if (!condition.matched) {
			denials.push({
				role: grant.role,
				reason: condition.reason ?? "condition"
			});
			continue;
		}
		if (grant.effect === "deny") return freezeDeep({
			outcome: "denied",
			denials: [{
				role: grant.role,
				reason: "deny"
			}],
			alternatives: []
		});
		allows.push(grant);
	}
	if (allows.length === 0) return freezeDeep({
		outcome: "denied",
		denials: denials.length > 0 ? denials : [{
			role: null,
			reason: "no-grant"
		}],
		alternatives: []
	});
	const miss = coveredByDelegation(permission, subject);
	if (miss !== void 0) return freezeDeep({
		outcome: "denied",
		denials: [{
			role: null,
			reason: miss
		}],
		alternatives: []
	});
	const matched = allows[0];
	const token = decisionToken({
		key: permission.key,
		resourceId: permission.kind === "collection" ? "*" : rowId(current),
		principal: subject.principal,
		actor: subject.actor,
		fingerprint: `snapshot:${String(snapshot.issuedAt)}`
	});
	const grant = compact({
		role: matched.role,
		permission: permission.key,
		where: matched.where,
		check: matched.check,
		approval: matched.approval
	});
	if (matched.approval === "human") return freezeDeep({
		outcome: "approval-required",
		grant,
		reason: "human",
		token
	});
	return freezeDeep({
		outcome: "granted",
		subject: {
			...subject,
			principal: subject.principal
		},
		matched: grant,
		token
	});
}
function resourceRef(permission, data) {
	const id = permission.kind === "collection" ? void 0 : rowId(data);
	return id === void 0 || id === "*" ? { type: permission.resource } : {
		type: permission.resource,
		id
	};
}
function heldRoles(subject, tenant) {
	const names = new Set(subject.principal?.roles ?? []);
	for (const membership of subject.principal?.memberships ?? []) {
		if (tenant !== void 0 && membership.tenant !== tenant) continue;
		for (const role of membership.roles) names.add(role);
	}
	return [...names];
}
function whereFromSnapshot(snapshot, permission) {
	const grants = snapshot.grants.filter((grant) => grant.permission === permission.key);
	const allows = grants.filter((grant) => grant.effect === "allow" && grant.portable !== false);
	const denies = grants.filter((grant) => grant.effect === "deny" && grant.portable !== false);
	const partial = grants.some((grant) => grant.portable === false);
	if (allows.length === 0) return {
		condition: {
			op: "or",
			conditions: []
		},
		partial
	};
	const parts = allows.map((grant) => {
		let condition = grant.where ?? {
			op: "eq",
			field: "_",
			value: true
		};
		for (const denyGrant of denies) if (denyGrant.where !== void 0) condition = {
			op: "and",
			conditions: [condition, {
				op: "not",
				condition: denyGrant.where
			}]
		};
		return condition;
	});
	return {
		condition: parts.length === 1 ? parts[0] : {
			op: "or",
			conditions: parts
		},
		partial
	};
}
function fromSnapshot(snapshot, options = {}) {
	const subject = subjectFromSnapshot(snapshot, options.tenant);
	const team = options.team;
	const run = (permission, data, decideOptions = {}) => evaluateSnapshot(snapshot, subject, permission, data, team, decideOptions);
	const decide = ((permission, data, decideOptions = {}) => run(permission, data, decideOptions));
	const can = ((permission, data, decideOptions) => run(permission, data, decideOptions).outcome === "granted");
	const assert = ((permission, data, decideOptions) => {
		const decision = run(permission, data, decideOptions);
		if (decision.outcome === "granted") return decision;
		if (decision.outcome === "approval-required") throw new PermDockApprovalRequiredError({
			decision,
			permission: permission.key,
			scope: permission.scope,
			resource: resourceRef(permission, data),
			message: approvalMessage(permission.key, decision.reason, decision.token)
		});
		throw new PermDockDeniedError({
			decision,
			permission: permission.key,
			scope: permission.scope,
			resource: resourceRef(permission, data),
			subject,
			message: deniedMessage(permission.key, subject.principal?.id, decision.denials, [])
		});
	});
	return Object.freeze({
		can,
		decide,
		assert,
		filter(permission, rows, decideOptions) {
			return rows.filter((row) => can(permission, row, decideOptions) === true);
		},
		where(permission) {
			return whereFromSnapshot(snapshot, permission);
		},
		simulate: ((input) => {
			if (Array.isArray(input)) return input.map(([permission, data]) => run(permission, data));
			const preview = input;
			return fromSnapshot(freezeDeep({
				...snapshot,
				simulated: true,
				subject: {
					...snapshot.subject,
					principal: snapshot.subject.principal === null ? null : compact({
						...snapshot.subject.principal,
						roles: preview.roles ?? snapshot.subject.principal.roles,
						memberships: preview.memberships ?? snapshot.subject.principal.memberships,
						tenant: preview.tenant ?? snapshot.subject.principal.tenant
					})
				}
			}), options);
		}),
		snapshot() {
			return snapshot;
		},
		on() {
			return () => void 0;
		},
		tenant(id) {
			return fromSnapshot(snapshot, compact({
				tenant: id,
				team
			}));
		},
		team(id) {
			return fromSnapshot(snapshot, compact({
				tenant: options.tenant,
				team: id
			}));
		},
		memberships() {
			return subject.principal?.memberships ?? [];
		},
		tenants() {
			return snapshot.tenants;
		},
		roles(query) {
			return heldRoles(subject, query?.tenant ?? subject.principal?.tenant);
		},
		assignable() {
			return [];
		},
		subject
	});
}
function emptySnapshot() {
	return freezeDeep({
		v: 2,
		issuedAt: 0,
		subject: {
			principal: null,
			context: {}
		},
		roles: [],
		grants: [],
		tenants: []
	});
}
//#endregion
export { fromSnapshot as n, emptySnapshot as t };
