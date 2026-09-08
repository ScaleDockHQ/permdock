import { i as ownKeys, n as isForbiddenKey, t as assertSafeKey } from "./paths-AH4M6YYV.js";
import { t as freezeDeep } from "./freeze-BF4IK5al.js";
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
export { isRegistryTree as a, resource as c, getResource as i, findPermission as n, listPermissions as o, getRegistry as r, mergePermissions as s, definePermissions as t };
