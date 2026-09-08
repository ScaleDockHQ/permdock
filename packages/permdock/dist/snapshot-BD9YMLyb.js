import { n as isForbiddenKey } from "./paths-AH4M6YYV.js";
import { t as freezeDeep } from "./freeze-BF4IK5al.js";
import { t as compact } from "./compact-CxSqQNw0.js";
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
export { matchScopedMembership as a, tenantsOf as c, isMembershipExpired as i, parseSnapshot as n, nowSeconds as o, signSnapshot as r, resolveActiveTenant as s, buildSnapshot as t };
