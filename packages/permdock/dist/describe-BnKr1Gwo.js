//#region src/core/describe.ts
const TENANT_REASONS = /* @__PURE__ */ new Set([
	"tenant-mismatch",
	"no-membership",
	"expired-membership",
	"scope"
]);
const DELEGATION_REASONS = /* @__PURE__ */ new Set(["not-delegated", "no-delegation"]);
function describe(decision) {
	if (decision.outcome === "granted") return {
		kind: "granted",
		title: "Granted",
		detail: `${decision.matched.permission} granted.`,
		alternatives: []
	};
	if (decision.outcome === "approval-required") return {
		kind: "approval",
		title: "Approval required",
		detail: `${decision.grant.permission} requires human approval.`,
		alternatives: []
	};
	const reasons = decision.denials.map((denial) => denial.reason);
	const kind = reasons.some((reason) => TENANT_REASONS.has(reason)) ? "tenant" : reasons.some((reason) => DELEGATION_REASONS.has(reason)) ? "delegation" : reasons.includes("opaque-condition") ? "server-only" : "denied";
	return {
		kind,
		title: kind === "tenant" ? "Wrong tenant" : kind === "delegation" ? "Not delegated" : kind === "server-only" ? "Server only" : "Denied",
		detail: decision.denials.map((denial) => denial.reason).join(", "),
		alternatives: decision.alternatives
	};
}
//#endregion
export { describe as t };
