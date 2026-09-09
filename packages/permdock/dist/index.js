import { t as freezeDeep } from "./freeze-BF4IK5al.js";
import { a as subject, i as role, n as definePolicy, o as opaque, r as deny, t as allow } from "./policy-BPjhRGPn.js";
import { t as describe } from "./describe-BnKr1Gwo.js";
import { t as compact } from "./compact-CxSqQNw0.js";
import { n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "./errors-DDT8tC4N.js";
import { n as memoryLimitStore, t as createPermDock } from "./permdock-BPNx0tvD.js";
import { n as parseSnapshot } from "./snapshot-BiwEN_W3.js";
import { n as fromSnapshot, t as emptySnapshot } from "./from-snapshot-CCji1zvS.js";
import { c as resource, i as getResource, n as findPermission, o as listPermissions, s as mergePermissions, t as definePermissions } from "./permissions-WEkUHQtZ.js";
import { n as signDecisionBatch, r as toCloudEvent, t as memorySink } from "./sink-CSxZb96b.js";
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
//#region src/core/presets.ts
const CRUD_ACTIONS = {
	read: { readOnly: true },
	update: {},
	delete: { tags: ["destructive"] }
};
const CRUD_COLLECTION = {
	create: {},
	list: { readOnly: true }
};
const READABLE_ACTIONS = { read: { readOnly: true } };
const READABLE_COLLECTION = { list: { readOnly: true } };
const WRITABLE_ACTIONS = {
	read: { readOnly: true },
	update: {}
};
const WRITABLE_COLLECTION = {};
function isNameList(list) {
	return Array.isArray(list);
}
function toRecord(list) {
	if (list === void 0) return {};
	if (isNameList(list)) {
		const out = {};
		for (const name of list) out[name] = {};
		return out;
	}
	return { ...list };
}
function mergeMeta(base, extra) {
	return compact({
		title: extra.title ?? base.title,
		description: extra.description ?? base.description,
		tags: extra.tags ?? base.tags,
		readOnly: extra.readOnly ?? base.readOnly
	});
}
function mergeActionLists(base, extra) {
	const extraRecord = toRecord(extra);
	const out = {};
	for (const [name, baseMeta] of Object.entries(base)) {
		const extraMeta = extraRecord[name];
		out[name] = extraMeta === void 0 ? baseMeta : mergeMeta(baseMeta, extraMeta);
	}
	for (const [name, extraMeta] of Object.entries(extraRecord)) {
		if (Object.hasOwn(out, name)) continue;
		out[name] = extraMeta;
	}
	return freezeDeep(out);
}
function finishPreset(baseActions, baseCollection, options) {
	const actions = mergeActionLists(baseActions, options?.actions);
	const collection = mergeActionLists(baseCollection, options?.collection);
	return compact({
		id: options?.id,
		parent: options?.parent,
		actions,
		collection: Object.keys(collection).length === 0 ? void 0 : collection
	});
}
function crud(options) {
	return finishPreset(CRUD_ACTIONS, CRUD_COLLECTION, options);
}
function readable(options) {
	return finishPreset(READABLE_ACTIONS, READABLE_COLLECTION, options);
}
function writable(options) {
	return finishPreset(WRITABLE_ACTIONS, WRITABLE_COLLECTION, options);
}
//#endregion
export { PermDockApprovalRequiredError, PermDockDeniedError, PermDockValidationError, allow, createPermDock, crud, definePermissions, definePolicy, deny, describe, emptySnapshot, findPermission, fromSnapshot, getResource, listPermissions, memoryLimitStore, memoryRoleSource, memorySink, mergePermissions, opaque, parseSnapshot, readable, resource, role, signDecisionBatch, subject, toCloudEvent, writable };
