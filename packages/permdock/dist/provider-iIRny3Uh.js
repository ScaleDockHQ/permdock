import { t as compact } from "./compact-CxCColYy.js";
import { t as PermDockStoreContext } from "./context-Cr1ZrdTc.js";
import { t as createClientStore } from "./store-CaobVAvm.js";
import { useMemo } from "react";
import { jsx } from "react/jsx-runtime";
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
export { PermDockProvider as t };
