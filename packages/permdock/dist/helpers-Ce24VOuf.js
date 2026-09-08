import { t as freezeDeep } from "./freeze-BF4IK5al.js";
import { t as describe } from "./describe-BnKr1Gwo.js";
import { t as compact } from "./compact-CxSqQNw0.js";
import { t as ApprovalError } from "./errors-BQyxzFvZ.js";
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
export { resumeFromHeader as a, memoryApprovalStore as c, resolveApproval as i, APPROVAL_HEADER as l, readApprovalHeader as n, summariseSubject as o, requestApproval as r, assertApprover as s, inspectApproval as t, DEFAULT_APPROVAL_TTL_MS as u };
