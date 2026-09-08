"use client";
import { t as describe } from "../describe-BnKr1Gwo.js";
import { n as PermDockStoreContext, t as PermDockProvider } from "../provider-Dn7rIOpX.js";
import { use, useMemo, useSyncExternalStore } from "react";
//#region src/react/headers.ts
function approvalHeaders(token) {
	return { "PermDock-Approval": token };
}
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
