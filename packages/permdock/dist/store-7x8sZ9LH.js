import { t as compact } from "./compact-CxSqQNw0.js";
import { n as parseSnapshot, o as nowSeconds } from "./snapshot-BiwEN_W3.js";
import { n as fromSnapshot, t as emptySnapshot } from "./from-snapshot-DOibNHhf.js";
//#region src/react/store.ts
function cacheKey(permission, data) {
	if (data === null || typeof data !== "object") return `${permission.key}:*`;
	const id = data.id;
	return `${permission.key}:${typeof id === "string" || typeof id === "number" ? String(id) : "*"}`;
}
function refKey(ref) {
	if ("key" in ref && typeof ref.key === "string") return ref.key;
	return "";
}
function isJws(value) {
	const parts = value.split(".");
	return parts.length === 3 && parts.every((part) => part.length > 0);
}
const SERVER_ONLY = {
	outcome: "denied",
	denials: [{
		role: null,
		reason: "opaque-condition"
	}],
	alternatives: []
};
function needsEndpoint(decision) {
	return decision.outcome === "denied" && decision.denials.some((denial) => denial.reason === "opaque-condition");
}
function createClientStore(options) {
	const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
	const listeners = /* @__PURE__ */ new Set();
	const answers = /* @__PURE__ */ new Map();
	const inflight = /* @__PURE__ */ new Map();
	let queued = [];
	let flushScheduled = false;
	let snapshot = emptySnapshot();
	let tenant = options.tenant;
	let storeStatus = "server-only";
	let instance = fromSnapshot(snapshot, compact({ tenant }));
	let cached;
	let verifying = false;
	const emit = () => {
		cached = wrap(instance);
		for (const listener of listeners) listener();
	};
	const hydrate = (next) => {
		snapshot = next;
		instance = fromSnapshot(snapshot, compact({ tenant }));
		storeStatus = isStale() ? "stale" : "ready";
		options.onSnapshot?.(next, tenant);
		emit();
	};
	const isStale = () => {
		const now = nowSeconds();
		if (snapshot.expiresAt !== void 0 && snapshot.expiresAt <= now) return true;
		if (options.maxAge !== void 0 && snapshot.issuedAt > 0 && now - snapshot.issuedAt > options.maxAge) return true;
		return false;
	};
	const applyParsed = (value) => {
		try {
			hydrate(parseSnapshot(value));
		} catch {
			hydrate(emptySnapshot());
			storeStatus = "server-only";
			emit();
		}
	};
	const bootJws = async (raw) => {
		if (options.verifier === void 0) {
			hydrate(emptySnapshot());
			storeStatus = "server-only";
			emit();
			return;
		}
		verifying = true;
		storeStatus = "pending";
		emit();
		const verified = await options.verifier.verify(raw, { typ: "permdock-snapshot+jwt" });
		verifying = false;
		if (!verified.ok) {
			hydrate(emptySnapshot());
			storeStatus = "server-only";
			emit();
			return;
		}
		applyParsed(verified.claims.snapshot);
	};
	const scheduleFlush = () => {
		if (flushScheduled || options.endpoint === void 0) return;
		flushScheduled = true;
		queueMicrotask(() => {
			flushScheduled = false;
			flush();
		});
	};
	const flush = async () => {
		const batch = queued;
		queued = [];
		if (batch.length === 0 || options.endpoint === void 0) return;
		if (snapshot.simulated === true) {
			for (const item of batch) answers.set(item.key, {
				decision: SERVER_ONLY,
				status: "server-only"
			});
			emit();
			return;
		}
		try {
			const response = await fetchImpl(options.endpoint, {
				method: "POST",
				credentials: "include",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					...options.headers
				},
				body: JSON.stringify({ evaluations: batch.map((item) => ({
					subject: {
						type: instance.subject.principal?.kind ?? "user",
						id: instance.subject.principal?.id ?? ""
					},
					action: { name: item.permission.action },
					resource: {
						type: item.permission.resource,
						id: item.data !== null && typeof item.data === "object" && "id" in item.data ? String(item.data.id ?? "") : void 0,
						properties: item.data
					}
				})) })
			});
			if (!response.ok) throw new Error("evaluations failed");
			const body = await response.json();
			for (const [index, item] of batch.entries()) {
				const decision = (body.evaluations?.[index])?.context?.permdock ?? SERVER_ONLY;
				answers.set(item.key, {
					decision,
					status: "ready"
				});
				inflight.delete(item.key);
			}
		} catch {
			for (const item of batch) {
				answers.set(item.key, {
					decision: SERVER_ONLY,
					status: "server-only"
				});
				inflight.delete(item.key);
			}
		}
		emit();
	};
	const enqueue = (permission, data) => {
		const key = cacheKey(permission, data);
		if (answers.has(key) || inflight.has(key)) return;
		if (options.endpoint === void 0) {
			answers.set(key, {
				decision: SERVER_ONLY,
				status: "server-only"
			});
			emit();
			return;
		}
		answers.set(key, {
			decision: SERVER_ONLY,
			status: "pending"
		});
		inflight.set(key, Promise.resolve(SERVER_ONLY));
		queued.push({
			permission,
			data,
			key
		});
		storeStatus = "pending";
		emit();
		scheduleFlush();
	};
	const permissionState = (permission, data) => {
		const key = cacheKey(permission, data);
		const hit = answers.get(key);
		if (hit !== void 0) return {
			allowed: hit.decision.outcome === "granted",
			status: hit.status,
			decision: hit.decision
		};
		const decision = instance.decide(permission, data);
		if (needsEndpoint(decision)) {
			enqueue(permission, data);
			const next = answers.get(key);
			if (next !== void 0) return {
				allowed: false,
				status: next.status,
				decision: next.decision
			};
			return {
				allowed: false,
				status: "server-only",
				decision: SERVER_ONLY
			};
		}
		return {
			allowed: decision.outcome === "granted",
			status: isStale() ? "stale" : verifying ? "pending" : "ready",
			decision
		};
	};
	const wrap = (dock) => {
		return {
			...dock,
			status(permission, data) {
				if (permission === void 0) return storeStatus;
				return permissionState(permission, data).status;
			},
			invalidate(ref) {
				const prefix = refKey(ref);
				for (const key of answers.keys()) if (prefix === "" || key === prefix || key.startsWith(`${prefix}:`) || key.startsWith(`${prefix}.`)) answers.delete(key);
				storeStatus = "stale";
				emit();
			},
			async refresh(query) {
				if (query?.tenant !== void 0) {
					tenant = query.tenant;
					if (snapshot.tenants.includes(query.tenant) || options.snapshotUrl === void 0 && options.endpoint === void 0) {
						instance = fromSnapshot(snapshot, compact({ tenant }));
						storeStatus = "ready";
						options.onSnapshot?.(snapshot, tenant);
						emit();
						return;
					}
				}
				const source = options.snapshotUrl ?? options.endpoint;
				if (source === void 0) return;
				storeStatus = "stale";
				emit();
				try {
					const href = new URL(source, "https://permdock.local");
					if (query?.tenant !== void 0) href.searchParams.set("tenant", query.tenant);
					const response = await fetchImpl(`${source}${href.search}`, {
						method: "GET",
						credentials: "include",
						headers: {
							accept: "application/json",
							...options.headers
						}
					});
					if (!response.ok) throw new Error("refresh failed");
					applyParsed(await response.json());
				} catch {
					storeStatus = "stale";
					emit();
				}
			},
			clear() {
				answers.clear();
				inflight.clear();
				queued = [];
				tenant = options.tenant;
				snapshot = emptySnapshot();
				instance = fromSnapshot(snapshot, compact({ tenant }));
				storeStatus = "server-only";
				options.onClear?.();
				emit();
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			}
		};
	};
	if (typeof options.snapshot === "string" && isJws(options.snapshot)) {
		cached = wrap(instance);
		bootJws(options.snapshot);
	} else {
		applyParsed(options.snapshot);
		cached = wrap(instance);
	}
	return {
		get() {
			return cached;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		permissionState,
		replace(value) {
			applyParsed(value);
		},
		snapshot() {
			return snapshot;
		},
		async requestApproval(decision, note) {
			if (decision.outcome !== "approval-required" || snapshot.simulated === true) return;
			const href = options.approvals ?? options.endpoint;
			if (href === void 0) return;
			await fetchImpl(href, {
				method: "POST",
				credentials: "include",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					...options.headers
				},
				body: JSON.stringify({
					permission: decision.grant.permission,
					token: decision.token,
					note
				})
			});
		}
	};
}
//#endregion
export { createClientStore as t };
