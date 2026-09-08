import { t as compact } from "./compact-CxSqQNw0.js";
//#region src/core/errors.ts
const PROBLEM_BASE = "https://permdock.dev/problems";
var PermDockDeniedError = class extends Error {
	name = "PermDockDeniedError";
	decision;
	permission;
	scope;
	resource;
	subject;
	constructor(input) {
		super(input.message);
		this.decision = input.decision;
		this.permission = input.permission;
		this.scope = input.scope;
		this.resource = input.resource;
		this.subject = input.subject;
	}
	toProblemDetails(options) {
		return compact({
			type: `${PROBLEM_BASE}/denied`,
			title: "Permission denied",
			status: 403,
			detail: this.message,
			instance: options?.instance,
			permission: this.permission,
			scope: this.scope,
			resource: this.resource,
			denials: this.decision.denials,
			alternatives: this.decision.alternatives.map((leaf) => leaf.key)
		});
	}
};
var PermDockApprovalRequiredError = class extends Error {
	name = "PermDockApprovalRequiredError";
	decision;
	permission;
	scope;
	resource;
	token;
	reason;
	constructor(input) {
		super(input.message);
		this.decision = input.decision;
		this.permission = input.permission;
		this.scope = input.scope;
		this.resource = input.resource;
		this.token = input.decision.token;
		this.reason = input.decision.reason;
	}
	toProblemDetails(options) {
		return compact({
			type: `${PROBLEM_BASE}/approval-required`,
			title: "Approval required",
			status: 403,
			detail: this.message,
			instance: options?.instance,
			permission: this.permission,
			scope: this.scope,
			resource: this.resource,
			reason: this.reason,
			token: this.token
		});
	}
};
var PermDockValidationError = class extends Error {
	name = "PermDockValidationError";
	code;
	permission;
	resource;
	issues;
	boundary;
	constructor(input) {
		super(input.message);
		this.code = input.code;
		this.permission = input.permission;
		this.resource = input.resource;
		this.issues = input.issues ?? [];
		this.boundary = input.boundary;
	}
	toProblemDetails(options) {
		return compact({
			type: `${PROBLEM_BASE}/validation`,
			title: "Invalid resource data",
			status: 400,
			detail: this.message,
			instance: options?.instance,
			permission: this.permission,
			issues: this.issues
		});
	}
};
function deniedMessage(permission, subjectId, denials, alternatives) {
	const clauses = denials.map((denial) => `${denial.role ?? "none"} (${denial.reason})`).join(", ");
	const alt = alternatives.length === 0 ? "" : ` Alternatives: ${alternatives.join(", ")}.`;
	return `${permission} denied for subject ${subjectId ?? "anonymous"}: ${clauses}.${alt}`;
}
function approvalMessage(permission, reason, token) {
	return `${permission} requires human approval (${reason}). Token: ${token}.`;
}
//#endregion
export { deniedMessage as a, approvalMessage as i, PermDockDeniedError as n, PermDockValidationError as r, PermDockApprovalRequiredError as t };
