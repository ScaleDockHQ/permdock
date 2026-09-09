import { t as describe } from "../describe-BnKr1Gwo.js";
import { t as compact } from "../compact-CxSqQNw0.js";
import { t as approvalHeaders } from "../headers-B5RRv3Xm.js";
import { t as createClientStore } from "../store-BZfhvmrq.js";
import "svelte/internal/disclose-version";
import * as $ from "svelte/internal/client";
import { getContext, onDestroy, setContext } from "svelte";
import { readable } from "svelte/store";
//#region src/svelte/context.ts
const permDockKey = Symbol("permdock");
function createSvelteStore(options) {
	return createClientStore(compact({
		snapshot: options.snapshot,
		endpoint: options.endpoint,
		approvals: options.approvals,
		tenant: options.tenant,
		fetch: options.fetch,
		headers: options.headers,
		maxAge: options.maxAge,
		verifier: options.verifier
	}));
}
function providePermDock(options) {
	const store = createSvelteStore(options);
	setContext(permDockKey, store);
	return store;
}
function getStore() {
	const store = getContext(permDockKey);
	if (store === void 0) throw new Error("PermDock: stores require setPermDock.");
	return store;
}
//#endregion
//#region src/svelte/protected.ts
function protectedView(store, reference, data, tenant, _generation) {
	const local = store.permissionState(reference, data);
	return tenant === void 0 ? {
		allowed: local.allowed,
		status: local.status,
		decision: local.decision,
		slot: slotOf(local.allowed, local.status, local.decision)
	} : tenantView(store.get().tenant(tenant), reference, data);
}
function tenantView(dock, reference, data) {
	const decision = dock.decide(reference, data);
	const allowed = decision.outcome === "granted";
	return {
		allowed,
		status: "ready",
		decision,
		slot: slotOf(allowed, "ready", decision)
	};
}
function slotOf(allowed, status, decision) {
	if (status === "pending") return "pending";
	if (!allowed || decision.outcome !== "granted") return "fallback";
	return "default";
}
//#endregion
//#region src/svelte/Protected.svelte
function Protected$1($$anchor, $$props) {
	$.push($$props, true);
	const store = getStore();
	let tick = $.state(0);
	onDestroy(store.subscribe(() => {
		$.set(tick, $.get(tick) + 1);
	}));
	const view = $.derived(() => {
		const generation = $.get(tick);
		return protectedView(store, $$props.permission, $$props.data, $$props.tenant, generation);
	});
	var fragment = $.comment();
	var node = $.first_child(fragment);
	var consequent = ($$anchor) => {
		var fragment_1 = $.comment();
		var node_1 = $.first_child(fragment_1);
		$.snippet(node_1, () => $$props.pending ?? $.noop);
		$.append($$anchor, fragment_1);
	};
	var consequent_1 = ($$anchor) => {
		var fragment_2 = $.comment();
		var node_2 = $.first_child(fragment_2);
		$.snippet(node_2, () => $$props.fallback ?? $.noop, () => $.get(view).decision);
		$.append($$anchor, fragment_2);
	};
	var alternate = ($$anchor) => {
		var fragment_3 = $.comment();
		var node_3 = $.first_child(fragment_3);
		$.snippet(node_3, () => $$props.children ?? $.noop, () => $.get(view).decision);
		$.append($$anchor, fragment_3);
	};
	$.if(node, ($$render) => {
		if ($.get(view).slot === "pending") $$render(consequent);
		else if ($.get(view).slot === "fallback") $$render(consequent_1, 1);
		else $$render(alternate, -1);
	});
	$.append($$anchor, fragment);
	$.pop();
}
//#endregion
//#region src/svelte/stores.ts
function fromStore(store, compute) {
	return readable(compute(), (set) => store.subscribe(() => {
		set(compute());
	}));
}
function sveltePermDock(store) {
	return new Proxy({}, { get(_target, prop, _receiver) {
		return Reflect.get(store.get(), prop);
	} });
}
function setPermDock(options) {
	return sveltePermDock(providePermDock(options));
}
function getPermDock() {
	return sveltePermDock(getStore());
}
function permission(reference, data) {
	return permissionFor(getStore(), reference, data);
}
function permissionFor(store, reference, data) {
	return fromStore(store, () => store.permissionState(reference, data?.()));
}
function permissions(references, data) {
	return permissionsFor(getStore(), references, data);
}
function permissionsFor(store, references, data) {
	return fromStore(store, () => {
		const granted = [];
		const byKey = {};
		for (const reference of references()) {
			const next = store.permissionState(reference, data?.());
			byKey[reference.key] = next;
			if (next.allowed) granted.push(reference);
		}
		return new Proxy({
			granted,
			get(reference) {
				return byKey[reference.key];
			}
		}, { get(target, prop, receiver) {
			if (typeof prop === "string" && Object.hasOwn(byKey, prop)) return byKey[prop];
			return Reflect.get(target, prop, receiver);
		} });
	});
}
function filtered(reference, rows) {
	return filteredFor(getStore(), reference, rows);
}
function filteredFor(store, reference, rows) {
	return fromStore(store, () => {
		const dock = store.get();
		const next = dock.filter(reference, rows());
		next.partial = dock.where(reference).partial;
		return next;
	});
}
function tenant() {
	return tenantFor(getStore());
}
function tenantFor(store) {
	return fromStore(store, () => {
		const dock = store.get();
		return {
			tenant: dock.subject.principal?.tenant ?? null,
			tenants: dock.tenants(),
			switchTo: (id) => dock.refresh({ tenant: id }),
			status: dock.status()
		};
	});
}
function memberships() {
	return membershipsFor(getStore());
}
function membershipsFor(store) {
	return fromStore(store, () => store.get().memberships());
}
function roles(options = () => ({})) {
	return rolesFor(getStore(), options);
}
function rolesFor(store, options = () => ({})) {
	return fromStore(store, () => {
		const next = options();
		const dock = store.get();
		return { roles: (next.team === void 0 ? dock : dock.team(next.team)).roles(next.tenant === void 0 ? void 0 : { tenant: next.tenant }) };
	});
}
function assignable() {
	return assignableFor(getStore());
}
function assignableFor(store) {
	return fromStore(store, () => store.get().assignable());
}
function subject() {
	return subjectFor(getStore());
}
function subjectFor(store) {
	return fromStore(store, () => {
		const dock = store.get();
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
function approval(decision) {
	return approvalFor(getStore(), decision);
}
function approvalFor(store, decision) {
	return fromStore(store, () => {
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
//#region src/svelte/index.ts
const Protected = Protected$1;
//#endregion
export { Protected, approval, approvalHeaders, assignable, describe, filtered, getPermDock, memberships, permission, permissions, roles, setPermDock, subject, tenant };
