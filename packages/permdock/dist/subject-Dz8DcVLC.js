//#region src/core/subject.ts
function isPrincipal(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	if ("principal" in value && "context" in value) return false;
	const record = value;
	if (typeof record.id !== "string") return false;
	return Array.isArray(record.roles) || Array.isArray(record.memberships) || record.kind === "user" || record.kind === "service" || record.kind === "workload" || typeof record.issuer === "string";
}
function isSubject(value) {
	return value !== null && typeof value === "object" && "principal" in value && "context" in value && typeof value.context === "object";
}
function anonymousSubject(context = {}) {
	return Object.freeze({
		principal: null,
		context: Object.freeze({ ...context })
	});
}
//#endregion
export { isPrincipal as n, isSubject as r, anonymousSubject as t };
