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
//#region src/core/paths.ts
const FORBIDDEN_KEYS = /* @__PURE__ */ new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
function isForbiddenKey(key) {
	return FORBIDDEN_KEYS.has(key);
}
function assertSafeKey(key, context) {
	if (isForbiddenKey(key) || key.length === 0) throw new Error(`PermDock: forbidden ${context} key '${key}'`);
}
function ownGet(object, key) {
	if (isForbiddenKey(key)) return;
	if (!Object.hasOwn(object, key)) return;
	return object[key];
}
function ownKeys(object) {
	return Object.keys(object).filter((key) => !isForbiddenKey(key));
}
function splitPath(path) {
	return path.split(".").filter((segment) => segment.length > 0);
}
function readPath(root, path) {
	const segments = splitPath(path);
	let current = root;
	for (const segment of segments) {
		if (isForbiddenKey(segment)) return;
		if (current === null || current === void 0 || typeof current !== "object") return;
		current = ownGet(current, segment);
	}
	return current;
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
//#region src/core/freeze.ts
function freezeDeep(value) {
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Map || value instanceof Set) {
		Object.freeze(value);
		return value;
	}
	if (Object.isFrozen(value)) return value;
	Object.freeze(value);
	if (Array.isArray(value)) {
		for (const item of value) freezeDeep(item);
		return value;
	}
	for (const key of Object.getOwnPropertyNames(value)) freezeDeep(value[key]);
	return value;
}
//#endregion
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
//#region src/core/describe.ts
const TENANT_REASONS = /* @__PURE__ */ new Set([
	"tenant-mismatch",
	"no-membership",
	"expired-membership",
	"scope"
]);
const DELEGATION_REASONS = /* @__PURE__ */ new Set(["not-delegated", "no-delegation"]);
function describe(decision) {
	if (decision.outcome === "granted") return {
		kind: "granted",
		title: "Granted",
		detail: `${decision.matched.permission} granted.`,
		alternatives: []
	};
	if (decision.outcome === "approval-required") return {
		kind: "approval",
		title: "Approval required",
		detail: `${decision.grant.permission} requires human approval.`,
		alternatives: []
	};
	const reasons = decision.denials.map((denial) => denial.reason);
	const kind = reasons.some((reason) => TENANT_REASONS.has(reason)) ? "tenant" : reasons.some((reason) => DELEGATION_REASONS.has(reason)) ? "delegation" : reasons.includes("opaque-condition") ? "server-only" : "denied";
	return {
		kind,
		title: kind === "tenant" ? "Wrong tenant" : kind === "delegation" ? "Not delegated" : kind === "server-only" ? "Server only" : "Denied",
		detail: decision.denials.map((denial) => denial.reason).join(", "),
		alternatives: decision.alternatives
	};
}
//#endregion
//#region src/core/compact.ts
function compact(value) {
	const result = {};
	for (const key of Object.keys(value)) {
		const next = value[key];
		if (next !== void 0) result[key] = next;
	}
	return result;
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
//#region src/core/interfaces.ts
function memoryRoleSource(customRoles) {
	const byTenant = /* @__PURE__ */ new Map();
	for (const role of customRoles) {
		const list = byTenant.get(role.tenant) ?? [];
		list.push(role);
		byTenant.set(role.tenant, list);
	}
	return { rolesFor(tenant) {
		return byTenant.get(tenant) ?? [];
	} };
}
//#endregion
//#region src/core/permissions.ts
const RESOURCE_BRAND = Symbol.for("permdock.resource");
const TREE_REGISTRY = Symbol.for("permdock.registry");
const TREE_LEAVES = Symbol.for("permdock.leaves");
function isStandardSchema(value) {
	return value !== null && typeof value === "object" && "~standard" in value && typeof value["~standard"]?.version === "number";
}
function isResourceInit(value) {
	return value !== null && typeof value === "object" && RESOURCE_BRAND in value && value[RESOURCE_BRAND] === true;
}
function isResourceOptions(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && !isStandardSchema(value);
}
function metaFor(list, action) {
	if (list === void 0 || Array.isArray(list)) return freezeDeep({});
	const meta = list[action];
	return freezeDeep({ ...meta });
}
function actionNames(list) {
	if (list === void 0) return [];
	if (Array.isArray(list)) return list;
	return Object.keys(list);
}
function keyToScope(key) {
	return key.replaceAll(".", ":");
}
function makeLeaf(key, resourceName, action, meta, kind) {
	const leaf = {
		key,
		scope: keyToScope(key),
		resource: resourceName,
		action,
		meta
	};
	Object.defineProperty(leaf, "kind", {
		value: kind,
		enumerable: false,
		writable: false,
		configurable: false
	});
	return Object.freeze(leaf);
}
function resource(schemaOrOptions, options) {
	if (schemaOrOptions === void 0 && options === void 0) throw new Error("PermDock: resource() requires a schema or options");
	if (isStandardSchema(schemaOrOptions)) return {
		[RESOURCE_BRAND]: true,
		schema: schemaOrOptions,
		options: options ?? {}
	};
	if (isResourceOptions(schemaOrOptions) && options === void 0) return {
		[RESOURCE_BRAND]: true,
		schema: void 0,
		options: schemaOrOptions
	};
	throw new Error("PermDock: resource() first argument must be a schema or options");
}
function materialiseResource(init, path, registry, leaves, depth) {
	if (depth > 10) throw new Error(`PermDock: permission group nesting exceeds 10`);
	const name = path.at(-1);
	if (name === void 0) throw new Error("PermDock: resource() cannot be the root of definePermissions");
	assertSafeKey(name, "resource");
	if (registry.has(name)) throw new Error(`PermDock: duplicate resource name '${name}'`);
	const prefix = path.join(".");
	const instanceNames = actionNames(init.options.actions);
	const collectionNames = actionNames(init.options.collection);
	if (instanceNames.length === 0 && collectionNames.length === 0) throw new Error(`PermDock: resource '${name}' has no actions or collection`);
	const instanceSet = /* @__PURE__ */ new Set();
	const collectionSet = /* @__PURE__ */ new Set();
	const node = {};
	for (const action of instanceNames) {
		assertSafeKey(action, "action");
		if (instanceSet.has(action)) throw new Error(`PermDock: duplicate action '${action}' on '${name}'`);
		instanceSet.add(action);
		const leaf = makeLeaf(`${prefix}.${action}`, name, action, metaFor(init.options.actions, action), "instance");
		node[action] = leaf;
		leaves.push(leaf);
	}
	for (const action of collectionNames) {
		assertSafeKey(action, "action");
		if (instanceSet.has(action) || collectionSet.has(action)) throw new Error(`PermDock: duplicate action '${action}' on '${name}'`);
		collectionSet.add(action);
		const leaf = makeLeaf(`${prefix}.${action}`, name, action, metaFor(init.options.collection, action), "collection");
		node[action] = leaf;
		leaves.push(leaf);
	}
	const parent = init.options.parent;
	if (parent !== void 0) {
		assertSafeKey(parent.field, "parent field");
		assertSafeKey(parent.resource, "parent resource");
		if (parent.resource === name) throw new Error(`PermDock: resource '${name}' cannot parent itself`);
	}
	const resourceNode = Object.freeze({
		name,
		path: prefix,
		schema: init.schema,
		id: init.options.id ?? "id",
		parent: parent === void 0 ? void 0 : freezeDeep({ ...parent }),
		instanceActions: instanceSet,
		collectionActions: collectionSet
	});
	registry.set(name, resourceNode);
	return freezeDeep(node);
}
function walk(input, path, registry, leaves, depth) {
	if (depth > 10) throw new Error(`PermDock: permission group nesting exceeds 10`);
	if (isResourceInit(input)) return materialiseResource(input, path, registry, leaves, depth);
	if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error(`PermDock: definePermissions expected a group or resource at '${path.join(".")}'`);
	const group = {};
	for (const key of Object.keys(input)) {
		assertSafeKey(key, "group");
		group[key] = walk(input[key], [...path, key], registry, leaves, depth + 1);
	}
	return group;
}
function attachRegistry(tree, registry, leaves) {
	const attached = tree;
	Object.defineProperty(attached, TREE_REGISTRY, {
		value: registry,
		enumerable: false,
		writable: false,
		configurable: false
	});
	Object.defineProperty(attached, TREE_LEAVES, {
		value: Object.freeze([...leaves]),
		enumerable: false,
		writable: false,
		configurable: false
	});
	return attached;
}
function isRegistryTree(tree) {
	return TREE_REGISTRY in tree;
}
function getRegistry(tree) {
	if (!isRegistryTree(tree)) throw new Error("PermDock: permission tree is missing its registry");
	return tree[TREE_REGISTRY];
}
function getResource(tree, name) {
	if (isForbiddenKey(name)) return;
	return getRegistry(tree).get(name);
}
function definePermissions(input) {
	const registry = /* @__PURE__ */ new Map();
	const leaves = [];
	const tree = walk(input, [], registry, leaves, 0);
	const seen = /* @__PURE__ */ new Set();
	for (const leaf of leaves) {
		if (seen.has(leaf.key))
 /* v8 ignore next */
		throw new Error(`PermDock: duplicate permission key '${leaf.key}'`);
		seen.add(leaf.key);
	}
	return freezeDeep(attachRegistry(tree, registry, leaves));
}
function collectLeaves(node) {
	if ("key" in node && "scope" in node && "action" in node) return [node];
	const out = [];
	for (const key of ownKeys(node)) {
		const child = node[key];
		if (child !== void 0) out.push(...collectLeaves(child));
	}
	return out;
}
function listPermissions(tree) {
	if (isRegistryTree(tree)) return tree[TREE_LEAVES];
	return collectLeaves(tree);
}
function findPermission(tree, keyOrScope) {
	if (isForbiddenKey(keyOrScope)) return;
	for (const leaf of listPermissions(tree)) if (leaf.key === keyOrScope || leaf.scope === keyOrScope) return leaf;
}
function isPermission$1(value) {
	return value !== null && typeof value === "object" && "key" in value && "scope" in value && "resource" in value && "action" in value;
}
function mergeNodes(target, source, keys, registry, sourceRegistry) {
	for (const key of ownKeys(source)) {
		assertSafeKey(key, "group");
		const incoming = source[key];
		if (incoming === void 0)
 /* v8 ignore next */
		continue;
		const existing = target[key];
		if (existing === void 0) {
			target[key] = incoming;
			if (isPermission$1(incoming)) {
				if (keys.has(incoming.key))
 /* v8 ignore next */
				throw new Error(`PermDock: duplicate permission key '${incoming.key}'`);
				keys.add(incoming.key);
			}
			continue;
		}
		if (isPermission$1(existing) || isPermission$1(incoming)) {
			const keyName = isPermission$1(incoming) ? incoming.key : isPermission$1(existing) ? existing.key : key;
			throw new Error(`PermDock: duplicate permission key '${keyName}'`);
		}
		const nested = { ...existing };
		mergeNodes(nested, incoming, keys, registry, sourceRegistry);
		target[key] = freezeDeep(nested);
	}
	if (sourceRegistry !== void 0) for (const [name, node] of sourceRegistry) {
		if (registry.has(name) && registry.get(name) !== node) throw new Error(`PermDock: duplicate resource name '${name}'`);
		registry.set(name, node);
	}
}
function mergePermissions(...trees) {
	if (trees.length === 0) throw new Error("PermDock: mergePermissions() requires at least one tree");
	const merged = {};
	const keys = /* @__PURE__ */ new Set();
	const registry = /* @__PURE__ */ new Map();
	for (const tree of trees) mergeNodes(merged, tree, keys, registry, isRegistryTree(tree) ? tree[TREE_REGISTRY] : void 0);
	return freezeDeep(attachRegistry(merged, registry, collectLeaves(merged)));
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
//#region src/core/snapshot.ts
function snapshotGrant(grant, membership) {
	const scope = grant.scope === "global" ? void 0 : grant.scope === "tenant" || grant.scope === "team" ? grant.scope : { resource: grant.scope.resource };
	return freezeDeep(compact({
		permission: grant.permission.key,
		effect: grant.effect,
		role: grant.role,
		where: grant.portable ? grant.where : void 0,
		check: grant.portable ? grant.check : void 0,
		approval: grant.approval,
		scope,
		membership,
		portable: grant.portable ? void 0 : false
	}));
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
//#region src/core/subject.ts
function isPrincipal(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	if ("principal" in value && "context" in value) return false;
	const record = value;
	if (typeof record.id !== "string") return false;
	return Array.isArray(record.roles) || Array.isArray(record.memberships) || record.kind === "user" || record.kind === "service" || record.kind === "workload" || typeof record.issuer === "string";
}
function isSubject(value) {
	return value !== null && typeof value === "object" && "principal" in value && "context" in value && typeof value.context === "object";
}
function anonymousSubject(context = {}) {
	return Object.freeze({
		principal: null,
		context: Object.freeze({ ...context })
	});
}
//#endregion
//#region src/core/sha256.ts
const K = [
	1116352408,
	1899447441,
	3049323471,
	3921009573,
	961987163,
	1508970993,
	2453635748,
	2870763221,
	3624381080,
	310598401,
	607225278,
	1426881987,
	1925078388,
	2162078206,
	2614888103,
	3248222580,
	3835390401,
	4022224774,
	264347078,
	604807628,
	770255983,
	1249150122,
	1555081692,
	1996064986,
	2554220882,
	2821834349,
	2952996808,
	3210313671,
	3336571891,
	3584528711,
	113926993,
	338241895,
	666307205,
	773529912,
	1294757372,
	1396182291,
	1695183700,
	1986661051,
	2177026350,
	2456956037,
	2730485921,
	2820302411,
	3259730800,
	3345764771,
	3516065817,
	3600352804,
	4094571909,
	275423344,
	430227734,
	506948616,
	659060556,
	883997877,
	958139571,
	1322822218,
	1537002063,
	1747873779,
	1955562222,
	2024104815,
	2227730452,
	2361852424,
	2428436474,
	2756734187,
	3204031479,
	3329325298
];
function rotr(value, bits) {
	return value >>> bits | value << 32 - bits;
}
/**
* SHA-256 of UTF-8 text. Pure JS so `decide` stays synchronous and WinterTC-safe.
*/
function sha256(message) {
	const bytes = new TextEncoder().encode(message);
	const bitLength = bytes.length * 8;
	const paddedLength = bytes.length + 9 + 63 >> 6 << 6;
	const padded = new Uint8Array(paddedLength);
	padded.set(bytes);
	padded[bytes.length] = 128;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLength - 4, bitLength, false);
	let h0 = 1779033703;
	let h1 = 3144134277;
	let h2 = 1013904242;
	let h3 = 2773480762;
	let h4 = 1359893119;
	let h5 = 2600822924;
	let h6 = 528734635;
	let h7 = 1541459225;
	const w = /* @__PURE__ */ new Int32Array(64);
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let i = 0; i < 16; i += 1) w[i] = view.getInt32(offset + i * 4, false);
		for (let i = 16; i < 64; i += 1) {
			const w15 = w[i - 15];
			const w2 = w[i - 2];
			const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ w15 >>> 3;
			const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ w2 >>> 10;
			w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
		}
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		let f = h5;
		let g = h6;
		let h = h7;
		for (let i = 0; i < 64; i += 1) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = e & f ^ ~e & g;
			const temp1 = h + S1 + ch + K[i] + w[i] | 0;
			const temp2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) | 0;
			h = g;
			g = f;
			f = e;
			e = d + temp1 | 0;
			d = c;
			c = b;
			b = a;
			a = temp1 + temp2 | 0;
		}
		h0 = h0 + a | 0;
		h1 = h1 + b | 0;
		h2 = h2 + c | 0;
		h3 = h3 + d | 0;
		h4 = h4 + e | 0;
		h5 = h5 + f | 0;
		h6 = h6 + g | 0;
		h7 = h7 + h | 0;
	}
	const out = /* @__PURE__ */ new Uint8Array(32);
	const outView = new DataView(out.buffer);
	outView.setInt32(0, h0, false);
	outView.setInt32(4, h1, false);
	outView.setInt32(8, h2, false);
	outView.setInt32(12, h3, false);
	outView.setInt32(16, h4, false);
	outView.setInt32(20, h5, false);
	outView.setInt32(24, h6, false);
	outView.setInt32(28, h7, false);
	return out;
}
function bytesToBase64Url(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCodePoint(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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
	return `pd1.${bytesToBase64Url(sha256(JSON.stringify({
		key: input.key,
		resourceId: input.resourceId,
		principal: canonical(input.principal),
		actor: canonical(input.actor ?? null),
		fingerprint: input.fingerprint
	})))}`;
}
//#endregion
//#region src/core/validation.ts
function isThenable$1(value) {
	return value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
}
function validateBoundary(permission, resource, data, mode, trusted, boundary = "manual") {
	if (!(mode === "always" || mode === "boundary" && !trusted)) return data;
	if (resource?.schema === void 0) {
		if (mode === "always") throw new PermDockValidationError({
			code: "no-schema",
			permission: permission.key,
			resource: permission.resource,
			boundary,
			message: `${permission.key}: no schema for resource ${permission.resource}.`
		});
		return data;
	}
	const result = resource.schema["~standard"].validate(data);
	if (isThenable$1(result)) throw new PermDockValidationError({
		code: "async-schema",
		permission: permission.key,
		resource: permission.resource,
		boundary,
		message: `${permission.key}: schema for ${permission.resource} is async.`
	});
	if ("issues" in result && result.issues !== void 0) throw new PermDockValidationError({
		code: "invalid-data",
		permission: permission.key,
		resource: permission.resource,
		issues: result.issues,
		boundary,
		message: validationMessage(permission, resource, result.issues)
	});
	return result.value;
}
function validationMessage(permission, resource, issues) {
	const parts = issues.map((issue) => {
		const path = issue.path?.map((item) => typeof item === "object" && "key" in item ? String(item.key) : String(item)).join(".") ?? "/";
		return `invalid ${resource.name} data at ${path}: ${issue.message}`;
	});
	return `${permission.key}: ${parts.join("; ")}.`;
}
//#endregion
//#region src/core/permdock.ts
function isRowPair(value) {
	return value !== null && typeof value === "object" && "current" in value && "next" in value;
}
function isThenable(value) {
	return value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
}
function emitSafe(listeners, payload, errors) {
	for (const listener of listeners) try {
		listener(payload);
	} catch (error) {
		for (const handler of errors.error) try {
			handler(error);
		} catch {}
	}
}
function customRolesFor(source, tenants, auth) {
	if (source === void 0) return [];
	const loaded = [];
	for (const tenant of tenants) try {
		loaded.push(source.rolesFor(tenant));
	} catch {
		auth.push({
			reason: "source-threw",
			source: "customRoles"
		});
		loaded.push([]);
	}
	if (loaded.some((item) => isThenable(item))) return Promise.all(loaded.map((item) => Promise.resolve(item).catch(() => {
		auth.push({
			reason: "source-threw",
			source: "customRoles"
		});
		return [];
	}))).then((lists) => lists.flat());
	return loaded.flat();
}
function expandRoleNames(names, declared, custom) {
	const resolved = /* @__PURE__ */ new Set();
	const unknown = [];
	for (const name of names) {
		if (declared.has(name)) {
			resolved.add(name);
			continue;
		}
		const customRole = custom.find((item) => item.name === name);
		if (customRole === void 0) {
			unknown.push(name);
			continue;
		}
		for (const included of customRole.includes) if (declared.has(included)) resolved.add(included);
	}
	return {
		roles: [...resolved],
		unknown
	};
}
function alternativesFor(policy, permission, subject, env) {
	return listPermissions(policy.permissions).filter((leaf) => leaf.resource === permission.resource && leaf.key !== permission.key).filter((leaf) => {
		return evaluate(policy, subject, leaf, void 0, {
			trusted: true,
			source: "decide"
		}, {
			...env,
			emit: false,
			skipAlternatives: true
		}).outcome === "granted";
	});
}
function emptyListeners() {
	return {
		decision: /* @__PURE__ */ new Set(),
		denied: /* @__PURE__ */ new Set(),
		approval: /* @__PURE__ */ new Set(),
		auth: /* @__PURE__ */ new Set(),
		error: /* @__PURE__ */ new Set()
	};
}
function coveredByDelegation(permission, delegation) {
	if (delegation === void 0) return;
	const hasScopes = delegation.scopes !== void 0;
	const hasDetails = delegation.authorizationDetails !== void 0;
	if (!hasScopes && !hasDetails) return;
	if (hasScopes && (delegation.scopes?.length ?? 0) === 0 && !hasDetails) return "no-delegation";
	const scopeOk = delegation.scopes?.includes(permission.scope) ?? false;
	const detailOk = delegation.authorizationDetails?.some((detail) => {
		if (detail.type !== permission.resource) return false;
		if (detail.actions === void 0) return true;
		return detail.actions.includes(permission.action);
	}) ?? false;
	if (scopeOk || detailOk) return;
	return "not-delegated";
}
function evaluateGrantCondition(grant, permission, current, next, subject, now) {
	if (!grant.portable && grant.closure !== void 0) try {
		const result = grant.closure(next ?? current, {
			subject,
			actor: subject.actor,
			delegation: subject.delegation,
			context: subject.context
		});
		if (isThenable(result)) return {
			matched: false,
			reason: "closure-error",
			cause: result
		};
		return { matched: result === true };
	} catch (error) {
		return {
			matched: false,
			reason: "closure-error",
			cause: error
		};
	}
	if (grant.where !== void 0) {
		if (permission.kind === "collection") return {
			matched: false,
			reason: "condition"
		};
		if (current === void 0) return {
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
	const checkCondition = grant.check ?? (permission.action === "update" ? grant.where : void 0);
	if (checkCondition !== void 0) {
		if (checkCondition.op === "opaque") return {
			matched: false,
			reason: "opaque-condition"
		};
		if (next === void 0) return {
			matched: false,
			reason: "condition"
		};
		if (!evaluateCondition(checkCondition, next, subject, now)) return {
			matched: false,
			reason: "condition"
		};
	}
	return { matched: true };
}
function evaluate(policy, subject, permission, data, options, env) {
	const now = options.now ?? nowSeconds();
	const trusted = options.trusted ?? true;
	const resource = getResource(policy.permissions, permission.resource);
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
	try {
		if (permission.kind === "instance" || data !== void 0) {
			const validated = validateBoundary(permission, resource, permission.kind === "instance" && isRowPair(data) ? data.current : data, policy.validate, trusted, options.boundary ?? "manual");
			if (permission.kind === "instance" && isRowPair(data)) {
				current = validated;
				next = validateBoundary(permission, resource, data.next, policy.validate, trusted, options.boundary ?? "manual");
			} else if (permission.kind === "instance") {
				current = validated;
				next = validated;
			} else next = validated;
		}
	} catch (error) {
		if (error instanceof PermDockValidationError && error.code === "invalid-data") {
			const decision = freezeDeep({
				outcome: "denied",
				denials: [{
					role: null,
					reason: "validation",
					detail: error
				}],
				alternatives: []
			});
			finish(policy, subject, permission, current, decision, options, env, trusted);
			return decision;
		}
		throw error;
	}
	if (subject.principal === null) {
		const decision = freezeDeep({
			outcome: "denied",
			denials: [{
				role: null,
				reason: "anonymous"
			}],
			alternatives: []
		});
		finish(policy, subject, permission, current, decision, options, env, trusted);
		return decision;
	}
	const declared = new Set(policy.roles.map((role) => role.name));
	const globalNames = expandRoleNames(subject.principal.roles ?? [], declared, env.customRoles);
	if (globalNames.unknown.length > 0) emitSafe(env.listeners.auth, {
		reason: "unknown-role",
		source: "roles"
	}, env.listeners);
	const denials = [];
	const allows = [];
	const matchingRoles = new Set(globalNames.roles);
	for (const membership of subject.principal.memberships ?? []) {
		if (env.team !== void 0 && membership.team !== env.team) continue;
		const expanded = expandRoleNames(membership.roles, declared, env.customRoles);
		for (const name of expanded.roles) matchingRoles.add(name);
		for (const name of expanded.unknown) denials.push({
			role: name,
			reason: "unknown-role"
		});
	}
	for (const role of policy.roles) {
		if (!matchingRoles.has(role.name) && role.grants[0]?.scope === "global") continue;
		for (const grant of role.grants) {
			if (grant.permission.key !== permission.key) continue;
			const scope = grant.scope;
			if (scope !== "global" && !matchingRoles.has(role.name)) continue;
			if (scope === "global" && !globalNames.roles.includes(role.name)) continue;
			const rowForScope = permission.kind === "instance" ? current : void 0;
			const scopeMatch = matchScopedMembership(subject, scope, role.name, rowForScope, policy.scopes, resource, now);
			if (!scopeMatch.ok) {
				denials.push({
					role: role.name,
					reason: scopeMatch.reason
				});
				continue;
			}
			const condition = evaluateGrantCondition(grant, permission, current, next, subject, now);
			if (!condition.matched) {
				if (condition.reason === "closure-error") emitSafe(env.listeners.error, condition.cause ?? /* @__PURE__ */ new Error("closure-error"), env.listeners);
				denials.push({
					role: role.name,
					reason: condition.reason ?? "condition",
					detail: condition.cause
				});
				continue;
			}
			if (grant.effect === "deny") {
				const decision = freezeDeep({
					outcome: "denied",
					denials: [{
						role: role.name,
						reason: "deny"
					}],
					alternatives: env.skipAlternatives ? [] : alternativesFor(policy, permission, subject, env)
				});
				finish(policy, subject, permission, current, decision, options, env, trusted);
				return decision;
			}
			allows.push(scopeMatch.membership === void 0 ? { grant } : {
				grant,
				membership: scopeMatch.membership
			});
		}
	}
	if (allows.length === 0) {
		const reason = denials[0]?.reason ?? (globalNames.unknown.length > 0 && globalNames.roles.length === 0 ? "unknown-role" : "no-grant");
		const decision = freezeDeep({
			outcome: "denied",
			denials: denials.length > 0 ? denials : [{
				role: null,
				reason
			}],
			alternatives: env.skipAlternatives ? [] : alternativesFor(policy, permission, subject, env)
		});
		finish(policy, subject, permission, current, decision, options, env, trusted);
		return decision;
	}
	const matchedAllow = allows[0];
	const delegationMiss = coveredByDelegation(permission, subject.delegation);
	if (delegationMiss !== void 0) {
		const decision = freezeDeep({
			outcome: "denied",
			denials: [{
				role: null,
				reason: delegationMiss
			}],
			alternatives: env.skipAlternatives ? [] : alternativesFor(policy, permission, subject, env)
		});
		finish(policy, subject, permission, current, decision, options, env, trusted);
		return decision;
	}
	const resourceId = permission.kind === "collection" ? "*" : current !== null && typeof current === "object" ? String(current[resource?.id ?? "id"] ?? "*") : "*";
	const token = env.simulated ? "pd1.simulated" : decisionToken({
		key: permission.key,
		resourceId,
		principal: subject.principal,
		actor: subject.actor,
		fingerprint: policy.fingerprint
	});
	const matched = compact({
		role: matchedAllow.grant.role,
		permission: permission.key,
		where: matchedAllow.grant.where,
		check: matchedAllow.grant.check,
		approval: matchedAllow.grant.approval
	});
	const decision = matchedAllow.grant.approval === "human" ? freezeDeep({
		outcome: "approval-required",
		grant: matched,
		reason: "human",
		token
	}) : freezeDeep({
		outcome: "granted",
		subject,
		matched,
		token
	});
	finish(policy, subject, permission, current, decision, options, env, trusted, matchedAllow.membership);
	return decision;
}
function finish(policy, subject, permission, data, decision, options, env, trusted, membership, counts) {
	if (!env.emit) return;
	const resource = getResource(policy.permissions, permission.resource);
	const resourceId = data !== null && typeof data === "object" ? data[resource?.id ?? "id"] : void 0;
	const event = freezeDeep(compact({
		type: "decision",
		at: (/* @__PURE__ */ new Date()).toISOString(),
		outcome: decision.outcome,
		permission: permission.key,
		scope: permission.scope,
		resource: compact({
			type: permission.resource,
			id: resourceId === void 0 ? void 0 : String(resourceId)
		}),
		subject: compact({
			principal: subject.principal === null ? null : compact({
				id: subject.principal.id,
				roles: subject.principal.roles ?? [],
				tenant: subject.principal.tenant
			}),
			actor: subject.actor === void 0 ? void 0 : {
				id: subject.actor.id,
				kind: subject.actor.kind
			},
			delegation: subject.delegation === void 0 ? void 0 : compact({
				scopes: subject.delegation.scopes,
				authorizationDetails: subject.delegation.authorizationDetails
			})
		}),
		tenant: subject.principal?.tenant,
		membership,
		via: membership?.via ?? null,
		matched: decision.outcome === "granted" ? {
			role: decision.matched.role,
			permission: decision.matched.permission
		} : void 0,
		denials: decision.outcome === "denied" ? decision.denials : void 0,
		alternatives: decision.outcome === "denied" ? decision.alternatives.map((leaf) => leaf.key) : void 0,
		token: decision.outcome === "granted" || decision.outcome === "approval-required" ? decision.token : void 0,
		trusted,
		source: options.source ?? "decide",
		adapter: options.adapter,
		counts
	}));
	emitSafe(env.listeners.decision, event, env.listeners);
	if (decision.outcome === "denied") emitSafe(env.listeners.denied, event, env.listeners);
	if (decision.outcome === "approval-required") emitSafe(env.listeners.approval, event, env.listeners);
	if (env.sink !== void 0) try {
		const written = env.sink.write([event]);
		if (isThenable(written)) written.catch((error) => {
			emitSafe(env.listeners.error, error, env.listeners);
		});
	} catch (error) {
		emitSafe(env.listeners.error, error, env.listeners);
	}
}
function includePrefixes(include) {
	if (include === void 0) return;
	return include.map((item) => {
		if ("key" in item && typeof item.key === "string") return item.key;
		const first = listPermissions(item)[0];
		if (first === void 0) return "";
		const parts = first.key.split(".");
		parts.pop();
		return parts.join(".");
	});
}
function heldRoles(subject, tenant) {
	if (subject.principal === null) return [];
	const names = new Set(subject.principal.roles ?? []);
	for (const membership of subject.principal.memberships ?? []) {
		if (tenant !== void 0 && membership.tenant !== tenant) continue;
		for (const role of membership.roles) names.add(role);
	}
	return [...names];
}
function collectSnapshotGrants(policy, subject, customRoles) {
	const declared = new Set(policy.roles.map((role) => role.name));
	const global = expandRoleNames(subject.principal?.roles ?? [], declared, customRoles);
	const out = [];
	for (const role of policy.roles) if (role.grants[0]?.scope === "global" && global.roles.includes(role.name)) for (const grant of role.grants) out.push({ grant });
	for (const membership of subject.principal?.memberships ?? []) {
		const expanded = expandRoleNames(membership.roles, declared, customRoles);
		for (const roleName of expanded.roles) {
			const role = policy.rolesByName.get(roleName);
			if (role === void 0) continue;
			for (const grant of role.grants) {
				if (grant.scope === "global") continue;
				out.push({
					grant,
					membership
				});
			}
		}
	}
	return out;
}
function buildInstance(policy, subject, envBase, team) {
	const listeners = emptyListeners();
	const queuedAuth = [...envBase.queuedAuth];
	const envFor = (emit) => ({
		emit,
		simulated: envBase.simulated,
		skipAlternatives: false,
		customRoles: envBase.customRoles,
		listeners,
		sink: envBase.sink,
		team
	});
	const decideImpl = (permission, data, options) => evaluate(policy, subject, permission, data, options ?? {}, envFor(options?.source !== "simulate"));
	const canImpl = (permission, data, options) => {
		try {
			return decideImpl(permission, data, {
				...options,
				source: options?.source ?? "can"
			}).outcome === "granted";
		} catch {
			return false;
		}
	};
	const assertImpl = (permission, data, options) => {
		const decision = decideImpl(permission, data, {
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
	return Object.freeze({
		can: canImpl,
		decide: decideImpl,
		assert: assertImpl,
		filter(permission, rows, options) {
			const allowed = [];
			let granted = 0;
			let denied = 0;
			let approvalRequired = 0;
			const quiet = envFor(false);
			const trusted = options?.trusted ?? true;
			const decideOptions = {
				...options,
				source: "filter",
				trusted
			};
			for (const row of rows) {
				const decision = evaluate(policy, subject, permission, row, decideOptions, quiet);
				if (decision.outcome === "granted") {
					allowed.push(row);
					granted += 1;
				} else if (decision.outcome === "approval-required") approvalRequired += 1;
				else denied += 1;
			}
			const summary = granted > 0 ? freezeDeep({
				outcome: "granted",
				subject,
				matched: {
					role: "*",
					permission: permission.key
				},
				token: "pd1.filter"
			}) : freezeDeep({
				outcome: "denied",
				denials: [{
					role: null,
					reason: "no-grant"
				}],
				alternatives: []
			});
			finish(policy, subject, permission, rows[0], summary, decideOptions, {
				...quiet,
				emit: true
			}, trusted, void 0, {
				granted,
				denied,
				approvalRequired
			});
			return allowed;
		},
		where(permission) {
			const grants = collectSnapshotGrants(policy, subject, envBase.customRoles).filter((item) => item.grant.permission.key === permission.key);
			const allows = grants.filter((item) => item.grant.effect === "allow" && item.grant.portable);
			const denies = grants.filter((item) => item.grant.effect === "deny" && item.grant.portable);
			const partial = grants.some((item) => !item.grant.portable);
			if (allows.length === 0) return {
				condition: {
					op: "or",
					conditions: []
				},
				partial
			};
			const parts = allows.map((item) => {
				let condition = item.grant.where ?? {
					op: "eq",
					field: "_",
					value: true
				};
				for (const denyGrant of denies) if (denyGrant.grant.where !== void 0) condition = {
					op: "and",
					conditions: [condition, {
						op: "not",
						condition: denyGrant.grant.where
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
		},
		simulate: ((input) => {
			if (Array.isArray(input)) return input.map(([permission, data]) => evaluate(policy, subject, permission, data, {
				source: "simulate",
				trusted: true
			}, envFor(false)));
			const preview = input;
			const previewPrincipal = subject.principal === null ? null : freezeDeep(compact({
				...subject.principal,
				roles: preview.roles ?? subject.principal.roles,
				memberships: preview.memberships ?? subject.principal.memberships,
				tenant: preview.tenant ?? subject.principal.tenant
			}));
			return buildInstance(policy, freezeDeep({
				...subject,
				principal: previewPrincipal
			}), {
				...envBase,
				simulated: true
			}, team);
		}),
		snapshot(options) {
			const snapshot = buildSnapshot(compact({
				subject,
				roles: heldRoles(subject, subject.principal?.tenant),
				grants: collectSnapshotGrants(policy, subject, envBase.customRoles),
				include: includePrefixes(options?.include),
				tenants: options?.tenants,
				simulated: envBase.simulated
			}));
			if (options?.signer !== void 0) return signSnapshot(snapshot, options.signer, options.audience);
			return snapshot;
		},
		on(event, handler) {
			const set = listeners[event];
			set.add(handler);
			if (event === "auth") for (const queued of queuedAuth) try {
				handler(queued);
			} catch (error) {
				emitSafe(listeners.error, error, listeners);
			}
			return () => {
				set.delete(handler);
			};
		},
		tenant(id) {
			if (subject.principal === null) return buildInstance(policy, subject, envBase, team);
			return buildInstance(policy, freezeDeep(compact({
				...subject,
				principal: compact({
					...subject.principal,
					tenant: resolveActiveTenant(subject.principal, id)
				})
			})), envBase, team);
		},
		team(id) {
			return buildInstance(policy, subject, envBase, id);
		},
		memberships() {
			return subject.principal?.memberships ?? [];
		},
		tenants() {
			return tenantsOf(subject.principal);
		},
		roles(options) {
			return heldRoles(subject, options?.tenant ?? subject.principal?.tenant);
		},
		assignable() {
			const tenant = subject.principal?.tenant;
			const held = new Set(heldRoles(subject, tenant));
			return policy.roles.filter((role) => role.assignable).map((role) => role.name).filter((name) => held.has(name));
		},
		subject
	});
}
function assemblePrincipal(policy, user, options, auth) {
	let principal;
	let context = {};
	let actor = options.actor;
	let delegation = options.delegation;
	let session = options.session;
	let expiresAt = options.expiresAt;
	try {
		if (user === null || user === void 0) principal = policy.subject(user);
		else if (isSubject(user)) {
			principal = user.principal;
			context = user.context;
			actor = user.actor ?? actor;
			delegation = user.delegation ?? delegation;
			session = user.session ?? session;
			expiresAt = user.expiresAt ?? expiresAt;
		} else if (isPrincipal(user)) principal = user;
		else principal = policy.subject(user);
	} catch {
		principal = null;
	}
	const contextResult = policy.context === void 0 ? context : policy.context(user);
	let memberships = principal?.memberships ?? [];
	if (principal !== null && options.memberships !== void 0) try {
		memberships = options.memberships.membershipsFor(compact({
			id: principal.id,
			kind: principal.kind
		}), compact({ tenant: options.tenant }));
	} catch {
		auth.push({
			reason: "source-threw",
			source: "memberships"
		});
		memberships = [];
	}
	return {
		principal,
		context: contextResult,
		actor,
		delegation,
		session,
		expiresAt,
		memberships
	};
}
function finishSubject(assembled, context, memberships, options) {
	if (assembled.principal === null) return freezeDeep(compact({
		...anonymousSubject(context),
		actor: assembled.actor,
		delegation: assembled.delegation,
		session: assembled.session,
		expiresAt: assembled.expiresAt
	}));
	return freezeDeep(compact({
		principal: freezeDeep(compact({
			...assembled.principal,
			memberships,
			tenant: resolveActiveTenant({
				...assembled.principal,
				memberships
			}, options.tenant ?? assembled.principal.tenant)
		})),
		actor: assembled.actor,
		delegation: assembled.delegation,
		context: freezeDeep({ ...context }),
		session: assembled.session,
		expiresAt: assembled.expiresAt
	}));
}
function resolveSubject(policy, user, options, auth) {
	const assembled = assemblePrincipal(policy, user, options, auth);
	if (isThenable(assembled.context) || isThenable(assembled.memberships)) return Promise.all([Promise.resolve(assembled.context), Promise.resolve(assembled.memberships).catch(() => {
		auth.push({
			reason: "source-threw",
			source: "memberships"
		});
		return [];
	})]).then(([context, memberships]) => finishSubject(assembled, context, memberships, options));
	return finishSubject(assembled, assembled.context, assembled.memberships, options);
}
function instantiate(policy, subject, options, auth) {
	const tenants = tenantsOf(subject.principal);
	const customRoles = customRolesFor(options.customRoles, tenants, auth);
	const build = (roles) => buildInstance(policy, subject, {
		customRoles: roles,
		sink: options.sink,
		simulated: false,
		roleSource: options.customRoles,
		queuedAuth: auth
	});
	if (isThenable(customRoles)) return customRoles.then(build);
	return build(customRoles);
}
function createPermDock(policy, user, options = {}) {
	const auth = [];
	const subject = resolveSubject(policy, user, options, auth);
	if (isThenable(subject)) return subject.then((resolved) => instantiate(policy, resolved, options, auth));
	return instantiate(policy, subject, options, auth);
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
		limit: condition?.limit
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
	return freezeDeep(compact({
		name,
		grants: flattenGrants(grants).map((grant) => freezeDeep({
			...grant,
			role: name,
			scope
		})),
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
		resources
	});
}
//#endregion
//#region src/core/sink.ts
function memorySink(options = {}) {
	const capacity = options.capacity ?? 1e4;
	const buffer = [];
	return {
		write(events) {
			buffer.push(...events);
			if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
		},
		events() {
			return [...buffer];
		}
	};
}
//#endregion
export { PermDockApprovalRequiredError, PermDockDeniedError, PermDockValidationError, allow, createPermDock, definePermissions, definePolicy, deny, describe, findPermission, getResource, listPermissions, memoryRoleSource, memorySink, mergePermissions, opaque, parseSnapshot, resource, role, subject };
