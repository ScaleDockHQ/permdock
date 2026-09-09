#!/usr/bin/env node
import { t as run } from "./run-DSSE198p.js";
//#region src/bin.ts
const result = await run(process.argv.slice(2), { io: {
	stdout: (text) => {
		process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
	},
	stderr: (text) => {
		process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
	}
} });
process.exitCode = result.code;
//#endregion
