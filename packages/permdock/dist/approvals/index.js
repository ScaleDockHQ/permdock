import { t as compact } from "../compact-CxCColYy.js";
import { a as resumeFromHeader, c as memoryApprovalStore, d as isApprovalError, i as resolveApproval, l as APPROVAL_HEADER, n as readApprovalHeader, o as summariseSubject, r as requestApproval, s as assertApprover, t as inspectApproval, u as DEFAULT_APPROVAL_TTL_MS } from "../helpers-BHqWg20R.js";
//#region src/approvals/handler.ts
const PROBLEM_BASE = "https://permdock.dev/problems";
function problem(status, title, detail, slug) {
	const body = {
		type: `${PROBLEM_BASE}/${slug}`,
		title,
		status,
		detail
	};
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/problem+json" }
	});
}
function json(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" }
	});
}
function parseRoute(url, method) {
	const parts = url.pathname.replace(/\/+$/u, "").split("/").filter(Boolean);
	const last = parts.at(-1);
	const prev = parts.at(-2);
	if (last === void 0) return;
	if (method === "GET" && last === "pending") return { kind: "pending" };
	if (method === "GET" && last === "mine") return { kind: "mine" };
	if (method === "POST" && last === "approve" && prev !== void 0) return {
		kind: "approve",
		token: decodeURIComponent(prev)
	};
	if (method === "POST" && last === "reject" && prev !== void 0) return {
		kind: "reject",
		token: decodeURIComponent(prev)
	};
	if (method === "GET" && last !== "pending" && last !== "mine") return {
		kind: "get",
		token: decodeURIComponent(last)
	};
}
async function resolveSubject(request, resolve) {
	try {
		const subject = await resolve(request);
		if (subject === null || subject === void 0) return null;
		return subject;
	} catch {
		return null;
	}
}
function membershipTenants(subject) {
	const principal = subject.principal;
	if (principal === null) return [];
	const tenants = /* @__PURE__ */ new Set();
	if (principal.tenant !== void 0) tenants.add(principal.tenant);
	for (const membership of principal.memberships ?? []) if (membership.tenant !== void 0) tenants.add(membership.tenant);
	return [...tenants];
}
function belongsToTenant(subject, tenant) {
	return membershipTenants(subject).includes(tenant);
}
function canView(request, subject) {
	const principal = subject.principal;
	if (principal === null) return false;
	if (request.subject.principal?.id === principal.id) return true;
	const tenant = request.subject.principal?.tenant;
	if (tenant !== void 0) return belongsToTenant(subject, tenant);
	return true;
}
function inboxTenant(url, subject) {
	const requested = url.searchParams.get("tenant");
	if (requested !== null && requested !== "") {
		if (!belongsToTenant(subject, requested)) return { ok: false };
		return {
			ok: true,
			tenant: requested
		};
	}
	const active = subject.principal?.tenant;
	if (active !== void 0) return {
		ok: true,
		tenant: active
	};
	return { ok: true };
}
function signedApproval(request, signer, audience) {
	if (signer === void 0 || request.status !== "approved") return Promise.resolve(void 0);
	const payload = { approval: {
		token: request.token,
		permission: request.permission,
		resource: request.resource,
		status: request.status
	} };
	if (request.subject.principal !== null) payload.sub = request.subject.principal.id;
	return signer.sign(payload, compact({
		typ: "permdock-approval+jwt",
		audience,
		expiresAt: Math.floor(Date.parse(request.expiresAt) / 1e3)
	}));
}
async function readNote(request) {
	const contentType = request.headers.get("content-type") ?? "";
	if (request.method !== "POST" || contentType === "") return;
	if (!contentType.includes("application/json")) return;
	try {
		const body = await request.json();
		if (body !== null && typeof body === "object" && "note" in body && typeof body.note === "string") return body.note;
	} catch {
		return;
	}
}
function mapError(error) {
	if (!isApprovalError(error)) return problem(500, "Internal error", "approval store failed", "internal");
	if (error.code === "approval-not-found") return problem(404, "Not found", error.message, "not-found");
	if (error.code === "approval-not-pending" || error.code === "approval-expired") return problem(409, "Conflict", error.message, "conflict");
	if (error.code === "approver-unauthenticated") return problem(401, "Unauthenticated", error.message, "unauthenticated");
	return problem(403, "Permission denied", error.message, "denied");
}
function approvalsHandler(store, options) {
	const requireDistinct = options.requireDistinctApprover === true;
	return async (request) => {
		const url = new URL(request.url);
		const route = parseRoute(url, request.method);
		if (route === void 0) return problem(405, "Method not allowed", "unknown approvals route", "method-not-allowed");
		await store.expire();
		const subject = await resolveSubject(request, options.subject);
		if (subject === null || subject.principal === null) return problem(401, "Unauthenticated", "approver must be authenticated", "unauthenticated");
		try {
			if (route.kind === "pending") {
				const scoped = inboxTenant(url, subject);
				if (!scoped.ok) return problem(403, "Permission denied", "approver does not belong to that tenant", "denied");
				return json(200, await store.list(compact({
					status: "pending",
					tenant: scoped.tenant
				})));
			}
			if (route.kind === "mine") return json(200, await store.list({ principalId: subject.principal.id }));
			if (route.kind === "get") {
				const current = await store.get(route.token);
				if (current === null || !canView(current, subject)) return problem(404, "Not found", "approval was not found", "not-found");
				return json(200, current);
			}
			const current = await store.get(route.token);
			if (current === null) return problem(404, "Not found", "approval was not found", "not-found");
			assertApprover(current, subject, requireDistinct);
			const note = await readNote(request);
			const resolved = await store.resolve(route.token, compact({
				status: route.kind === "approve" ? "approved" : "rejected",
				by: subject,
				note
			}));
			const signed = await signedApproval(resolved, options.signer, options.audience);
			return json(200, compact({
				...resolved,
				signed
			}));
		} catch (error) {
			return mapError(error);
		}
	};
}
//#endregion
export { APPROVAL_HEADER, DEFAULT_APPROVAL_TTL_MS, approvalsHandler, inspectApproval, memoryApprovalStore, readApprovalHeader, requestApproval, resolveApproval, resumeFromHeader, summariseSubject };
