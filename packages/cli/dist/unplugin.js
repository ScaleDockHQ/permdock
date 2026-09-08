import { n as runPluginCollect } from "./plugin-DxEMrHcz.js";
import { createUnplugin } from "unplugin";
//#region src/unplugin.ts
function collectPlugin(options) {
	return {
		name: "permdock-collect",
		buildStart() {
			runPluginCollect(process.cwd(), options, false);
		},
		watchChange() {
			runPluginCollect(process.cwd(), options, false);
		}
	};
}
const createPermDockUnplugin = createUnplugin(collectPlugin);
//#endregion
export { createPermDockUnplugin };
