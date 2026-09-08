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
export { compact as t };
