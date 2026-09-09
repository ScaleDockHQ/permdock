import { n as isConditionDate, r as isConditionRef } from "./ast-BMo2MvmN.js";
import { a as readPath, i as ownKeys, n as isForbiddenKey, r as ownGet } from "./paths-AH4M6YYV.js";
import { t as freezeDeep } from "./freeze-BF4IK5al.js";
import { n as sha256, t as bytesToBase64Url } from "./sha256-CeSpVRME.js";
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
//#region src/core/fields.ts
function sanitizeFields(fields) {
	if (fields === void 0) return;
	return fields.filter((field) => field.length > 0 && !isForbiddenKey(field));
}
function grantCoversField(fields, field, effect) {
	if (fields === void 0) return true;
	if (fields.length === 0) return false;
	if (field === void 0) return effect === "allow";
	return fields.includes(field);
}
function pickVisible(row, canField) {
	const out = {};
	for (const key of ownKeys(row)) if (canField(key)) out[key] = ownGet(row, key);
	return freezeDeep(out);
}
function sanitizeContext(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	for (const key of ownKeys(value)) out[key] = ownGet(value, key);
	return out;
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
export { sanitizeFields as a, sanitizeContext as i, grantCoversField as n, evaluateCondition as o, pickVisible as r, decisionToken as t };
