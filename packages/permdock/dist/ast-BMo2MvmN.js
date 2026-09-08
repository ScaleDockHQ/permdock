//#region src/conditions/ast.ts
function isConditionRef(value) {
	return value !== null && typeof value === "object" && "ref" in value && typeof value.ref === "string";
}
function isConditionDate(value) {
	return value !== null && typeof value === "object" && "date" in value && typeof value.date === "string" && !("ref" in value);
}
function isCondition(value) {
	return value !== null && typeof value === "object" && "op" in value && typeof value.op === "string";
}
//#endregion
export { isConditionDate as n, isConditionRef as r, isCondition as t };
