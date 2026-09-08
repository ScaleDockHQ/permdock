import { C as parseArgs, p as loadConfig, t as runCollect } from "./collect-C-3dZgTM.js";
import { watch } from "node:fs";
//#region src/plugin.ts
function createPermDockPlugin(options) {
	return function withPermDock(nextConfig) {
		const phase = detectPhase();
		if (phase !== "dev" && phase !== "build") return nextConfig;
		const cwd = process.cwd();
		runPluginCollect(cwd, options, phase === "build" && process.env.PERMDOCK_COLLECT !== "write").then((message) => {
			if (message !== void 0) process.stderr.write(`${message}\n`);
		});
		if (phase === "dev") startWatch(cwd, options);
		return nextConfig;
	};
}
async function runPluginCollect(cwd, options, check) {
	const config = await loadConfig(cwd, parseArgs([]));
	const collect = {
		...config.collect,
		...options?.collect
	};
	const result = await runCollect({
		cwd,
		config,
		collect,
		check,
		now: /* @__PURE__ */ new Date(),
		io: {
			stdout: () => void 0,
			stderr: () => void 0
		}
	});
	if (result.code === 0) return;
	if (check && options?.onDrift === "warn") return result.message;
	if (check && result.code === 1) throw new Error(result.message);
	return result.message;
}
function detectPhase() {
	const argv = process.argv.join(" ");
	if (/\bnext\s+start\b|\sstart\b/u.test(argv) && !/\bdev\b/u.test(argv)) return "start";
	if (/\bbuild\b/u.test(argv)) return "build";
	if (/\bdev\b/u.test(argv)) return "dev";
	return "other";
}
function startWatch(cwd, options) {
	const srcPath = options?.collect?.srcPath ?? ["./src"];
	for (const entry of srcPath) try {
		watch(entry, { recursive: true }, () => {
			runPluginCollect(cwd, options, false);
		});
	} catch {}
}
//#endregion
export { runPluginCollect as n, createPermDockPlugin as t };
