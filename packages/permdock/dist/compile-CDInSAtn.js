import { n as isConditionDate, r as isConditionRef } from "./ast-BMo2MvmN.js";
import { t as assertSafeKey } from "./paths-AH4M6YYV.js";
import { t as compact } from "./compact-CxSqQNw0.js";
import { r as PermDockValidationError } from "./errors-DDT8tC4N.js";
//#region src/conditions/compile.ts
function isExpired(membership, now) {
	return membership.expiresAt !== void 0 && membership.expiresAt <= now;
}
function resolveRef(ref, subject) {
	if (subject === void 0 || !ref.startsWith("subject")) return;
	const rest = ref.slice(7);
	if (rest === "") return subject;
	if (!rest.startsWith(".")) return;
	const path = rest.slice(1);
	if (path === "id") return subject.principal?.id;
	if (path.startsWith("context.")) {
		const key = path.slice(8);
		assertSafeKey(key.split(".")[0] ?? key, "subject path");
		let current = subject.context;
		for (const segment of key.split(".")) {
			if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) return;
			current = current[segment];
		}
		return current;
	}
	if (subject.principal === null) return;
	let current = subject.principal;
	for (const segment of path.split(".")) {
		assertSafeKey(segment, "subject path");
		if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) return;
		current = current[segment];
	}
	return current;
}
function unwrap(value, subject) {
	if (isConditionRef(value)) return resolveRef(value.ref, subject);
	if (isConditionDate(value)) return value.date;
	if (Array.isArray(value)) return value.map((item) => unwrap(item, subject));
	return value;
}
function nonPortable(detail) {
	return new PermDockValidationError({
		code: "non-portable-condition",
		permission: "",
		resource: "",
		boundary: "where",
		message: `PermDock: non-portable-condition: ${detail}`
	});
}
function asPortableCondition(input) {
	if ("partial" in input && input.partial) throw nonPortable("closure grant");
	if ("condition" in input && !("op" in input)) return input.condition;
	return input;
}
function matchingMemberships(condition, subject, now) {
	const memberships = subject?.principal?.memberships ?? [];
	const wanted = new Set(condition.roles);
	return memberships.filter((membership) => {
		if (isExpired(membership, now)) return false;
		return membership.roles.some((role) => wanted.has(role));
	});
}
function inList(field, values) {
	const unique = [...new Set(values.filter((value) => value !== null && value !== void 0))];
	if (unique.length === 0) return { kind: "never" };
	if (unique.length === 1) return {
		kind: "compare",
		op: "eq",
		field,
		value: unique[0]
	};
	return {
		kind: "compare",
		op: "in",
		field,
		value: unique
	};
}
function compileExists(condition, table, subject) {
	const userValue = subject?.principal?.id;
	if (typeof userValue !== "string" || userValue === "") return { kind: "never" };
	const rowColumn = condition.scope === "tenant" ? table.tenant : condition.scope === "team" ? table.team : table.id;
	if (rowColumn === void 0) return { kind: "never" };
	assertSafeKey(table.table, "membership table");
	assertSafeKey(rowColumn, "membership column");
	return compact({
		kind: "exists",
		table: table.table,
		user: table.user,
		userValue,
		role: table.role,
		roles: condition.roles,
		rowColumn,
		rowField: condition.field,
		expiresAt: table.expiresAt,
		tenantColumn: condition.scope === "team" ? table.tenant : void 0,
		tenantValue: condition.scope === "team" ? subject?.principal?.tenant : void 0
	});
}
function compileMemberOf(condition, options) {
	assertSafeKey(condition.field, "condition field");
	const mapping = condition.scope === "resource" ? condition.resource === void 0 ? void 0 : options.memberships?.resource?.[condition.resource] : options.memberships?.[condition.scope];
	if (mapping !== void 0) return compileExists(condition, mapping, options.subject);
	const now = options.now ?? Date.now() / 1e3;
	const matched = matchingMemberships(condition, options.subject, now);
	if (condition.scope === "tenant") {
		const active = options.subject?.principal?.tenant;
		if (active !== void 0 && active !== "") return matched.some((membership) => membership.tenant === active) ? {
			kind: "compare",
			op: "eq",
			field: condition.field,
			value: active
		} : { kind: "never" };
		return inList(condition.field, matched.flatMap((membership) => membership.tenant === void 0 ? [] : [membership.tenant]));
	}
	if (condition.scope === "team") {
		const active = options.subject?.principal?.tenant;
		const teams = matched.flatMap((membership) => {
			if (membership.team === void 0) return [];
			if (active !== void 0 && membership.tenant !== void 0 && membership.tenant !== active) return [];
			return [membership.team];
		});
		return inList(condition.field, teams);
	}
	const onField = [];
	const ids = matched.flatMap((membership) => {
		if (membership.on === void 0) return [];
		if (condition.resource !== void 0 && membership.on.resource !== condition.resource) return [];
		return [membership.on.id];
	});
	const fieldPred = inList(condition.field, ids);
	if (fieldPred.kind !== "never") onField.push(fieldPred);
	const parentIds = matched.flatMap((membership) => membership.on === void 0 ? [] : [membership.on.id]);
	for (const parent of condition.parents ?? []) {
		assertSafeKey(parent, "condition field");
		const parentPred = inList(parent, parentIds);
		if (parentPred.kind !== "never") onField.push(parentPred);
	}
	if (onField.length === 0) return { kind: "never" };
	return onField.length === 1 ? onField[0] : {
		kind: "or",
		items: onField
	};
}
function compileNode(condition, options) {
	switch (condition.op) {
		case "and": {
			const items = condition.conditions.map((child) => compileNode(child, options));
			if (items.some((item) => item.kind === "never")) return { kind: "never" };
			const kept = items.filter((item) => item.kind !== "always");
			if (kept.length === 0) return { kind: "always" };
			return kept.length === 1 ? kept[0] : {
				kind: "and",
				items: kept
			};
		}
		case "or": {
			if (condition.conditions.length === 0) return { kind: "never" };
			const items = condition.conditions.map((child) => compileNode(child, options));
			if (items.some((item) => item.kind === "always")) return { kind: "always" };
			const kept = items.filter((item) => item.kind !== "never");
			if (kept.length === 0) return { kind: "never" };
			return kept.length === 1 ? kept[0] : {
				kind: "or",
				items: kept
			};
		}
		case "not": {
			const item = compileNode(condition.condition, options);
			if (item.kind === "never") return { kind: "always" };
			if (item.kind === "always") return { kind: "never" };
			return {
				kind: "not",
				item
			};
		}
		case "isNull":
			assertSafeKey(condition.field, "condition field");
			return {
				kind: "isNull",
				field: condition.field,
				negated: !condition.value
			};
		case "opaque": throw nonPortable("opaque SQL");
		case "memberOf": return compileMemberOf(condition, options);
		case "eq":
		case "ne":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
		case "contains":
		case "in":
		case "notIn": {
			if (condition.field === "_" && condition.op === "eq") return condition.value === true ? { kind: "always" } : { kind: "never" };
			assertSafeKey(condition.field, "condition field");
			const value = unwrap("value" in condition ? condition.value : true, options.subject);
			if (condition.op === "in" || condition.op === "notIn") {
				const list = Array.isArray(value) ? value : [];
				if (list.length === 0) return condition.op === "in" ? { kind: "never" } : { kind: "always" };
				return {
					kind: "compare",
					op: condition.op,
					field: condition.field,
					value: list
				};
			}
			return {
				kind: "compare",
				op: condition.op,
				field: condition.field,
				value
			};
		}
		default: throw nonPortable("unknown condition");
	}
}
function compileWhere(input, options = {}) {
	return compileNode(asPortableCondition(input), options);
}
//#endregion
export { compileWhere as t };
