import { t as assertSafeKey } from "../paths-AH4M6YYV.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { t as compileWhere } from "../compile-CDInSAtn.js";
import { createRequire } from "node:module";
//#region src/drizzle/to-where.ts
function loadOperators(injected) {
	if (injected !== void 0) return injected;
	try {
		return createRequire(import.meta.url)("drizzle-orm");
	} catch {
		throw new Error("PermDock: permdock/drizzle requires the drizzle-orm peer");
	}
}
function ident(name) {
	assertSafeKey(name, "sql identifier");
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error(`PermDock: unsafe SQL identifier '${name}'`);
	return name;
}
function column(table, field, columns) {
	assertSafeKey(field, "condition field");
	const mapped = columns?.[field] ?? table[field];
	if (mapped === void 0) throw new Error(`PermDock: unknown column '${field}'`);
	return mapped;
}
function tagged(strings, values, ops) {
	const template = strings;
	Object.defineProperty(template, "raw", { value: strings });
	return ops.sql(template, ...values);
}
function existsSql(node, table, options, ops) {
	const row = column(table, node.rowField, options.columns);
	const expiry = node.expiresAt === void 0 ? "" : ` and (m.${ident(node.expiresAt)} is null or m.${ident(node.expiresAt)} > now())`;
	const tenant = node.tenantColumn === void 0 || node.tenantValue === void 0 ? "" : ` and m.${ident(node.tenantColumn)} = `;
	const head = `exists (select 1 from ${ident(node.table)} m where m.${ident(node.rowColumn)} = `;
	const mid = ` and m.${ident(node.user)} = `;
	const roles = ` and m.${ident(node.role)} in (`;
	if (tenant === "") return tagged([
		head,
		mid,
		roles,
		`)${expiry}`
	], [
		row,
		node.userValue,
		node.roles
	], ops);
	return tagged([
		head,
		mid,
		roles,
		`)${expiry}${tenant}`,
		""
	], [
		row,
		node.userValue,
		node.roles,
		node.tenantValue
	], ops);
}
function render(node, table, options, ops) {
	switch (node.kind) {
		case "never": return ops.sql`false`;
		case "always": return ops.sql`true`;
		case "isNull": {
			const col = column(table, node.field, options.columns);
			return node.negated ? ops.isNotNull(col) : ops.isNull(col);
		}
		case "and": return ops.and(...node.items.map((item) => render(item, table, options, ops)));
		case "or": return ops.or(...node.items.map((item) => render(item, table, options, ops)));
		case "not": return ops.not(render(node.item, table, options, ops));
		case "exists": return existsSql(node, table, options, ops);
		case "compare": {
			const col = column(table, node.field, options.columns);
			switch (node.op) {
				case "eq": return ops.eq(col, node.value);
				case "ne": return ops.ne(col, node.value);
				case "gt": return ops.gt(col, node.value);
				case "gte": return ops.gte(col, node.value);
				case "lt": return ops.lt(col, node.value);
				case "lte": return ops.lte(col, node.value);
				case "in": return ops.inArray(col, node.value);
				case "notIn": return ops.notInArray(col, node.value);
				case "contains": return typeof node.value === "string" ? ops.like(col, `%${node.value}%`) : tagged([
					"",
					" @> ",
					""
				], [col, node.value], ops);
				default: {
					const exhaustive = node.op;
					throw new Error(`PermDock: unknown compare '${String(exhaustive)}'`);
				}
			}
		}
		default: throw new Error(`PermDock: unknown compiled node '${String(node)}'`);
	}
}
function toWhere(input, table, options = {}) {
	return render(compileWhere(input, compact({
		subject: options.subject,
		memberships: options.memberships,
		now: options.now
	})), table, options, loadOperators(options.operators));
}
//#endregion
export { toWhere };
