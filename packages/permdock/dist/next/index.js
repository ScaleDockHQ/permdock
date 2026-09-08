import { t as compact } from "../compact-CxCColYy.js";
import { o as listPermissions, r as findPermission, t as createPermDock$1 } from "../permdock-LDgbRlwd.js";
import { a as resumeFromHeader, n as readApprovalHeader, r as requestApproval } from "../helpers-BHqWg20R.js";
import { t as PermDockProvider } from "../provider-Dn7rIOpX.js";
import { cache } from "react";
import { jsx } from "react/jsx-runtime";
//#region src/next/problem.ts
const PROBLEM_BASE = "https://permdock.dev/problems";
function quoted(value) {
	return `"${value.replaceAll(/["\\]/gu, "")}"`;
}
function wwwAuthenticate(decision, permission) {
	if (decision.outcome === "approval-required") return;
	if (decision.outcome === "granted") return;
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
//#endregion
//#region src/next/handler.ts
const DENIED$1 = {
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
async function applyResume(decision, permission, item, data, dock, store, inspected, header) {
	if (header === void 0) {
		if (decision.outcome === "approval-required" && store !== void 0) await requestApproval(store, decision, compact({
			permission,
			resource: resourceRef(permission, item, data),
			subject: dock.subject,
			adapter: "next"
		}));
		return decision;
	}
	if (store === void 0 || inspected === void 0 || !inspected.ok) return approvalDenied(inspected !== void 0 && !inspected.ok ? inspected.detail : "approval-not-found");
	if (decision.outcome === "granted") return decision;
	if (decision.outcome === "denied") return decision;
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
function evaluateOne(policy, dock, item, store, inspected, header) {
	const permission = permissionOf(policy.permissions, item);
	if (permission === void 0) return Promise.resolve(DENIED$1);
	const data = resourceData(item);
	const decide = dock.decide;
	return applyResume(decide(permission, data, compact({
		source: "endpoint",
		adapter: "next"
	})), permission, item, data, dock, store, inspected, header);
}
function createHandler(options) {
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
		const dock = await options.getPermDock();
		const rows = await Promise.all(evaluations.map(async (item) => {
			const entry = item !== null && typeof item === "object" ? item : {};
			return evaluationRow(await evaluateOne(options.policy, dock, entry, options.store, inspected, header));
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
		const tenant = url.searchParams.get("tenant") ?? void 0;
		const snapshot = (await options.getPermDock(tenant === void 0 ? void 0 : { tenant })).snapshot();
		return Response.json(await Promise.resolve(snapshot));
	};
	return {
		POST,
		GET
	};
}
//#endregion
//#region src/next/provider.tsx
function renderClientProvider(options) {
	return /* @__PURE__ */ jsx(PermDockProvider, {
		...compact({
			snapshot: options.snapshot,
			endpoint: options.endpoint,
			tenant: options.tenant
		}),
		children: options.children
	});
}
//#endregion
//#region src/next/create.ts
const DENIED = {
	outcome: "denied",
	denials: [{
		role: null,
		reason: "no-grant"
	}],
	alternatives: []
};
function assertServerOnly() {
	if (globalThis.document !== void 0) throw new TypeError("permdock/next is server-only. Import hooks and Protected from permdock/react.");
}
async function readTenant(tenant) {
	if (tenant === void 0 || typeof tenant === "string") return tenant;
	try {
		return await tenant();
	} catch {
		return;
	}
}
function wrapInstance(dock, onDenied) {
	if (onDenied === void 0) return dock;
	const assert = ((permission, data, options) => dock.assert(permission, data, compact({
		...options,
		onDenied: options?.onDenied ?? onDenied
	})));
	return {
		...dock,
		assert
	};
}
function createPermDock(policy, options) {
	assertServerOnly();
	const resolveSubject = cache(async () => {
		try {
			return await options.subject();
		} catch {
			return null;
		}
	});
	const resolveFallbackTenant = cache(() => readTenant(options.tenant));
	const instantiate = cache(async (tenantKey) => {
		const tenant = tenantKey === "" ? void 0 : tenantKey;
		const user = await resolveSubject();
		return wrapInstance(await createPermDock$1(policy, user, compact({
			tenant,
			memberships: options.memberships,
			customRoles: options.customRoles,
			sink: options.sink
		})), options.onDenied);
	});
	const getPermDock = async (query) => {
		const tenant = query?.tenant ?? await resolveFallbackTenant();
		return instantiate(tenant ?? "");
	};
	const getPermission = async (permission, data) => {
		try {
			const decision = (await getPermDock()).decide(permission, data);
			return {
				allowed: decision.outcome === "granted",
				status: "ready",
				decision
			};
		} catch {
			return {
				allowed: false,
				status: "ready",
				decision: DENIED
			};
		}
	};
	const PermDockProvider = async (props) => {
		const dock = await getPermDock(props.tenant === void 0 ? void 0 : { tenant: props.tenant });
		const snapshot = await Promise.resolve(dock.snapshot(compact({
			include: props.include,
			tenants: props.tenants
		})));
		return renderClientProvider(compact({
			snapshot,
			endpoint: props.endpoint ?? options.endpoint ?? "/api/permdock",
			tenant: props.tenant,
			children: props.children
		}));
	};
	const permdockHandler = () => createHandler(compact({
		policy,
		getPermDock,
		store: options.store
	}));
	return {
		getPermDock,
		getPermission,
		PermDockProvider,
		permdockHandler
	};
}
//#endregion
export { createPermDock };
