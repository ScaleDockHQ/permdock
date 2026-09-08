"use client";
import { n as parseSnapshot } from "../snapshot-N9NikhGh.js";
import { t as compact } from "../compact-CxCColYy.js";
import { t as describe } from "../describe-BnKr1Gwo.js";
import { t as emptySnapshot } from "../from-snapshot-DhMzBTA7.js";
import { t as approvalHeaders } from "../headers-B5RRv3Xm.js";
import { t as PermDockStoreContext } from "../context-Cr1ZrdTc.js";
import { a as useMemberships, c as usePermissions, d as useTenant, i as useFilter, l as useRoles, n as useApproval, o as usePermDock, r as useAssignableRoles, s as usePermission, t as Protected, u as useSubject } from "../protected-CH1lha8g.js";
import { t as createClientStore } from "../store-CaobVAvm.js";
import { useEffect, useMemo } from "react";
import { jsx } from "react/jsx-runtime";
//#region src/react-native/storage.ts
const SNAPSHOT_KEY = "permdock.snapshot";
const TENANT_KEY = "permdock.tenant";
function memoryStorage(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem(key) {
			return map.get(key) ?? null;
		},
		setItem(key, value) {
			map.set(key, value);
		},
		removeItem(key) {
			map.delete(key);
		}
	};
}
function isThenable(value) {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}
function acceptSnapshot(raw, subjectId) {
	if (raw === null || raw.length === 0) return;
	try {
		const snapshot = parseSnapshot(JSON.parse(raw));
		const id = snapshot.subject.principal?.id;
		if (subjectId !== void 0 && id !== subjectId) return;
		return snapshot;
	} catch {
		return;
	}
}
async function readStored(storage, subjectId) {
	const raw = await Promise.resolve(storage.getItem(SNAPSHOT_KEY));
	const tenantRaw = await Promise.resolve(storage.getItem(TENANT_KEY));
	return {
		snapshot: acceptSnapshot(raw, subjectId),
		tenant: tenantRaw === null || tenantRaw.length === 0 ? void 0 : tenantRaw
	};
}
function readStoredSync(storage, subjectId) {
	const raw = storage.getItem(SNAPSHOT_KEY);
	const tenantRaw = storage.getItem(TENANT_KEY);
	if (isThenable(raw) || isThenable(tenantRaw)) return;
	return {
		snapshot: acceptSnapshot(raw, subjectId),
		tenant: tenantRaw === null || tenantRaw.length === 0 ? void 0 : tenantRaw
	};
}
function persistSnapshot(storage, snapshot, tenant) {
	const write = storage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
	if (isThenable(write)) write.catch(() => void 0);
	if (tenant === void 0) return;
	const next = storage.setItem(TENANT_KEY, tenant);
	if (isThenable(next)) next.catch(() => void 0);
}
function clearStorage(storage) {
	const snap = storage.removeItem(SNAPSHOT_KEY);
	if (isThenable(snap)) snap.catch(() => void 0);
	const tenant = storage.removeItem(TENANT_KEY);
	if (isThenable(tenant)) tenant.catch(() => void 0);
}
//#endregion
//#region src/react-native/store.ts
function createNativeStore(options) {
	const seeded = options.snapshot === void 0 ? void 0 : typeof options.snapshot === "string" ? acceptSnapshot(options.snapshot, options.subjectId) : acceptSnapshot(JSON.stringify(options.snapshot), options.subjectId);
	const sync = readStoredSync(options.storage, options.subjectId);
	const snapshot = seeded ?? sync?.snapshot ?? emptySnapshot();
	const tenant = options.tenant ?? sync?.tenant;
	const store = createClientStore(compact({
		snapshot,
		endpoint: options.endpoint,
		snapshotUrl: options.snapshotUrl,
		approvals: options.approvals,
		tenant,
		fetch: options.fetch,
		headers: options.headers,
		maxAge: options.maxAge,
		verifier: options.verifier,
		onSnapshot: (next, nextTenant) => {
			persistSnapshot(options.storage, next, nextTenant);
		},
		onClear: () => {
			clearStorage(options.storage);
		}
	}));
	if (sync === void 0 && seeded === void 0) readStored(options.storage, options.subjectId).then((stored) => {
		if (stored.snapshot !== void 0) store.replace(stored.snapshot);
	});
	return store;
}
//#endregion
//#region src/react-native/provider.tsx
function PermDockProvider(props) {
	const store = useMemo(() => createNativeStore(compact({
		storage: props.storage,
		snapshot: props.snapshot,
		snapshotUrl: props.snapshotUrl,
		endpoint: props.endpoint,
		approvals: props.approvals,
		tenant: props.tenant,
		subjectId: props.subjectId,
		revalidate: props.revalidate,
		subscribeForeground: props.subscribeForeground,
		fetch: props.fetch,
		headers: props.headers,
		maxAge: props.maxAge,
		verifier: props.verifier
	})), [
		props.storage,
		props.snapshot,
		props.snapshotUrl,
		props.endpoint,
		props.approvals,
		props.tenant,
		props.subjectId,
		props.revalidate,
		props.subscribeForeground,
		props.fetch,
		props.headers,
		props.maxAge,
		props.verifier
	]);
	useEffect(() => {
		const mode = props.revalidate ?? "launch";
		const refresh = () => {
			if (props.snapshotUrl === void 0) return;
			store.get().refresh().catch(() => void 0);
		};
		if (mode === "launch" || mode === "focus" || typeof mode === "number") refresh();
		if (typeof mode === "number") {
			const timer = setInterval(refresh, mode * 1e3);
			return () => {
				clearInterval(timer);
			};
		}
		if (mode === "focus" && props.subscribeForeground !== void 0) return props.subscribeForeground(refresh);
	}, [
		store,
		props.revalidate,
		props.snapshotUrl,
		props.subscribeForeground
	]);
	return /* @__PURE__ */ jsx(PermDockStoreContext, {
		value: store,
		children: props.children
	});
}
//#endregion
export { PermDockProvider, Protected, approvalHeaders, createNativeStore, describe, memoryStorage, useApproval, useAssignableRoles, useFilter, useMemberships, usePermDock, usePermission, usePermissions, useRoles, useSubject, useTenant };
