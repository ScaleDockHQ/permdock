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
export { freezeDeep as t };
