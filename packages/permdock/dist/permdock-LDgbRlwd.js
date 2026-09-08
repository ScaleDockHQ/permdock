import { c as nowSeconds, d as PermDockApprovalRequiredError, f as PermDockDeniedError, g as evaluateCondition, h as deniedMessage, l as resolveActiveTenant, m as approvalMessage, o as decisionToken, p as PermDockValidationError, r as signSnapshot, s as matchScopedMembership, t as buildSnapshot, u as tenantsOf } from "./snapshot-DjelOg1B.js";
import { i as isForbiddenKey, o as ownKeys, r as assertSafeKey } from "./sha256-bH0-k349.js";
import { n as freezeDeep, t as compact } from "./compact-CxCColYy.js";
import { n as isPrincipal, r as isSubject, t as anonymousSubject } from "./subject-Dz8DcVLC.js";
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
function isPermission(value) {
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
			if (isPermission(incoming)) {
				if (keys.has(incoming.key))
 /* v8 ignore next */
				throw new Error(`PermDock: duplicate permission key '${incoming.key}'`);
				keys.add(incoming.key);
			}
			continue;
		}
		if (isPermission(existing) || isPermission(incoming)) {
			const keyName = isPermission(incoming) ? incoming.key : isPermission(existing) ? existing.key : key;
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
	const leaves = collectLeaves(merged);
	return freezeDeep(attachRegistry(merged, registry, leaves));
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
	const withMemberships = freezeDeep(compact({
		...assembled.principal,
		memberships,
		tenant: resolveActiveTenant({
			...assembled.principal,
			memberships
		}, options.tenant ?? assembled.principal.tenant)
	}));
	return freezeDeep(compact({
		principal: withMemberships,
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
export { getResource as a, resource as c, getRegistry as i, definePermissions as n, listPermissions as o, findPermission as r, mergePermissions as s, createPermDock as t };
