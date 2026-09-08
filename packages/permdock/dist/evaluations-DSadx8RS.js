import { t as compact } from "./compact-CxCColYy.js";
import { a as deniedMessage, i as approvalMessage, n as PermDockDeniedError, r as PermDockValidationError, t as PermDockApprovalRequiredError } from "./errors-Q-hDyBns.js";
import { n as findPermission, o as listPermissions } from "./permissions-HC1OYNNj.js";
import { a as resumeFromHeader, n as readApprovalHeader, r as requestApproval } from "./helpers-BHqWg20R.js";
//#region src/server/problem.ts
const PROBLEM_BASE = "https://permdock.dev/problems";
function quoted(value) {
	return `"${value.replaceAll(/["\\]/gu, "")}"`;
}
function wwwAuthenticate(decision, permission) {
	if (decision.outcome !== "denied") return;
	const reasons = new Set(decision.denials.map((denial) => denial.reason));
	if (reasons.has("insufficient-user-authentication")) return "Bearer error=\"insufficient_user_authentication\"";
	if (reasons.has("anonymous")) return "Bearer error=\"invalid_token\"";
	if (reasons.has("not-delegated") || reasons.has("no-delegation")) {
		const scope = permission?.scope;
		if (scope === void 0) return "Bearer error=\"insufficient_scope\"";
		return `Bearer error="insufficient_scope", scope=${quoted(scope)}`;
	}
}
function problemResponse(details, permission, decision) {
	const headers = new Headers({ "content-type": "application/problem+json" });
	if (decision !== void 0) {
		const challenge = wwwAuthenticate(decision, permission);
		if (challenge !== void 0) headers.set("WWW-Authenticate", challenge);
	}
	return new Response(JSON.stringify(details), {
		status: details.status,
		headers
	});
}
function validationProblem(detail) {
	return problemResponse(compact({
		type: `${PROBLEM_BASE}/validation`,
		title: "Invalid request",
		status: 400,
		detail
	}));
}
function resourceRef$1(permission, data) {
	const id = data !== null && typeof data === "object" && "id" in data ? data.id : void 0;
	return compact({
		type: permission.resource,
		id: typeof id === "string" || typeof id === "number" ? String(id) : void 0
	});
}
function problemFromDecision(decision, permission, subject, options = {}) {
	const base = options.base ?? "https://permdock.dev/problems";
	if (decision.outcome === "granted") return new Response(null, { status: 204 });
	if (decision.outcome === "approval-required") return problemResponse({
		...new PermDockApprovalRequiredError({
			decision,
			permission: permission.key,
			scope: permission.scope,
			resource: resourceRef$1(permission, void 0),
			message: approvalMessage(permission.key, decision.reason, decision.token)
		}).toProblemDetails(compact({ instance: options.instance })),
		type: `${base}/approval-required`
	}, permission, decision);
	const reasons = new Set(decision.denials.map((denial) => denial.reason));
	if (decision.denials.some((denial) => denial.detail instanceof PermDockValidationError)) {
		const validation = decision.denials[0]?.detail;
		if (validation instanceof PermDockValidationError) return problemResponse(validation.toProblemDetails(), permission, decision);
	}
	const details = new PermDockDeniedError({
		decision,
		permission: permission.key,
		scope: permission.scope,
		resource: resourceRef$1(permission, void 0),
		subject,
		message: deniedMessage(permission.key, subject.principal?.id, decision.denials, decision.alternatives.map((leaf) => leaf.key))
	}).toProblemDetails(compact({ instance: options.instance }));
	let status = details.status;
	let type = `${base}/denied`;
	if (reasons.has("anonymous")) {
		status = 401;
		type = `${base}/unauthenticated`;
	} else if (reasons.has("insufficient-user-authentication")) {
		status = 401;
		type = `${base}/step-up-required`;
	}
	return problemResponse({
		...details,
		status,
		type
	}, permission, decision);
}
//#endregion
//#region src/server/evaluations.ts
const DENIED = {
	outcome: "denied",
	denials: [{
		role: null,
		reason: "no-grant"
	}],
	alternatives: []
};
function permissionOf(tree, item) {
	const action = typeof item.action?.name === "string" ? item.action.name : void 0;
	if (action === void 0) return;
	const byKey = findPermission(tree, action);
	if (byKey !== void 0) return byKey;
	const resource = typeof item.resource?.type === "string" ? item.resource.type : void 0;
	if (resource === void 0) return;
	const dotted = findPermission(tree, `${resource}.${action}`);
	if (dotted !== void 0) return dotted;
	return listPermissions(tree).find((leaf) => leaf.resource === resource && leaf.action === action);
}
function resourceData(item) {
	const properties = item.resource?.properties;
	if (properties !== null && typeof properties === "object") return properties;
	const id = item.resource?.id;
	if (typeof id === "string" || typeof id === "number") return { id: String(id) };
}
function resourceRef(permission, item, data) {
	const fromRow = data !== null && typeof data === "object" && "id" in data ? data.id : void 0;
	const fromWire = item.resource?.id;
	const id = typeof fromRow === "string" || typeof fromRow === "number" ? String(fromRow) : typeof fromWire === "string" || typeof fromWire === "number" ? String(fromWire) : void 0;
	return compact({
		type: permission.resource,
		id
	});
}
function evaluationRow(decision) {
	switch (decision.outcome) {
		case "granted": return {
			decision: true,
			context: {
				outcome: "granted",
				permdock: decision
			}
		};
		case "denied": return {
			decision: false,
			context: {
				outcome: "denied",
				permdock: decision
			}
		};
		case "approval-required": return {
			decision: false,
			context: {
				outcome: "approval-required",
				permdock: decision
			}
		};
		default: return decision;
	}
}
function approvalDenied(detail) {
	return {
		outcome: "denied",
		denials: [{
			role: null,
			reason: "approval",
			detail
		}],
		alternatives: []
	};
}
function resumeMatches(inspected, permission, ref, decision) {
	if (inspected.request.token !== decision.token) return false;
	if (inspected.request.permission !== permission.key) return false;
	if (inspected.request.resource.id !== void 0 && inspected.request.resource.id !== ref.id) return false;
	return true;
}
async function applyApprovalResume(decision, permission, dock, store, request, resource, adapter) {
	if (readApprovalHeader(request.headers) === void 0) {
		if (decision.outcome === "approval-required" && store !== void 0) await requestApproval(store, decision, compact({
			permission,
			resource,
			subject: dock.subject,
			adapter
		}));
		return decision;
	}
	const inspected = store === void 0 ? void 0 : await resumeFromHeader(store, request.headers);
	if (store === void 0 || inspected === void 0 || !inspected.ok) return approvalDenied(inspected !== void 0 && !inspected.ok ? inspected.detail : "approval-not-found");
	if (decision.outcome === "granted" || decision.outcome === "denied") return decision;
	if (!resumeMatches(inspected, permission, resource, decision)) return approvalDenied("approval-mismatch");
	const principal = dock.subject.principal;
	if (principal === null) return approvalDenied("approval-mismatch");
	return {
		outcome: "granted",
		subject: {
			...dock.subject,
			principal
		},
		matched: decision.grant,
		token: decision.token
	};
}
async function applyResume(decision, permission, item, data, dock, store, inspected, header, adapter) {
	if (header === void 0) {
		if (decision.outcome === "approval-required" && store !== void 0) await requestApproval(store, decision, compact({
			permission,
			resource: resourceRef(permission, item, data),
			subject: dock.subject,
			adapter
		}));
		return decision;
	}
	if (store === void 0 || inspected === void 0 || !inspected.ok) return approvalDenied(inspected !== void 0 && !inspected.ok ? inspected.detail : "approval-not-found");
	if (decision.outcome === "granted" || decision.outcome === "denied") return decision;
	if (!resumeMatches(inspected, permission, resourceRef(permission, item, data), decision)) return approvalDenied("approval-mismatch");
	const principal = dock.subject.principal;
	if (principal === null) return approvalDenied("approval-mismatch");
	return {
		outcome: "granted",
		subject: {
			...dock.subject,
			principal
		},
		matched: decision.grant,
		token: decision.token
	};
}
function evaluateOne(policy, dock, item, store, inspected, header, adapter) {
	const permission = permissionOf(policy.permissions, item);
	if (permission === void 0) return Promise.resolve(DENIED);
	const data = resourceData(item);
	const decide = dock.decide;
	return applyResume(decide(permission, data, compact({
		source: "endpoint",
		adapter
	})), permission, item, data, dock, store, inspected, header, adapter);
}
async function resolveDock(options, request, tenant) {
	if (options.resolve !== void 0) {
		const dock = await options.resolve(request);
		return tenant === void 0 ? dock : dock.tenant(tenant);
	}
	if (options.getPermDock !== void 0) return options.getPermDock(tenant === void 0 ? void 0 : { tenant });
	throw new TypeError("evaluations handler needs resolve or getPermDock");
}
function createEvaluationsHandler(options) {
	const adapter = options.adapter ?? "server";
	const POST = async (request) => {
		let body;
		try {
			body = await request.json();
		} catch {
			return validationProblem("evaluations body was not valid JSON");
		}
		if (body === null || typeof body !== "object" || Array.isArray(body)) return validationProblem("evaluations body must be an object");
		const evaluations = body.evaluations;
		if (evaluations === void 0) return validationProblem("evaluations array is required");
		if (!Array.isArray(evaluations)) return validationProblem("evaluations must be an array");
		const header = readApprovalHeader(request.headers);
		const inspected = header === void 0 || options.store === void 0 ? void 0 : await resumeFromHeader(options.store, request.headers);
		const dock = await resolveDock(options, request);
		const rows = await Promise.all(evaluations.map(async (item) => {
			const entry = item !== null && typeof item === "object" ? item : {};
			return evaluationRow(await evaluateOne(options.policy, dock, entry, options.store, inspected, header, adapter));
		}));
		return Response.json({ evaluations: rows });
	};
	const GET = async (request) => {
		const url = new URL(request.url);
		if (url.pathname.includes("authzen-configuration")) {
			const origin = url.origin;
			return Response.json({
				policy_decision_point: origin,
				access_evaluation_endpoint: `${origin}/access/v1/evaluation`,
				access_evaluations_endpoint: `${origin}/access/v1/evaluations`
			});
		}
		const snapshot = (await resolveDock(options, request, url.searchParams.get("tenant") ?? void 0)).snapshot();
		return Response.json(await Promise.resolve(snapshot));
	};
	return {
		POST,
		GET
	};
}
//#endregion
export { problemResponse as a, problemFromDecision as i, createEvaluationsHandler as n, validationProblem as o, PROBLEM_BASE as r, wwwAuthenticate as s, applyApprovalResume as t };
