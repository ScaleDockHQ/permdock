import { n as isConditionDate, r as isConditionRef, t as isCondition } from "./ast-BMo2MvmN.js";
import { i as ownKeys, o as splitPath, t as assertSafeKey } from "./paths-AH4M6YYV.js";
import { t as freezeDeep } from "./freeze-BF4IK5al.js";
import { t as compact } from "./compact-CxSqQNw0.js";
import { o as listPermissions, r as getRegistry } from "./permissions-WEkUHQtZ.js";
import { i as sanitizeFields } from "./fields-BXlUUepW.js";
import { n as sha256, t as bytesToBase64Url } from "./sha256-CeSpVRME.js";
//#region src/conditions/opaque.ts
function opaque(input) {
	return freezeDeep({
		op: "opaque",
		sql: input.sql,
		fingerprint: input.fingerprint
	});
}
//#endregion
//#region src/conditions/refs.ts
const REF_BRAND = Symbol.for("permdock.ref");
function createRef(path) {
	const segments = splitPath(path);
	for (const segment of segments) assertSafeKey(segment, "subject path");
	const target = freezeDeep({ ref: path });
	return new Proxy(target, {
		get(object, property, receiver) {
			if (property === "ref" || property === REF_BRAND) return Reflect.get(object, property === REF_BRAND ? "ref" : property, receiver);
			if (property === "toJSON" || property === "valueOf" || property === Symbol.toStringTag) return;
			if (typeof property !== "string") return;
			assertSafeKey(property, "subject path");
			return createRef(`${path}.${property}`);
		},
		getOwnPropertyDescriptor(object, property) {
			if (property === "ref") return Reflect.getOwnPropertyDescriptor(object, property);
		},
		ownKeys() {
			return ["ref"];
		}
	});
}
const subject = createRef("subject");
function isSubjectRef(value) {
	return value !== null && typeof value === "object" && "ref" in value && typeof value.ref === "string" && value.ref.startsWith("subject");
}
//#endregion
//#region src/conditions/normalize.ts
const FIELD_OPS = /* @__PURE__ */ new Set([
	"eq",
	"ne",
	"gt",
	"gte",
	"lt",
	"lte",
	"contains",
	"in",
	"notIn",
	"isNull"
]);
function toValue(raw) {
	if (isSubjectRef(raw) || isConditionRef(raw)) return freezeDeep({ ref: raw.ref });
	if (raw instanceof Date) return freezeDeep({ date: raw.toISOString() });
	if (isConditionDate(raw)) return freezeDeep({ date: raw.date });
	if (Array.isArray(raw)) return raw.map((item) => toValue(item));
	if (raw === null || typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
	throw new Error("PermDock: unsupported condition value");
}
function flatten(op, conditions) {
	const out = [];
	for (const condition of conditions) if (condition.op === op) out.push(...condition.conditions);
	else out.push(condition);
	return out;
}
function collapse(condition) {
	if (condition.op === "and" || condition.op === "or") {
		const flat = flatten(condition.op, condition.conditions).map(collapse);
		if (flat.length === 0) throw new Error(`PermDock: empty ${condition.op} condition`);
		if (flat.length === 1) return flat[0];
		return freezeDeep({
			op: condition.op,
			conditions: flat
		});
	}
	if (condition.op === "not") return freezeDeep({
		op: "not",
		condition: collapse(condition.condition)
	});
	return freezeDeep(condition);
}
function fieldCondition(field, raw) {
	assertSafeKey(field, "condition field");
	if (isCondition(raw) && raw.op === "opaque") return raw;
	if (raw !== null && typeof raw === "object" && !isSubjectRef(raw) && !isConditionRef(raw) && !isConditionDate(raw) && !Array.isArray(raw) && !(raw instanceof Date)) {
		const keys = ownKeys(raw);
		if (keys.length === 1 && keys[0] !== void 0 && FIELD_OPS.has(keys[0])) {
			const op = keys[0];
			const value = raw[op];
			if (op === "isNull") {
				if (typeof value !== "boolean") throw new TypeError("PermDock: isNull requires a boolean");
				return collapse({
					op: "isNull",
					field,
					value
				});
			}
			if (op === "in" || op === "notIn") {
				if (isSubjectRef(value) || isConditionRef(value)) return collapse({
					op,
					field,
					value: { ref: value.ref }
				});
				if (!Array.isArray(value)) throw new TypeError(`PermDock: ${op} requires an array or subject reference`);
				return collapse({
					op,
					field,
					value: value.map((item) => toValue(item))
				});
			}
			return collapse({
				op,
				field,
				value: toValue(value)
			});
		}
	}
	return collapse({
		op: "eq",
		field,
		value: toValue(raw)
	});
}
function normalizeWhere(input) {
	if (isCondition(input)) return collapse(input);
	if (input !== null && typeof input === "object" && "sql" in input && "fingerprint" in input && typeof input.sql === "string") return opaque({
		sql: input.sql,
		fingerprint: input.fingerprint
	});
	if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("PermDock: condition must be an object");
	const parts = [];
	for (const key of Object.keys(input)) {
		const value = input[key];
		if (key === "and") {
			if (!Array.isArray(value)) throw new TypeError("PermDock: and requires an array");
			parts.push(collapse({
				op: "and",
				conditions: value.map(normalizeWhere)
			}));
			continue;
		}
		if (key === "or") {
			if (!Array.isArray(value)) throw new TypeError("PermDock: or requires an array");
			parts.push(collapse({
				op: "or",
				conditions: value.map(normalizeWhere)
			}));
			continue;
		}
		if (key === "not") {
			parts.push(collapse({
				op: "not",
				condition: normalizeWhere(value)
			}));
			continue;
		}
		parts.push(fieldCondition(key, value));
	}
	if (parts.length === 0) throw new Error("PermDock: empty condition");
	if (parts.length === 1) return parts[0];
	return collapse({
		op: "and",
		conditions: parts
	});
}
//#endregion
//#region src/core/policy.ts
function isClosure(value) {
	return typeof value === "function";
}
function isPermission(value) {
	return value !== null && typeof value === "object" && "key" in value && "kind" in value && "action" in value;
}
function flattenPermissions(input) {
	if (isPermission(input)) return [input];
	if (Array.isArray(input)) return input.flatMap((item) => flattenPermissions(item));
	return [...listPermissions(input)];
}
function resolveRoleScope(on) {
	if (on === void 0) return "global";
	if (on === "tenant" || on === "team") return on;
	const permissions = flattenPermissions(on);
	const names = new Set(permissions.map((permission) => permission.resource));
	if (names.size !== 1) throw new Error("PermDock: role on: resource must name exactly one resource");
	return { resource: [...names][0] };
}
function makeGrant(permission, effect, condition) {
	if (isClosure(condition)) return {
		permission,
		effect,
		portable: false,
		closure: condition
	};
	const whereInput = condition?.where;
	const checkInput = condition?.check;
	if (whereInput !== void 0 && permission.kind === "collection") throw new Error(`PermDock: where is not allowed on collection action '${permission.key}'`);
	const where = whereInput === void 0 ? void 0 : normalizeWhere(whereInput);
	const check = checkInput === void 0 ? void 0 : normalizeWhere(checkInput);
	const portable = condition?.limit === void 0;
	return compact({
		permission,
		effect,
		where,
		check,
		approval: condition?.approval,
		portable,
		limit: condition?.limit,
		fields: sanitizeFields(condition?.fields)
	});
}
function allow(permission, condition) {
	const grants = flattenPermissions(permission).map((leaf) => makeGrant(leaf, "allow", condition));
	return grants.length === 1 ? grants[0] : grants;
}
function deny(permission, condition) {
	const grants = flattenPermissions(permission).map((leaf) => makeGrant(leaf, "deny", condition));
	return grants.length === 1 ? grants[0] : grants;
}
function flattenGrants(grants) {
	const out = [];
	for (const grant of grants) if (Array.isArray(grant)) out.push(...grant);
	else out.push(grant);
	return out;
}
function role(name, grants, options) {
	const scope = resolveRoleScope(options?.on);
	const assignable = options?.assignable ?? scope !== "global";
	const normalised = flattenGrants(grants).map((grant) => freezeDeep({
		...grant,
		role: name,
		scope
	}));
	return freezeDeep(compact({
		name,
		grants: normalised,
		on: options?.on,
		assignable
	}));
}
function canonicalGrants(roles) {
	const payload = roles.map((item) => ({
		name: item.name,
		assignable: item.assignable,
		scope: item.grants[0]?.scope ?? "global",
		grants: item.grants.map((grant) => ({
			permission: grant.permission.key,
			effect: grant.effect,
			where: grant.where,
			check: grant.check,
			approval: grant.approval,
			portable: grant.portable,
			fields: grant.fields,
			scope: grant.scope
		}))
	}));
	return JSON.stringify(payload);
}
function assertParentGraph(resources) {
	for (const node of resources.values()) {
		if (node.parent === void 0) continue;
		if (!resources.has(node.parent.resource)) throw new Error(`PermDock: resource '${node.name}' parents unknown resource '${node.parent.resource}'`);
	}
}
function assertScopedResources(roles, scopes, resources) {
	const needsTenant = roles.some((item) => item.grants.some((grant) => grant.scope === "tenant"));
	const needsTeam = roles.some((item) => item.grants.some((grant) => grant.scope === "team"));
	if (needsTenant && scopes.tenant === void 0) throw new Error("PermDock: definePolicy({ scopes.tenant }) is required for on: 'tenant' roles");
	if (needsTeam && scopes.team === void 0) throw new Error("PermDock: definePolicy({ scopes.team }) is required for on: 'team' roles");
}
function definePolicy(permissions, options) {
	const resources = getRegistry(permissions);
	assertParentGraph(resources);
	const merged = /* @__PURE__ */ new Map();
	for (const item of options.roles) {
		const existing = merged.get(item.name);
		if (existing === void 0) {
			merged.set(item.name, item);
			continue;
		}
		merged.set(item.name, freezeDeep(compact({
			name: item.name,
			grants: [...existing.grants, ...item.grants],
			on: existing.on,
			assignable: existing.assignable
		})));
	}
	const roles = [...merged.values()];
	const scopes = options.scopes ?? {};
	assertScopedResources(roles, scopes, resources);
	const fingerprint = bytesToBase64Url(sha256(canonicalGrants(roles)));
	return freezeDeep({
		permissions,
		roles,
		rolesByName: merged,
		scopes,
		subject: options.subject,
		context: options.context,
		validate: options.validate ?? "boundary",
		onDenied: options.onDenied,
		fingerprint,
		resources,
		providers: options.providers
	});
}
//#endregion
export { subject as a, role as i, definePolicy as n, opaque as o, deny as r, allow as t };
