import { t as assertSafeKey } from "../paths-AH4M6YYV.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { t as compileWhere } from "../compile-CDInSAtn.js";
//#region src/kysely/to-where.ts
function ident(name) {
	assertSafeKey(name, "sql identifier");
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error(`PermDock: unsafe SQL identifier '${name}'`);
	return name;
}
function col(table, field, columns) {
	assertSafeKey(field, "condition field");
	return `${ident(table)}.${ident(columns?.[field] ?? field)}`;
}
function existsExpr(eb, node, table, options) {
	if (eb.exists === void 0 || eb.selectFrom === void 0) return eb.lit(false);
	const rowRef = col(table, node.rowField, options.columns);
	let query = eb.selectFrom(`${ident(node.table)} as m`).select(eb.lit(1)).whereRef(`m.${ident(node.rowColumn)}`, "=", rowRef).where(`m.${ident(node.user)}`, "=", eb.val(node.userValue)).where(`m.${ident(node.role)}`, "in", node.roles);
	if (node.expiresAt !== void 0) query = query.where(`m.${ident(node.expiresAt)}`, "is", null);
	if (node.tenantColumn !== void 0 && node.tenantValue !== void 0) query = query.where(`m.${ident(node.tenantColumn)}`, "=", eb.val(node.tenantValue));
	return eb.exists(query);
}
function render(eb, node, table, options) {
	switch (node.kind) {
		case "never": return eb.lit(false);
		case "always": return eb.lit(true);
		case "isNull": {
			const column = eb.ref(col(table, node.field, options.columns));
			return node.negated ? eb(column, "is not", null) : eb(column, "is", null);
		}
		case "and": return eb.and(node.items.map((item) => render(eb, item, table, options)));
		case "or": return eb.or(node.items.map((item) => render(eb, item, table, options)));
		case "not": return eb.not(render(eb, node.item, table, options));
		case "exists": return existsExpr(eb, node, table, options);
		case "compare": {
			const column = eb.ref(col(table, node.field, options.columns));
			switch (node.op) {
				case "eq": return eb(column, "=", eb.val(node.value));
				case "ne": return eb(column, "!=", eb.val(node.value));
				case "gt": return eb(column, ">", eb.val(node.value));
				case "gte": return eb(column, ">=", eb.val(node.value));
				case "lt": return eb(column, "<", eb.val(node.value));
				case "lte": return eb(column, "<=", eb.val(node.value));
				case "in": return eb(column, "in", node.value);
				case "notIn": return eb(column, "not in", node.value);
				case "contains": return typeof node.value === "string" ? eb(column, "like", eb.val(`%${node.value}%`)) : eb(column, "@>", eb.val(node.value));
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
	const compiled = compileWhere(input, compact({
		subject: options.subject,
		memberships: options.memberships,
		now: options.now
	}));
	return (eb) => render(eb, compiled, table, options);
}
async function withSubject(db, permdock, fn, options = {}) {
	const snapshot = await permdock.snapshot();
	if (typeof snapshot === "string") throw new TypeError("PermDock: withSubject needs a JSON snapshot");
	const userId = snapshot.subject.principal?.id ?? "";
	const tenant = snapshot.subject.principal?.tenant ?? "";
	return db.transaction().execute(async (trx) => {
		const exec = trx;
		const dialect = options.dialect ?? "supabase";
		if (exec.executeQuery !== void 0) {
			if (dialect === "guc" || dialect === "neon") await exec.executeQuery({
				sql: "select set_config('app.user_id', $1, true)",
				parameters: [userId]
			});
			else await exec.executeQuery({
				sql: "select set_config('request.jwt.claims', $1, true)",
				parameters: [JSON.stringify({
					sub: userId,
					tenant
				})]
			});
		}
		return fn(trx);
	});
}
//#endregion
export { toWhere, withSubject };
