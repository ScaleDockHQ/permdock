import { i as ownKeys, n as isForbiddenKey, r as ownGet } from "./paths-AH4M6YYV.js";
import { t as freezeDeep } from "./freeze-BF4IK5al.js";
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
export { sanitizeFields as i, pickVisible as n, sanitizeContext as r, grantCoversField as t };
