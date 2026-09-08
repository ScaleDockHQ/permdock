import { t as assertSafeKey } from "../paths-AH4M6YYV.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { t as compileWhere } from "../compile-CDInSAtn.js";
//#region src/prisma/to-where.ts
const EMPTY_OR = { OR: [] };
function fieldName(field, fields) {
	assertSafeKey(field, "condition field");
	return fields?.[field] ?? field;
}
function render(node, options) {
	switch (node.kind) {
		case "never": return { ...EMPTY_OR };
		case "always": return {};
		case "isNull": {
			const name = fieldName(node.field, options.fields);
			return node.negated ? { [name]: { not: null } } : { [name]: { equals: null } };
		}
		case "and": return { AND: node.items.map((item) => render(item, options)) };
		case "or": return { OR: node.items.map((item) => render(item, options)) };
		case "not": return { NOT: render(node.item, options) };
		case "exists": return { [fieldName(node.rowField, options.fields)]: { in: [] } };
		case "compare": {
			const name = fieldName(node.field, options.fields);
			switch (node.op) {
				case "eq": return { [name]: { equals: node.value } };
				case "ne": return { [name]: { not: node.value } };
				case "gt": return { [name]: { gt: node.value } };
				case "gte": return { [name]: { gte: node.value } };
				case "lt": return { [name]: { lt: node.value } };
				case "lte": return { [name]: { lte: node.value } };
				case "in": return { [name]: { in: node.value } };
				case "notIn": return { [name]: { notIn: node.value } };
				case "contains": return options.listFields?.includes(node.field) === true ? { [name]: { has: node.value } } : { [name]: { contains: node.value } };
				default: {
					const exhaustive = node.op;
					throw new Error(`PermDock: unknown compare '${String(exhaustive)}'`);
				}
			}
		}
		default: throw new Error(`PermDock: unknown compiled node '${String(node)}'`);
	}
}
function containsEmptyOr(value) {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some((item) => containsEmptyOr(item));
	const record = value;
	if (Array.isArray(record.OR) && record.OR.length === 0) return true;
	return Object.values(record).some((item) => containsEmptyOr(item));
}
function rewriteEmptyOr(args) {
	const where = args.where;
	if (where === void 0 || !containsEmptyOr(where)) return args;
	return {
		...args,
		where: {
			AND: [where, EMPTY_OR],
			OR: []
		}
	};
}
function toWhere(input, options = {}) {
	return render(compileWhere(input, compact({
		subject: options.subject,
		now: options.now
	})), options);
}
function permdockExtension() {
	const wrap = ({ args, query }) => {
		return query(rewriteEmptyOr(args));
	};
	return {
		name: "permdock",
		query: { $allModels: {
			findMany: wrap,
			findFirst: wrap,
			count: wrap,
			aggregate: wrap,
			updateMany: wrap,
			deleteMany: wrap
		} }
	};
}
//#endregion
export { permdockExtension, toWhere };
