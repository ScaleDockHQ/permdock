import { n as freezeDeep, t as compact } from "../compact-CxCColYy.js";
import { t as describe } from "../describe-BnKr1Gwo.js";
//#region src/approvals/errors.ts
var ApprovalError = class extends Error {
	name = "ApprovalError";
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
function isApprovalError(value) {
	return value instanceof ApprovalError;
}
//#endregion
//#region src/approvals/types.ts
const APPROVAL_HEADER = "PermDock-Approval";
const DEFAULT_APPROVAL_TTL_MS = 36e5;
//#endregion
//#region src/approvals/store.ts
function tenantOf(request) {
	return request.subject.principal?.tenant;
}
function matchesFilter(request, filter) {
	if (filter.status !== void 0 && request.status !== filter.status) return false;
	if (filter.principalId !== void 0 && request.subject.principal?.id !== filter.principalId) return false;
	if (filter.actorId !== void 0 && request.subject.actor?.id !== filter.actorId) return false;
	if (filter.tenant !== void 0 && tenantOf(request) !== filter.tenant) return false;
	return true;
}
function assertApprover(request, by, requireDistinctApprover) {
	const principal = by.principal;
	if (principal === null) throw new ApprovalError("approver-unauthenticated", "approver must be authenticated");
	if (request.subject.actor !== void 0 && principal.id === request.subject.actor.id) throw new ApprovalError("approver-is-actor", "approver is the actor of this request");
	if (requireDistinctApprover && request.subject.principal !== null && principal.id === request.subject.principal.id) throw new ApprovalError("approver-is-principal", "approver is the principal of this request");
}
function applyVerdict(request, verdict, now) {
	const principal = verdict.by.principal;
	if (principal === null) throw new ApprovalError("approver-unauthenticated", "approver must be authenticated");
	if (request.status !== "pending") throw new ApprovalError("approval-not-pending", "approval is not pending");
	if (Date.parse(request.expiresAt) <= now.getTime()) throw new ApprovalError("approval-expired", "approval has expired");
	assertApprover(request, verdict.by, false);
	return freezeDeep(compact({
		...request,
		status: verdict.status,
		resolvedAt: now.toISOString(),
		resolvedBy: principal.id,
		note: verdict.note
	}));
}
function memoryApprovalStore(options = {}) {
	const ttl = options.ttl ?? 36e5;
	const records = /* @__PURE__ */ new Map();
	return {
		ttl,
		create(request) {
			records.set(request.token, freezeDeep(request));
		},
		get(token) {
			return records.get(token) ?? null;
		},
		resolve(token, verdict) {
			const current = records.get(token);
			if (current === void 0) throw new ApprovalError("approval-not-found", "approval was not found");
			const next = applyVerdict(current, verdict, /* @__PURE__ */ new Date());
			records.set(token, next);
			return next;
		},
		list(filter) {
			const out = [];
			for (const request of records.values()) if (matchesFilter(request, filter)) out.push(request);
			return out;
		},
		expire(now = /* @__PURE__ */ new Date()) {
			let count = 0;
			const instant = now.getTime();
			for (const [token, request] of records) if (request.status === "pending" && Date.parse(request.expiresAt) <= instant) {
				records.set(token, freezeDeep(compact({
					...request,
					status: "expired"
				})));
				count += 1;
			}
			return count;
		}
	};
}
//#endregion
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
//#region src/approvals/helpers.ts
function permissionMeta(permission) {
	return {
		key: permission.key,
		scope: permission.scope,
		resource: permission.resource
	};
}
function summariseSubject(subject) {
	const principal = subject.principal;
	return compact({
		principal: principal === null ? null : compact({
			id: principal.id,
			roles: principal.roles ?? [],
			tenant: principal.tenant
		}),
		actor: subject.actor === void 0 ? void 0 : {
			id: subject.actor.id,
			kind: subject.actor.kind
		},
		delegation: subject.delegation === void 0 ? void 0 : compact({
			scopes: subject.delegation.scopes,
			authorizationDetails: subject.delegation.authorizationDetails
		})
	});
}
async function requestApproval(store, decision, meta) {
	const now = meta.now ?? /* @__PURE__ */ new Date();
	const ttl = meta.ttl ?? 36e5;
	const leaf = permissionMeta(meta.permission);
	const request = freezeDeep(compact({
		v: 1,
		token: decision.token,
		permission: leaf.key,
		scope: leaf.scope,
		resource: meta.resource ?? { type: leaf.resource },
		subject: summariseSubject(meta.subject),
		membership: meta.membership,
		detail: meta.detail ?? describe(decision).detail,
		adapter: meta.adapter,
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + ttl).toISOString(),
		status: "pending"
	}));
	await store.create(request);
	return request;
}
async function resolveApproval(store, token, verdict, options = {}) {
	const current = await store.get(token);
	if (current === null) throw new ApprovalError("approval-not-found", "approval was not found");
	assertApprover(current, verdict.by, options.requireDistinctApprover === true);
	return store.resolve(token, verdict);
}
async function inspectApproval(store, token, now = /* @__PURE__ */ new Date()) {
	await store.expire(now);
	const request = await store.get(token);
	if (request === null) return {
		ok: false,
		detail: "approval-not-found"
	};
	if (request.status === "pending") return {
		ok: false,
		detail: "approval-pending"
	};
	if (request.status === "rejected") return {
		ok: false,
		detail: "approval-rejected"
	};
	if (request.status === "expired" || Date.parse(request.expiresAt) <= now.getTime()) return {
		ok: false,
		detail: "approval-expired"
	};
	return {
		ok: true,
		request
	};
}
function readApprovalHeader(headers) {
	const value = headers.get(APPROVAL_HEADER);
	if (value === null || value.trim() === "") return;
	return value.trim();
}
function resumeFromHeader(store, headers, now) {
	const token = readApprovalHeader(headers);
	if (token === void 0) return Promise.resolve({
		ok: false,
		detail: "approval-not-found"
	});
	return inspectApproval(store, token, now);
}
//#endregion
export { APPROVAL_HEADER, DEFAULT_APPROVAL_TTL_MS, approvalsHandler, inspectApproval, memoryApprovalStore, readApprovalHeader, requestApproval, resolveApproval, resumeFromHeader, summariseSubject };
