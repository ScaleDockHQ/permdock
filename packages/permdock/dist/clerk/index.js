import { t as freezeDeep } from "../freeze-BF4IK5al.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { t as anonymousSubject } from "../subject-DgYVJ_Q0.js";
//#region src/clerk/subject.ts
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asRoles(value) {
	if (typeof value === "string") return value === "" ? [] : [value];
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string");
}
function readPath(record, path) {
	let current = record;
	for (const part of path.split(".")) {
		if (!isRecord(current) || !Object.hasOwn(current, part)) return;
		current = current[part];
	}
	return current;
}
function validateClaims(extra, schema) {
	const result = schema["~standard"].validate(extra);
	if (result instanceof Promise) return;
	if ("issues" in result && result.issues !== void 0) return;
	const value = result.value;
	return isRecord(value) ? value : void 0;
}
const REGISTERED_CLAIMS = /* @__PURE__ */ new Set([
	"iss",
	"sub",
	"aud",
	"exp",
	"nbf",
	"iat",
	"jti",
	"sid",
	"org_id",
	"org_role",
	"org_permissions",
	"org_slug",
	"pla",
	"fea"
]);
function extraClaims(claims) {
	const extra = {};
	for (const [key, value] of Object.entries(claims)) {
		if (REGISTERED_CLAIMS.has(key) || key === "unsafeMetadata") continue;
		extra[key] = value;
	}
	return extra;
}
function featureRoles(fea, map) {
	if (map === void 0 || typeof fea !== "string" || fea === "") return {
		roles: [],
		sources: {}
	};
	const roles = [];
	const sources = {};
	for (const raw of fea.split(",")) {
		const token = raw.trim();
		if (token === "") continue;
		const prefixed = /^([ou]):(.+)$/u.exec(token);
		const slug = prefixed?.[2] ?? token;
		const source = prefixed?.[1] === "o" || prefixed?.[1] === "u" ? prefixed[1] : void 0;
		const role = map[slug];
		if (role === void 0) continue;
		roles.push(role);
		if (source !== void 0) sources[role] = source;
	}
	return {
		roles,
		sources
	};
}
function globalRolesFrom(claims, option) {
	if (option === void 0) return [];
	if (typeof option === "function") try {
		return asRoles(option(claims));
	} catch {
		return [];
	}
	return asRoles(readPath(claims, option));
}
function isAuthObject(value) {
	if (!isRecord(value)) return false;
	return typeof value.has === "function" || isRecord(value.sessionClaims);
}
function isVerifiedPayload(value) {
	if (!isRecord(value)) return false;
	if (typeof value.sub !== "string" || value.sub === "") return false;
	return typeof value.sid === "string" || typeof value.azp === "string" || typeof value.org_id === "string";
}
function fromAuthObject(auth) {
	const claims = isRecord(auth.sessionClaims) ? { ...auth.sessionClaims } : {};
	return {
		id: typeof auth.userId === "string" ? auth.userId : typeof claims.sub === "string" ? claims.sub : void 0,
		tenant: typeof auth.orgId === "string" ? auth.orgId : typeof claims.org_id === "string" ? claims.org_id : void 0,
		orgRole: typeof auth.orgRole === "string" ? auth.orgRole : typeof claims.org_role === "string" ? claims.org_role : void 0,
		orgPermissions: auth.orgPermissions !== void 0 && auth.orgPermissions !== null ? asRoles(auth.orgPermissions) : asRoles(claims.org_permissions),
		claims,
		session: typeof auth.sessionId === "string" ? auth.sessionId : typeof claims.sid === "string" ? claims.sid : void 0
	};
}
function fromPayload(claims) {
	return {
		id: typeof claims.sub === "string" ? claims.sub : void 0,
		tenant: typeof claims.org_id === "string" ? claims.org_id : void 0,
		orgRole: typeof claims.org_role === "string" ? claims.org_role : void 0,
		orgPermissions: asRoles(claims.org_permissions),
		claims,
		session: typeof claims.sid === "string" ? claims.sid : void 0
	};
}
async function extraMemberships(backend, userId) {
	try {
		const raw = await backend?.users?.getOrganizationMembershipList?.({ userId });
		const rows = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
		const out = [];
		for (const item of rows) {
			if (!isRecord(item)) continue;
			const organization = isRecord(item.organization) ? item.organization : void 0;
			const tenant = typeof item.organizationId === "string" ? item.organizationId : typeof organization?.id === "string" ? organization.id : void 0;
			const roles = asRoles(item.role);
			if (tenant === void 0 || roles.length === 0) continue;
			out.push(compact({
				tenant,
				roles
			}));
		}
		return out;
	} catch {
		return [];
	}
}
async function subjectFromClerk(authObject, options = {}) {
	try {
		const trustedObject = isAuthObject(authObject);
		const trustedPayload = isVerifiedPayload(authObject);
		if (!trustedObject && !trustedPayload) return anonymousSubject();
		const mapped = trustedObject ? fromAuthObject(authObject) : fromPayload(authObject);
		if (mapped.id === void 0 || mapped.id === "") return anonymousSubject();
		const declared = options.declared;
		const orgRole = mapped.orgRole !== void 0 && (declared === void 0 || declared.includes(mapped.orgRole)) ? mapped.orgRole : void 0;
		const permissionRoles = Object.keys(options.permissions ?? {}).filter((key) => mapped.orgPermissions.includes(key));
		const membershipRoles = [...orgRole === void 0 ? [] : [orgRole], ...permissionRoles];
		const sessionMembership = mapped.tenant !== void 0 && membershipRoles.length > 0 ? [compact({
			tenant: mapped.tenant,
			roles: membershipRoles
		})] : [];
		const loaded = options.memberships === "all" ? await extraMemberships(options.backend, mapped.id) : [];
		const seen = new Set(sessionMembership.map((item) => item.tenant));
		const memberships = [...sessionMembership, ...loaded.filter((item) => {
			if (seen.has(item.tenant)) return false;
			seen.add(item.tenant);
			return true;
		})];
		let claims = extraClaims(mapped.claims);
		if (options.schema !== void 0) claims = validateClaims(claims, options.schema) ?? {};
		const features = featureRoles(mapped.claims.fea, options.features);
		const global = [...globalRolesFrom(mapped.claims, options.globalRoles), ...features.roles];
		const exp = mapped.claims.exp;
		const principal = compact({
			id: mapped.id,
			kind: "user",
			tenant: mapped.tenant,
			roles: global,
			memberships,
			clerkPermissions: mapped.orgPermissions,
			claims: Object.keys(claims).length === 0 ? void 0 : claims,
			featureSources: Object.keys(features.sources).length === 0 ? void 0 : features.sources
		});
		return freezeDeep(compact({
			principal,
			context: {},
			session: mapped.session,
			expiresAt: typeof exp === "number" ? exp : void 0
		}));
	} catch {
		return anonymousSubject();
	}
}
//#endregion
export { subjectFromClerk };
