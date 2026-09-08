import { a as ownGet, i as isForbiddenKey, n as sha256, s as readPath, t as bytesToBase64Url } from "./sha256-bH0-k349.js";
import { n as freezeDeep, t as compact } from "./compact-CxCColYy.js";
//#region src/conditions/ast.ts
function isConditionRef(value) {
	return value !== null && typeof value === "object" && "ref" in value && typeof value.ref === "string";
}
function isConditionDate(value) {
	return value !== null && typeof value === "object" && "date" in value && typeof value.date === "string" && !("ref" in value);
}
function isCondition(value) {
	return value !== null && typeof value === "object" && "op" in value && typeof value.op === "string";
}
//#endregion
//#region src/conditions/evaluate.ts
function isExpired(membership, now) {
	return membership.expiresAt !== void 0 && membership.expiresAt <= now;
}
function resolveRef(ref, subject) {
	if (!ref.startsWith("subject")) return;
	const rest = ref.slice(7);
	if (rest === "") return subject;
	if (!rest.startsWith(".")) return;
	const path = rest.slice(1);
	if (path === "id") return subject.principal?.id;
	if (path.startsWith("context.")) return readPath(subject.context, path.slice(8));
	if (subject.principal === null) return;
	return readPath(subject.principal, path);
}
function unwrap(value, subject) {
	if (isConditionRef(value)) return resolveRef(value.ref, subject);
	if (isConditionDate(value)) return Date.parse(value.date);
	if (Array.isArray(value)) return value.map((item) => unwrap(item, subject));
	return value;
}
function toInstant(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (value instanceof Date) {
		const time = value.getTime();
		return Number.isNaN(time) ? void 0 : time;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? void 0 : parsed;
	}
}
function compare(op, left, right) {
	if (left === void 0 || left === null || right === void 0 || right === null) return false;
	const leftInstant = toInstant(left);
	const rightInstant = toInstant(right);
	const comparable = leftInstant !== void 0 && rightInstant !== void 0 ? [leftInstant, rightInstant] : typeof left === typeof right ? [left, right] : void 0;
	if (comparable === void 0) return false;
	const [a, b] = comparable;
	switch (op) {
		case "eq": return a === b;
		case "ne": return a !== b;
		case "gt": return a > b;
		case "gte": return a >= b;
		case "lt": return a < b;
		case "lte": return a <= b;
		default:
 /* v8 ignore next */
		return false;
	}
}
function contains(left, right) {
	if (left === void 0 || left === null || right === void 0 || right === null) return false;
	if (typeof left === "string" && typeof right === "string") return left.includes(right);
	if (Array.isArray(left)) return left.includes(right);
	return false;
}
function inList(left, right) {
	if (left === void 0 || left === null || !Array.isArray(right)) return false;
	return right.includes(left);
}
function matchesParentHop(data, parents, membershipId) {
	if (parents === void 0) return false;
	for (const parentField of parents) if (ownGet(data, parentField) === membershipId) return true;
	return false;
}
function evaluateMemberOf(condition, data, subject, now) {
	if (data === null || typeof data !== "object") return false;
	const rowValue = ownGet(data, condition.field);
	if (rowValue === void 0 || rowValue === null) return false;
	const memberships = subject.principal?.memberships ?? [];
	const wanted = new Set(condition.roles);
	for (const membership of memberships) {
		if (isExpired(membership, now)) continue;
		if (!membership.roles.some((role) => wanted.has(role))) continue;
		if (condition.scope === "tenant") {
			if (membership.tenant === rowValue) return true;
			continue;
		}
		if (condition.scope === "team") {
			if (membership.team !== rowValue) continue;
			if (membership.tenant !== void 0 && subject.principal?.tenant !== void 0) return membership.tenant === subject.principal.tenant;
			return true;
		}
		if (membership.on === void 0) continue;
		if (condition.resource !== void 0 && membership.on.resource !== condition.resource) {
			if (matchesParentHop(data, condition.parents, membership.on.id)) return true;
			continue;
		}
		if (membership.on.id === rowValue) return true;
		if (matchesParentHop(data, condition.parents, membership.on.id)) return true;
	}
	return false;
}
function evaluateCondition(condition, data, subject, now = Date.now() / 1e3) {
	switch (condition.op) {
		case "and": return condition.conditions.every((child) => evaluateCondition(child, data, subject, now));
		case "or": return condition.conditions.some((child) => evaluateCondition(child, data, subject, now));
		case "not": return !evaluateCondition(condition.condition, data, subject, now);
		case "isNull": {
			if (data === null || typeof data !== "object") return false;
			const value = ownGet(data, condition.field);
			const isNull = value === null || value === void 0;
			return condition.value ? isNull : !isNull;
		}
		case "in":
		case "notIn": {
			if (data === null || typeof data !== "object") return false;
			const left = ownGet(data, condition.field);
			const matched = inList(left, unwrap(condition.value, subject));
			return condition.op === "in" ? matched : !matched && left !== void 0 && left !== null;
		}
		case "contains":
			if (data === null || typeof data !== "object") return false;
			return contains(ownGet(data, condition.field), unwrap(condition.value, subject));
		case "eq":
		case "ne":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			if (data === null || typeof data !== "object") return false;
			return compare(condition.op, ownGet(data, condition.field), unwrap(condition.value, subject));
		case "memberOf": return evaluateMemberOf(condition, data, subject, now);
		case "opaque": return false;
		default:
 /* v8 ignore next */
		return condition;
	}
}
//#endregion
//#region src/core/errors.ts
const PROBLEM_BASE = "https://permdock.dev/problems";
var PermDockDeniedError = class extends Error {
	name = "PermDockDeniedError";
	decision;
	permission;
	scope;
	resource;
	subject;
	constructor(input) {
		super(input.message);
		this.decision = input.decision;
		this.permission = input.permission;
		this.scope = input.scope;
		this.resource = input.resource;
		this.subject = input.subject;
	}
	toProblemDetails(options) {
		return compact({
			type: `${PROBLEM_BASE}/denied`,
			title: "Permission denied",
			status: 403,
			detail: this.message,
			instance: options?.instance,
			permission: this.permission,
			scope: this.scope,
			resource: this.resource,
			denials: this.decision.denials,
			alternatives: this.decision.alternatives.map((leaf) => leaf.key)
		});
	}
};
var PermDockApprovalRequiredError = class extends Error {
	name = "PermDockApprovalRequiredError";
	decision;
	permission;
	scope;
	resource;
	token;
	reason;
	constructor(input) {
		super(input.message);
		this.decision = input.decision;
		this.permission = input.permission;
		this.scope = input.scope;
		this.resource = input.resource;
		this.token = input.decision.token;
		this.reason = input.decision.reason;
	}
	toProblemDetails(options) {
		return compact({
			type: `${PROBLEM_BASE}/approval-required`,
			title: "Approval required",
			status: 403,
			detail: this.message,
			instance: options?.instance,
			permission: this.permission,
			scope: this.scope,
			resource: this.resource,
			reason: this.reason,
			token: this.token
		});
	}
};
var PermDockValidationError = class extends Error {
	name = "PermDockValidationError";
	code;
	permission;
	resource;
	issues;
	boundary;
	constructor(input) {
		super(input.message);
		this.code = input.code;
		this.permission = input.permission;
		this.resource = input.resource;
		this.issues = input.issues ?? [];
		this.boundary = input.boundary;
	}
	toProblemDetails(options) {
		return compact({
			type: `${PROBLEM_BASE}/validation`,
			title: "Invalid resource data",
			status: 400,
			detail: this.message,
			instance: options?.instance,
			permission: this.permission,
			issues: this.issues
		});
	}
};
function deniedMessage(permission, subjectId, denials, alternatives) {
	const clauses = denials.map((denial) => `${denial.role ?? "none"} (${denial.reason})`).join(", ");
	const alt = alternatives.length === 0 ? "" : ` Alternatives: ${alternatives.join(", ")}.`;
	return `${permission} denied for subject ${subjectId ?? "anonymous"}: ${clauses}.${alt}`;
}
function approvalMessage(permission, reason, token) {
	return `${permission} requires human approval (${reason}). Token: ${token}.`;
}
//#endregion
//#region src/core/tenancy.ts
function nowSeconds(now) {
	return now ?? Date.now() / 1e3;
}
function isMembershipExpired(membership, now) {
	return membership.expiresAt !== void 0 && membership.expiresAt <= now;
}
function membershipScopeKind(membership) {
	const hasOn = membership.on !== void 0;
	const hasTeam = membership.team !== void 0;
	const hasTenant = membership.tenant !== void 0;
	if (hasOn && !hasTeam && !hasTenant) return "resource";
	if (hasTeam && hasTenant && !hasOn) return "team";
	if (hasTenant && !hasTeam && !hasOn) return "tenant";
	return "invalid";
}
function tenantsOf(principal) {
	if (principal === null) return [];
	const tenants = /* @__PURE__ */ new Set();
	for (const membership of principal.memberships ?? []) if (membership.tenant !== void 0) tenants.add(membership.tenant);
	return [...tenants];
}
function resolveActiveTenant(principal, requested) {
	if (requested === void 0) return principal.tenant;
	return (principal.memberships ?? []).some((membership) => membership.tenant === requested) ? requested : void 0;
}
function matchScopedMembership(subject, scope, roleName, row, scopes, resource, now) {
	if (scope === "global") return { ok: true };
	const principal = subject.principal;
	if (principal === null) return {
		ok: false,
		reason: "no-membership"
	};
	const memberships = principal.memberships ?? [];
	let sawExpired = false;
	let sawWrongScope = false;
	let sawTenantMismatch = false;
	for (const membership of memberships) {
		if (!membership.roles.includes(roleName)) continue;
		if (isMembershipExpired(membership, now)) {
			sawExpired = true;
			continue;
		}
		const kind = membershipScopeKind(membership);
		if (kind === "invalid") continue;
		if (scope === "tenant") {
			if (kind !== "tenant" && kind !== "team") continue;
			const active = principal.tenant;
			if (active === void 0 || membership.tenant !== active) continue;
			if (row !== null && typeof row === "object" && scopes.tenant !== void 0) {
				const rowTenant = row[scopes.tenant.key];
				if (rowTenant !== void 0 && rowTenant !== membership.tenant) {
					sawTenantMismatch = true;
					continue;
				}
			}
			return {
				ok: true,
				membership
			};
		}
		if (scope === "team") {
			if (kind !== "team") continue;
			const active = principal.tenant;
			if (active === void 0 || membership.tenant !== active) continue;
			if (row !== null && typeof row === "object" && scopes.team !== void 0) {
				const rowTeam = row[scopes.team.key];
				if (rowTeam !== void 0 && rowTeam !== membership.team) {
					sawWrongScope = true;
					continue;
				}
			}
			return {
				ok: true,
				membership
			};
		}
		if (kind !== "resource" || membership.on === void 0) continue;
		if (matchResourceMembership(membership, scope.resource, row, resource)) return {
			ok: true,
			membership
		};
		sawWrongScope = true;
	}
	if (scope === "tenant" && principal.tenant !== void 0) {
		if (!memberships.some((membership) => membership.tenant === principal.tenant && !isMembershipExpired(membership, now))) return {
			ok: false,
			reason: "no-membership"
		};
	}
	if (sawTenantMismatch) return {
		ok: false,
		reason: "tenant-mismatch"
	};
	if (sawExpired && !sawWrongScope) return {
		ok: false,
		reason: "expired-membership"
	};
	if (sawWrongScope) return {
		ok: false,
		reason: "scope"
	};
	return {
		ok: false,
		reason: "no-membership"
	};
}
function matchResourceMembership(membership, resourceName, row, resource) {
	const on = membership.on;
	if (on === void 0)
 /* v8 ignore next */
	return false;
	if (row === null || typeof row !== "object") return false;
	const record = row;
	if (on.resource === resourceName) return record[resource?.id ?? "id"] === on.id;
	if (resource?.parent !== void 0 && on.resource === resource.parent.resource) return record[resource.parent.field] === on.id;
	return false;
}
//#endregion
//#region src/core/token.ts
function canonical(value) {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonical);
	const record = value;
	const keys = Object.keys(record).toSorted();
	const out = {};
	for (const key of keys) {
		if (key === "binding") continue;
		out[key] = canonical(record[key]);
	}
	return out;
}
function decisionToken(input) {
	const payload = JSON.stringify({
		key: input.key,
		resourceId: input.resourceId,
		principal: canonical(input.principal),
		actor: canonical(input.actor ?? null),
		fingerprint: input.fingerprint
	});
	return `pd1.${bytesToBase64Url(sha256(payload))}`;
}
//#endregion
//#region src/core/snapshot.ts
function snapshotGrant(grant, membership) {
	const scope = grant.scope === "global" ? void 0 : grant.scope === "tenant" || grant.scope === "team" ? grant.scope : { resource: grant.scope.resource };
	const entry = compact({
		permission: grant.permission.key,
		effect: grant.effect,
		role: grant.role,
		where: grant.portable ? grant.where : void 0,
		check: grant.portable ? grant.check : void 0,
		approval: grant.approval,
		scope,
		membership,
		portable: grant.portable ? void 0 : false
	});
	return freezeDeep(entry);
}
function buildSnapshot(input) {
	const now = input.now ?? Math.floor(Date.now() / 1e3);
	const principal = input.subject.principal;
	const allTenants = tenantsOf(principal);
	const tenants = input.tenants === "all" ? allTenants : principal?.tenant === void 0 ? [] : [principal.tenant];
	const include = input.include;
	const grants = input.grants.filter((item) => {
		if (include === void 0 || include.length === 0) return true;
		return include.some((prefix) => item.grant.permission.key === prefix || item.grant.permission.key.startsWith(`${prefix}.`) || item.grant.permission.resource === prefix);
	}).map((item) => snapshotGrant(item.grant, item.membership));
	return freezeDeep(compact({
		v: 2,
		issuedAt: now,
		subject: compact({
			principal: principal === null ? null : compact({
				id: principal.id,
				roles: principal.roles ?? [],
				tenant: principal.tenant,
				memberships: principal.memberships
			}),
			delegation: input.subject.delegation,
			context: input.subject.context
		}),
		roles: input.roles,
		grants,
		tenants,
		include,
		simulated: input.simulated === true ? true : void 0,
		expiresAt: input.subject.expiresAt
	}));
}
async function signSnapshot(snapshot, signer, audience) {
	const payload = { snapshot };
	if (snapshot.subject.principal !== null) payload.sub = snapshot.subject.principal.id;
	return await signer.sign(payload, compact({
		typ: "permdock-snapshot+jwt",
		audience,
		expiresAt: snapshot.expiresAt
	}));
}
function rejectUnsafe(value, path) {
	if (value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) rejectUnsafe(item, `${path}[${index}]`);
		return;
	}
	for (const key of Object.keys(value)) {
		if (isForbiddenKey(key)) throw new Error(`PermDock: unsafe snapshot key '${key}' at ${path}`);
		rejectUnsafe(value[key], `${path}.${key}`);
	}
}
function parseSnapshot(json) {
	const value = typeof json === "string" ? JSON.parse(json) : json;
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("PermDock: snapshot must be an object");
	rejectUnsafe(value, "$");
	const version = value.v;
	if (version !== 1 && version !== 2) throw new Error(`PermDock: unsupported snapshot version '${String(version)}'`);
	return freezeDeep(value);
}
//#endregion
export { isConditionDate as _, isMembershipExpired as a, resolveActiveTenant as c, PermDockDeniedError as d, PermDockValidationError as f, isCondition as g, evaluateCondition as h, decisionToken as i, tenantsOf as l, deniedMessage as m, parseSnapshot as n, matchScopedMembership as o, approvalMessage as p, signSnapshot as r, nowSeconds as s, buildSnapshot as t, PermDockApprovalRequiredError as u, isConditionRef as v };
