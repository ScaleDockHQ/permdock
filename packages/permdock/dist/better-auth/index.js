import { t as freezeDeep } from "../freeze-BF4IK5al.js";
import { i as role, t as allow } from "../policy-Bl3L7wev.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { o as listPermissions } from "../permissions-WEkUHQtZ.js";
import { t as anonymousSubject } from "../subject-Dz8DcVLC.js";
//#region src/better-auth/parse.ts
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asRoles(value) {
	if (typeof value === "string") return value === "" ? [] : value.split(",").map((item) => item.trim()).filter((item) => item !== "");
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string");
}
function asStatements(value) {
	if (!isRecord(value)) return {};
	const out = {};
	for (const [resource, actions] of Object.entries(value)) {
		if (!Array.isArray(actions)) continue;
		out[resource] = actions.filter((action) => typeof action === "string");
	}
	return out;
}
function expiresAtSeconds(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value > 0xe8d4a51000 ? Math.floor(value / 1e3) : Math.floor(value);
	if (value instanceof Date) {
		const ms = value.getTime();
		return Number.isFinite(ms) ? Math.floor(ms / 1e3) : void 0;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? void 0 : Math.floor(parsed / 1e3);
	}
}
function unwrapList(value) {
	if (Array.isArray(value)) return value;
	if (!isRecord(value)) return [];
	for (const key of [
		"members",
		"teams",
		"organizations",
		"roles",
		"data",
		"items"
	]) {
		const inner = value[key];
		if (Array.isArray(inner)) return inner;
	}
	return [];
}
function parseMemberRows(value) {
	const out = [];
	for (const item of unwrapList(value)) {
		if (!isRecord(item)) continue;
		const tenant = typeof item.organizationId === "string" ? item.organizationId : typeof item.id === "string" ? item.id : void 0;
		const roles = asRoles(item.role ?? item.roles);
		if (tenant === void 0 || roles.length === 0) continue;
		out.push(compact({
			tenant,
			roles
		}));
	}
	return out;
}
function parseTeamRows(value) {
	const out = [];
	for (const item of unwrapList(value)) {
		if (!isRecord(item)) continue;
		const teamRecord = isRecord(item.team) ? item.team : void 0;
		const team = typeof item.teamId === "string" ? item.teamId : typeof teamRecord?.id === "string" ? teamRecord.id : void 0;
		const tenant = typeof item.organizationId === "string" ? item.organizationId : typeof teamRecord?.organizationId === "string" ? teamRecord.organizationId : void 0;
		const roles = asRoles(item.role ?? item.roles);
		if (team === void 0 || roles.length === 0) continue;
		out.push(compact({
			tenant,
			team,
			roles,
			via: `team:${team}`
		}));
	}
	return out;
}
function parseOrganizationRoles(value) {
	const out = [];
	for (const item of unwrapList(value)) {
		if (!isRecord(item)) continue;
		const name = typeof item.role === "string" ? item.role : typeof item.name === "string" ? item.name : void 0;
		if (name === void 0 || name === "") continue;
		out.push({
			name,
			statements: asStatements(item.permission ?? item.permissions ?? item.statements)
		});
	}
	return out;
}
function statementsCover(candidate, required) {
	for (const [resource, actions] of Object.entries(required)) {
		const held = candidate[resource];
		if (held === void 0) return false;
		const set = new Set(held);
		for (const action of actions) if (!set.has(action)) return false;
	}
	return true;
}
//#endregion
//#region src/better-auth/roles.ts
function statementsOf(accessRole) {
	return asStatements(accessRole.statements ?? accessRole.permissions);
}
function rolesFromAccessControl(access, permissions, options = {}) {
	const leaves = listPermissions(permissions);
	const unmatched = [];
	const roles = [];
	for (const [name, accessRole] of Object.entries(access.roles)) {
		const statements = statementsOf(accessRole);
		const grants = [];
		for (const [resource, actions] of Object.entries(statements)) for (const action of actions) {
			const leaf = leaves.find((item) => item.resource === resource && item.action === action);
			if (leaf === void 0) {
				unmatched.push({
					role: name,
					resource,
					action
				});
				continue;
			}
			grants.push(allow(leaf));
		}
		roles.push(role(name, grants, options.on === "tenant" ? { on: "tenant" } : void 0));
	}
	return Object.assign(roles, { unmatched });
}
function betterAuthRoleSource(auth, options = {}) {
	const assignableRoles = options.assignable ?? [];
	return {
		async rolesFor(tenant) {
			try {
				return parseOrganizationRoles(await auth.api?.listOrganizationRoles?.({
					query: { organizationId: tenant },
					headers: options.headers
				})).map((item) => freezeDeep(compact({
					tenant,
					name: item.name,
					includes: assignableRoles.filter((declared) => statementsCover(item.statements, declared.statements)).map((declared) => declared.name)
				})));
			} catch {
				return [];
			}
		},
		assignable() {
			return assignableRoles.map((item) => item.name);
		}
	};
}
function onRoleChange(refresh) {
	return async (event) => {
		await refresh(event);
	};
}
//#endregion
//#region src/better-auth/subject.ts
const PROFILE_FIELDS = /* @__PURE__ */ new Set([
	"name",
	"image",
	"displayName"
]);
function validateClaims(extra, schema) {
	const result = schema["~standard"].validate(extra);
	if (result instanceof Promise) return;
	if ("issues" in result && result.issues !== void 0) return;
	const value = result.value;
	return isRecord(value) ? value : void 0;
}
function extraFields(user) {
	const reserved = /* @__PURE__ */ new Set([
		"id",
		"role",
		"roles",
		"email",
		"emailVerified",
		"createdAt",
		"updatedAt",
		"banned",
		"banReason",
		"banExpires"
	]);
	const extra = {};
	for (const [key, value] of Object.entries(user)) {
		if (reserved.has(key) || PROFILE_FIELDS.has(key)) continue;
		extra[key] = value;
	}
	return extra;
}
function isTrustedSession(session) {
	if (!isRecord(session)) return false;
	return isRecord(session.user) || isRecord(session.session);
}
async function loadMemberships(auth, session, user, tenant, options) {
	const injectedMembers = parseMemberRows(session.members ?? session.member ?? user.members);
	const injectedTeams = parseTeamRows(session.teamMembers ?? session.teams ?? user.teamMembers);
	let members = injectedMembers;
	let teams = injectedTeams;
	const headers = options.headers;
	if (members.length === 0 && auth.api?.listOrganizations !== void 0) try {
		members = parseMemberRows(await auth.api.listOrganizations({ headers }));
	} catch {
		members = [];
	}
	if (members.length === 0 && auth.api?.listMembers !== void 0) try {
		members = parseMemberRows(await auth.api.listMembers({
			query: compact({ organizationId: tenant }),
			headers
		}));
	} catch {
		members = [];
	}
	if (teams.length === 0 && auth.api?.listTeams !== void 0) try {
		teams = parseTeamRows(await auth.api.listTeams({
			query: compact({ organizationId: tenant }),
			headers
		}));
	} catch {
		teams = [];
	}
	if (options.memberships === "active" && tenant !== void 0) {
		members = members.filter((item) => item.tenant === tenant);
		teams = teams.filter((item) => item.tenant === tenant);
	}
	return [...members, ...teams];
}
async function subjectFromBetterAuth(auth, session, options = {}) {
	try {
		if (session === null || session === void 0 || !isTrustedSession(session)) return anonymousSubject();
		if (!isRecord(session.user)) return anonymousSubject();
		const user = session.user;
		const record = isRecord(session.session) ? session.session : void 0;
		const id = typeof user.id === "string" ? user.id : void 0;
		if (id === void 0 || id === "") return anonymousSubject();
		const tenant = typeof record?.activeOrganizationId === "string" ? record.activeOrganizationId : void 0;
		const roles = asRoles(user.role ?? user.roles);
		const declared = options.declared;
		const globalRoles = declared === void 0 ? roles : roles.filter((role) => declared.includes(role));
		let extra = extraFields(user);
		if (options.schema !== void 0) extra = validateClaims(extra, options.schema) ?? {};
		const memberships = await loadMemberships(auth, session, user, tenant, options);
		const principal = compact({
			id,
			kind: "user",
			roles: globalRoles,
			tenant,
			memberships,
			email: typeof user.email === "string" ? user.email : void 0,
			claims: Object.keys(extra).length === 0 ? void 0 : extra
		});
		return freezeDeep(compact({
			principal,
			context: {},
			session: typeof record?.id === "string" ? record.id : void 0,
			expiresAt: expiresAtSeconds(record?.expiresAt)
		}));
	} catch {
		return anonymousSubject();
	}
}
//#endregion
export { betterAuthRoleSource, onRoleChange, rolesFromAccessControl, subjectFromBetterAuth };
