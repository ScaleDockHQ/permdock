//#region src/core/paths.ts
const FORBIDDEN_KEYS = /* @__PURE__ */ new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
function isForbiddenKey(key) {
	return FORBIDDEN_KEYS.has(key);
}
function assertSafeKey(key, context) {
	if (isForbiddenKey(key) || key.length === 0) throw new Error(`PermDock: forbidden ${context} key '${key}'`);
}
function ownGet(object, key) {
	if (isForbiddenKey(key)) return;
	if (!Object.hasOwn(object, key)) return;
	return object[key];
}
function ownKeys(object) {
	return Object.keys(object).filter((key) => !isForbiddenKey(key));
}
function splitPath(path) {
	return path.split(".").filter((segment) => segment.length > 0);
}
function readPath(root, path) {
	const segments = splitPath(path);
	let current = root;
	for (const segment of segments) {
		if (isForbiddenKey(segment)) return;
		if (current === null || current === void 0 || typeof current !== "object") return;
		current = ownGet(current, segment);
	}
	return current;
}
//#endregion
export { readPath as a, ownKeys as i, isForbiddenKey as n, splitPath as o, ownGet as r, assertSafeKey as t };
