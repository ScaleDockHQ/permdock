import { a as fromSnapshot, c as nowSeconds, i as emptySnapshot, n as parseSnapshot } from "../snapshot-DjelOg1B.js";
import { t as compact } from "../compact-CxCColYy.js";
import { t as describe } from "../describe-BnKr1Gwo.js";
import { createContext, use, useMemo, useSyncExternalStore } from "react";
import { jsx } from "react/jsx-runtime";
//#region src/react/headers.ts
function approvalHeaders(token) {
	return { "PermDock-Approval": token };
}
//#endregion
//#region src/react/context.ts
const PermDockStoreContext = createContext(null);
//#endregion
//#region src/react/hooks.ts
function useStore() {
	const store = use(PermDockStoreContext);
	if (store === null) throw new Error("PermDock: hooks require <PermDockProvider>.");
	return store;
}
function usePermDock() {
	const store = useStore();
	return useSyncExternalStore((listener) => store.subscribe(listener), () => store.get(), () => store.get());
}
function usePermission(permission, data) {
	const store = useStore();
	const dock = useSyncExternalStore((listener) => store.subscribe(listener), () => store.get(), () => store.get());
	return useMemo(() => store.permissionState(permission, data), [
		store,
		dock,
		permission,
		data
	]);
}
function usePermissions(permissions, data) {
	const store = useStore();
	const dock = useSyncExternalStore((listener) => store.subscribe(listener), () => store.get(), () => store.get());
	return useMemo(() => {
		const granted = [];
		const byKey = {};
		for (const permission of permissions) {
			const state = store.permissionState(permission, data);
			byKey[permission.key] = state;
			if (state.allowed) granted.push(permission);
		}
		return new Proxy({
			granted,
			get(permission) {
				return byKey[permission.key];
			}
		}, { get(target, prop, receiver) {
			if (typeof prop === "string" && Object.hasOwn(byKey, prop)) return byKey[prop];
			return Reflect.get(target, prop, receiver);
		} });
	}, [
		store,
		dock,
		permissions,
		data
	]);
}
function useFilter(permission, rows) {
	const dock = usePermDock();
	return useMemo(() => {
		const result = [...dock.filter(permission, rows)];
		result.partial = dock.where(permission).partial;
		return result;
	}, [
		dock,
		permission,
		rows
	]);
}
function useTenant() {
	const dock = usePermDock();
	return {
		tenant: dock.subject.principal?.tenant ?? null,
		tenants: dock.tenants(),
		switchTo: (id) => dock.refresh({ tenant: id }),
		status: dock.status()
	};
}
function useMemberships() {
	return usePermDock().memberships();
}
function useRoles(options = {}) {
	const dock = usePermDock();
	return { roles: (options.team === void 0 ? dock : dock.team(options.team)).roles(options.tenant === void 0 ? void 0 : { tenant: options.tenant }) };
}
function useAssignableRoles() {
	return usePermDock().assignable();
}
function useSubject() {
	const dock = usePermDock();
	const snapshot = dock.snapshot();
	const simulated = typeof snapshot === "object" && snapshot !== null && "simulated" in snapshot && snapshot.simulated === true;
	return {
		principal: dock.subject.principal,
		actor: dock.subject.actor,
		delegation: dock.subject.delegation,
		expiresAt: dock.subject.expiresAt,
		simulated
	};
}
function useApproval(decision) {
	const store = useStore();
	let state = "not-needed";
	if (decision.outcome === "approval-required") state = "required";
	return {
		state,
		token: decision.outcome === "approval-required" ? decision.token : void 0,
		request: (note) => store.requestApproval(decision, note)
	};
}
//#endregion
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
					if (snapshot.tenants.includes(query.tenant) || options.endpoint === void 0) {
						instance = fromSnapshot(snapshot, compact({ tenant }));
						storeStatus = "ready";
						emit();
						return;
					}
				}
				if (options.endpoint === void 0) return;
				storeStatus = "stale";
				emit();
				try {
					const href = new URL(options.endpoint, "https://permdock.local");
					if (query?.tenant !== void 0) href.searchParams.set("tenant", query.tenant);
					const response = await fetchImpl(`${options.endpoint}${href.search}`, {
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
//#region src/react/provider.tsx
function PermDockProvider(props) {
	const store = useMemo(() => createClientStore(compact({
		snapshot: props.snapshot,
		endpoint: props.endpoint,
		approvals: props.approvals,
		tenant: props.tenant,
		fetch: props.fetch,
		headers: props.headers,
		maxAge: props.maxAge,
		verifier: props.verifier
	})), [
		props.snapshot,
		props.endpoint,
		props.approvals,
		props.tenant,
		props.fetch,
		props.headers,
		props.maxAge,
		props.verifier
	]);
	return /* @__PURE__ */ jsx(PermDockStoreContext, {
		value: store,
		children: props.children
	});
}
//#endregion
//#region src/react/protected.tsx
function Protected(props) {
	const root = usePermDock();
	const local = usePermission(props.permission, props.data);
	const run = (dock) => {
		const decision = dock.decide(props.permission, props.data);
		return {
			allowed: decision.outcome === "granted",
			status: "ready",
			decision
		};
	};
	const { allowed, status, decision } = props.tenant === void 0 ? local : run(root.tenant(props.tenant));
	if (status === "pending") return props.pending ?? null;
	if (!allowed || decision.outcome !== "granted") {
		if (typeof props.fallback === "function") return props.fallback(decision);
		return props.fallback ?? null;
	}
	if (typeof props.children === "function") return props.children(decision);
	return props.children;
}
//#endregion
export { PermDockProvider, Protected, approvalHeaders, describe, useApproval, useAssignableRoles, useFilter, useMemberships, usePermDock, usePermission, usePermissions, useRoles, useSubject, useTenant };
