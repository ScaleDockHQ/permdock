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
export { freezeDeep as n, compact as t };
