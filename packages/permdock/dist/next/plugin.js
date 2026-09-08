import { createRequire } from "node:module";
//#region src/next/plugin.ts
const noop = () => {
	return function withPermDock(nextConfig) {
		return nextConfig;
	};
};
function loadCliPlugin() {
	try {
		return createRequire(import.meta.url)("@permdock/cli").createPermDockPlugin ?? noop;
	} catch {
		return noop;
	}
}
function createPermDockPlugin(options) {
	return loadCliPlugin()(options);
}
//#endregion
export { createPermDockPlugin };
