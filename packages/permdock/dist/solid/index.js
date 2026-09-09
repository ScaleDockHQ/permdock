import { t as describe } from "../describe-BnKr1Gwo.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { t as approvalHeaders } from "../headers-B5RRv3Xm.js";
import { t as createClientStore } from "../store-T0ey-Ruh.js";
import { createComponent, createContext, createMemo, createSignal, onCleanup, useContext } from "solid-js";
//#region src/solid/context.ts
const PermDockContext = createContext(void 0);
function useStore() {
	const store = useContext(PermDockContext);
	if (store === void 0) throw new Error("PermDock: hooks require <PermDockProvider>.");
	return store;
}
//#endregion
//#region src/solid/hooks.ts
function useVersion(store) {
	const [tick, setTick] = createSignal(0);
	onCleanup(store.subscribe(() => {
		setTick((current) => current + 1);
	}));
	return tick;
}
function usePermDock() {
	const store = useStore();
	const version = useVersion(store);
	return new Proxy({}, { get(_target, prop, _receiver) {
		version();
		return Reflect.get(store.get(), prop);
	} });
}
function usePermission(permission, data) {
	const store = useStore();
	const version = useVersion(store);
	return createMemo(() => {
		version();
		return store.permissionState(permission, data?.());
	});
}
function usePermissions(permissions, data) {
	const store = useStore();
	const version = useVersion(store);
	return createMemo(() => {
		version();
		const granted = [];
		const byKey = {};
		for (const permission of permissions()) {
			const next = store.permissionState(permission, data?.());
			byKey[permission.key] = next;
			if (next.allowed) granted.push(permission);
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
	});
}
function useFilter(permission, rows) {
	const dock = usePermDock();
	return createMemo(() => {
		const next = dock.filter(permission, rows());
		next.partial = dock.where(permission).partial;
		return next;
	});
}
function useTenant() {
	const dock = usePermDock();
	return createMemo(() => ({
		tenant: dock.subject.principal?.tenant ?? null,
		tenants: dock.tenants(),
		switchTo: (id) => dock.refresh({ tenant: id }),
		status: dock.status()
	}));
}
function useMemberships() {
	const dock = usePermDock();
	return createMemo(() => dock.memberships());
}
function useRoles(options = () => ({})) {
	const dock = usePermDock();
	return createMemo(() => {
		const next = options();
		return { roles: (next.team === void 0 ? dock : dock.team(next.team)).roles(next.tenant === void 0 ? void 0 : { tenant: next.tenant }) };
	});
}
function useAssignableRoles() {
	const dock = usePermDock();
	return createMemo(() => dock.assignable());
}
function useSubject() {
	const dock = usePermDock();
	return createMemo(() => {
		const snapshot = dock.snapshot();
		const simulated = typeof snapshot === "object" && snapshot !== null && "simulated" in snapshot && snapshot.simulated === true;
		return {
			principal: dock.subject.principal,
			actor: dock.subject.actor,
			delegation: dock.subject.delegation,
			expiresAt: dock.subject.expiresAt,
			simulated
		};
	});
}
function useApproval(decision) {
	const store = useStore();
	return createMemo(() => {
		const next = decision();
		let state = "not-needed";
		if (next.outcome === "approval-required") state = "required";
		return {
			state,
			token: next.outcome === "approval-required" ? next.token : void 0,
			request: (note) => store.requestApproval(next, note)
		};
	});
}
//#endregion
//#region src/solid/protected.ts
function Protected(props) {
	const root = usePermDock();
	const local = usePermission(props.permission, () => props.data);
	const view = createMemo(() => {
		if (props.tenant === void 0) return local();
		return tenantView(root.tenant(props.tenant), props.permission, props.data);
	});
	return () => {
		const scoped = view();
		if (scoped.status === "pending") return props.pending ?? null;
		if (!scoped.allowed || scoped.decision.outcome !== "granted") {
			if (typeof props.fallback === "function") return props.fallback(scoped.decision);
			return props.fallback ?? null;
		}
		if (typeof props.children === "function") return props.children(scoped.decision);
		return props.children;
	};
}
function tenantView(dock, permission, data) {
	const decision = dock.decide(permission, data);
	return {
		allowed: decision.outcome === "granted",
		status: "ready",
		decision
	};
}
//#endregion
//#region src/solid/provider.ts
function PermDockProvider(props) {
	const store = createClientStore(compact({
		snapshot: props.snapshot,
		endpoint: props.endpoint,
		approvals: props.approvals,
		tenant: props.tenant,
		fetch: props.fetch,
		headers: props.headers,
		maxAge: props.maxAge,
		verifier: props.verifier
	}));
	return createComponent(PermDockContext.Provider, {
		value: store,
		get children() {
			return props.children;
		}
	});
}
//#endregion
export { PermDockProvider, Protected, approvalHeaders, describe, useApproval, useAssignableRoles, useFilter, useMemberships, usePermDock, usePermission, usePermissions, useRoles, useSubject, useTenant };
