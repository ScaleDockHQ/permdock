import { C as parseArgs, S as flagString, _ as leavesOf, a as rel, b as flagBool, c as formatCatalogJson, d as USAGE_REPORT_SCHEMA, g as asPolicy, h as asPermissionTree, i as listSourceFiles, l as formatCatalogMarkdown, m as resolveCwd, n as scanSources, o as buildCatalog, p as loadConfig, r as defaultSrcPath, s as catalogSchemaDocument, t as runCollect, u as DOCTOR_REPORT_SCHEMA, v as loadModule, x as flagList, y as pickNamed } from "./collect-DLxRBLet.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
//#region src/catalog.ts
async function runCatalog(input) {
	if (input.format === "schema") return {
		code: 0,
		output: `${JSON.stringify(catalogSchemaDocument(), null, 2)}\n`
	};
	const from = input.from ?? input.config.permissions;
	let document;
	if (from !== void 0) {
		const abs = resolve(input.cwd, from);
		if (!existsSync(abs)) return {
			code: 2,
			output: `PermDock CLI: module not found: ${from}`
		};
		const tree = asPermissionTree(pickNamed(await loadModule(abs), ["permissions"]));
		const srcPath = input.config.collect?.srcPath ?? defaultSrcPath();
		const files = listSourceFiles(input.cwd, srcPath);
		const scan = scanSources(input.cwd, files, new Set(leavesOf(tree).map((leaf) => leaf.key)));
		document = buildCatalog(tree, scan, input.now.toISOString());
	} else {
		const collected = await runCollect({
			cwd: input.cwd,
			config: input.config,
			collect: input.config.collect ?? {},
			check: false,
			now: input.now,
			io: input.io
		});
		if (collected.document === void 0) return {
			code: collected.code,
			output: collected.message
		};
		document = collected.document;
	}
	const filtered = input.include.length === 0 ? document : {
		...document,
		permissions: document.permissions.filter((permission) => input.include.some((prefix) => permission.key === prefix || permission.key.startsWith(`${prefix}.`) || permission.resource === prefix))
	};
	if (input.format === "markdown") return {
		code: 0,
		output: formatCatalogMarkdown(filtered)
	};
	return {
		code: 0,
		output: formatCatalogJson(filtered)
	};
}
//#endregion
//#region src/skills.ts
const SKILL_NAMES = ["wire-permdock", "audit-permissions"];
const AGENT_FOLDERS = {
	agents: ".agents/skills",
	claude: ".claude/skills",
	cursor: ".cursor/skills"
};
function runSkills(input) {
	switch (input.action) {
		case void 0:
		case "install":
		case "update": return runSkillsInstall({
			cwd: input.cwd,
			agents: input.agents
		});
		case "list": return listSkills(input.cwd);
		default: return {
			code: 2,
			output: `unknown skills command '${input.action}'. Use install, list or update.`
		};
	}
}
function runSkillsInstall(input) {
	const source = resolveSkillsRoot(input.cwd);
	if (source === void 0) return {
		code: 2,
		output: "PermDock CLI: permdock package with skills/ not found. Add permdock as a dependency."
	};
	const version = readPermdockVersion(source);
	const targets = resolveTargets(input.agents);
	const copied = [];
	for (const folder of targets) {
		const destRoot = join(input.cwd, folder);
		for (const name of SKILL_NAMES) {
			const from = join(source, name);
			if (!existsSync(from)) continue;
			copyDir(from, join(destRoot, name));
			copied.push(`${folder}/${name}`);
		}
	}
	mkdirSync(join(input.cwd, ".permdock"), { recursive: true });
	writeFileSync(join(input.cwd, ".permdock/skills-lock.json"), `${JSON.stringify({
		version,
		skills: [...SKILL_NAMES]
	}, null, 2)}\n`);
	return {
		code: 0,
		output: `installed ${copied.join(", ") || "no skills"} (permdock@${version})`
	};
}
function listSkills(cwd) {
	const lockPath = join(cwd, ".permdock/skills-lock.json");
	const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : {};
	const lines = ["permdock skills", ""];
	for (const name of SKILL_NAMES) {
		const places = Object.values(AGENT_FOLDERS).filter((folder) => existsSync(join(cwd, folder, name, "SKILL.md")));
		lines.push(`  ${name}  ${places.length > 0 ? places.join(", ") : "not installed"}`);
	}
	if (lock.version !== void 0) lines.push("", `  lock ${lock.version}`);
	return {
		code: 0,
		output: `${lines.join("\n")}\n`
	};
}
function resolveTargets(agents) {
	if (agents.length === 0) return Object.values(AGENT_FOLDERS);
	return agents.map((agent) => {
		const key = agent === "agent" ? "agents" : agent;
		return AGENT_FOLDERS[key] ?? `.${key}/skills`;
	});
}
function resolveSkillsRoot(cwd) {
	try {
		const pkg = createRequire(resolve(cwd, "package.json")).resolve("permdock/package.json");
		const root = join(dirname(pkg), "skills");
		if (existsSync(root)) return root;
	} catch {}
	const local = join(cwd, "node_modules/permdock/skills");
	return existsSync(local) ? local : void 0;
}
function readPermdockVersion(skillsRoot) {
	const pkg = join(dirname(skillsRoot), "package.json");
	if (!existsSync(pkg)) return "0.0.0";
	return JSON.parse(readFileSync(pkg, "utf8")).version;
}
function copyDir(from, to) {
	mkdirSync(to, { recursive: true });
	for (const name of readdirSync(from)) {
		const source = join(from, name);
		const dest = join(to, name);
		const text = readFileSync(source);
		writeFileSync(dest, text);
	}
}
//#endregion
//#region src/usage.ts
async function runUsage(input) {
	const collected = await runCollect({
		cwd: input.cwd,
		config: input.config,
		collect: input.config.collect ?? {},
		check: false,
		now: input.now,
		io: input.io
	});
	if (collected.document === void 0 || collected.scan === void 0) return {
		code: 2,
		output: collected.message
	};
	const policyRel = input.config.policy;
	if (policyRel === void 0) return {
		code: 2,
		output: "usage: set policy in permdock.config.ts"
	};
	const policyAbs = resolve(input.cwd, policyRel);
	if (!existsSync(policyAbs)) return {
		code: 2,
		output: `PermDock CLI: policy module not found: ${policyRel}`
	};
	const policy = asPolicy(pickNamed(await loadModule(policyAbs), ["policy"]));
	const granted = /* @__PURE__ */ new Set();
	const mergedRoles = /* @__PURE__ */ new Set();
	for (const role of policy.roles) {
		mergedRoles.add(role.name);
		for (const grant of role.grants) if (grant.effect === "allow") granted.add(grant.permission.key);
	}
	const used = /* @__PURE__ */ new Set();
	const usedAt = {};
	for (const permission of collected.document.permissions) if (permission.usages.some((usage) => usage.call !== "allow")) {
		used.add(permission.key);
		usedAt[permission.key] = permission.usages;
	}
	const unused = [];
	const ungranted = [];
	const noRole = [];
	const dynamic = [];
	for (const permission of collected.document.permissions) {
		const key = permission.key;
		if (ignored(key, input.ignore)) continue;
		if (!used.has(key) && !input.dynamicAsUsed) unused.push({
			kind: "unused",
			key,
			detail: permission.usages[0]?.file ?? "defined"
		});
		if (used.has(key) && !granted.has(key)) {
			const site = usedAt[key]?.[0];
			ungranted.push({
				kind: "ungranted",
				key,
				detail: site === void 0 ? "checked" : `${site.file}:${String(site.line)} (${site.call})`
			});
		}
	}
	for (const name of collected.scan.roleNames) if (!mergedRoles.has(name)) noRole.push({
		kind: "no-role",
		key: name,
		detail: `role '${name}' not passed to definePolicy`
	});
	for (const site of collected.scan.dynamic) dynamic.push({
		kind: "dynamic",
		key: "*",
		detail: `${site.file}:${String(site.line)} (${site.call})`
	});
	const report = {
		$schema: USAGE_REPORT_SCHEMA,
		unused,
		ungranted,
		noRole,
		dynamic,
		warnings: unused.length + ungranted.length + dynamic.length,
		errors: noRole.length
	};
	return {
		code: report.errors > 0 || input.strict && report.warnings > 0 ? 1 : 0,
		output: input.json ? `${JSON.stringify(report, null, 2)}\n` : formatUsage(report)
	};
}
function ignored(key, patterns) {
	return patterns.some((pattern) => {
		if (pattern.endsWith(".*")) return key.startsWith(pattern.slice(0, -2));
		return key === pattern;
	});
}
function formatUsage(report) {
	const lines = ["permdock usage", ""];
	lines.push(`  defined but unused (${String(report.unused.length)})`);
	for (const finding of report.unused) lines.push(`    ${finding.key.padEnd(28)} ${finding.detail}`);
	lines.push("");
	lines.push(`  used but ungranted (${String(report.ungranted.length)})`);
	for (const finding of report.ungranted) lines.push(`    ${finding.key.padEnd(28)} ${finding.detail}`);
	lines.push("");
	lines.push(`  granted by no role (${String(report.noRole.length)})`);
	for (const finding of report.noRole) lines.push(`    ${finding.key.padEnd(28)} ${finding.detail}`);
	if (report.dynamic.length > 0) {
		lines.push("");
		lines.push(`  dynamic (${String(report.dynamic.length)})`);
		for (const finding of report.dynamic) lines.push(`    ${finding.detail}`);
	}
	lines.push("");
	lines.push(`  ${String(report.warnings)} warning${report.warnings === 1 ? "" : "s"}, ${String(report.errors)} error${report.errors === 1 ? "" : "s"}`);
	return `${lines.join("\n")}\n`;
}
//#endregion
//#region src/doctor.ts
const SERVER_SPECIFIERS = [
	"permdock/server",
	"permdock/next",
	"permdock/hono",
	"permdock/mcp",
	"permdock/approvals",
	"permdock/jwt",
	"permdock/ai-sdk",
	"permdock/claude-agent",
	"permdock/eve",
	"permdock/openai"
];
const ADAPTER_SPECIFIERS = [
	"permdock/hono",
	"permdock/next",
	"permdock/mcp",
	"permdock/ai-sdk",
	"permdock/claude-agent",
	"permdock/express",
	"permdock/fastify"
];
const UNTRUSTED_CLAIMS = [
	"user_metadata",
	"unsafeMetadata",
	"untrusted_metadata",
	"clientMetadata",
	"preferred_username"
];
async function runDoctor(input) {
	if (input.fix) {
		runSkillsInstall({
			cwd: input.cwd,
			agents: []
		});
		await runCollect({
			cwd: input.cwd,
			config: input.config,
			collect: input.config.collect ?? {},
			check: false,
			now: input.now,
			io: input.io
		});
	}
	const findings = [];
	const wanted = new Set(input.only);
	const include = (group) => wanted.size === 0 || wanted.has(group) || wanted.has(group.toLowerCase());
	const srcPath = input.config.collect?.srcPath ?? defaultSrcPath();
	const sources = listSourceFiles(input.cwd, srcPath).map((file) => ({
		file: rel(input.cwd, file),
		text: readFileSync(file, "utf8")
	}));
	if (include("imports") || include("PD001")) findings.push(...pd001(sources));
	if (include("references") || include("PD002")) findings.push(...await pd002(input));
	if (include("ungranted") || include("PD003")) findings.push(...await pd003(input));
	if (include("catalog") || include("PD004")) findings.push(...await pd004(input));
	if (include("skills") || include("PD005")) findings.push(...pd005(input.cwd));
	if (include("typescript") || include("PD006")) findings.push(...pd006(input.cwd));
	if (include("validation") || include("PD007")) findings.push(...pd007(sources));
	if (include("naming") || include("PD008")) findings.push(...pd008(sources));
	if (include("duplicates") || include("PD009")) findings.push(...pd009(input.cwd));
	if (include("claims") || include("PD010")) findings.push(...pd010(sources));
	if (include("tenant") || include("PD011")) findings.push(...pd011(sources));
	if (include("drafts") || include("PD012")) findings.push(...pd012(input.cwd, input.config));
	if (include("algorithms") || include("PD013")) findings.push(...pd013(sources));
	if (include("discovery") || include("PD014")) findings.push(...pd014(sources));
	if (include("typ") || include("PD015")) findings.push(...pd015(sources));
	const errors = findings.filter((item) => item.severity === "error").length;
	const warnings = findings.filter((item) => item.severity === "warning").length;
	const report = {
		$schema: DOCTOR_REPORT_SCHEMA,
		findings,
		errors,
		warnings
	};
	return {
		code: errors > 0 || input.strict && warnings > 0 ? 1 : 0,
		output: input.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctor(report, input.color)
	};
}
function pd001(sources) {
	const findings = [];
	for (const source of sources) {
		if (!(source.text.includes("'use client'") || source.text.includes("\"use client\"") || source.file.includes(".client."))) continue;
		for (const spec of SERVER_SPECIFIERS) if (source.text.includes(`'${spec}'`) || source.text.includes(`"${spec}"`)) findings.push({
			code: "PD001",
			severity: "error",
			message: `${source.file} imports ${spec}`,
			fix: "move the check into a Server Component or import from 'permdock/react'"
		});
	}
	return findings;
}
async function pd002(input) {
	const collected = await runCollect({
		cwd: input.cwd,
		config: input.config,
		collect: input.config.collect ?? {},
		check: false,
		now: input.now,
		io: input.io
	});
	if (collected.scan === void 0) return [];
	return collected.scan.unknown.map((usage) => ({
		code: "PD002",
		severity: "error",
		message: `unknown permission ${usage.call} at ${usage.file}:${String(usage.line)}`,
		fix: "use a defined permission reference"
	}));
}
async function pd003(input) {
	if (input.config.policy === void 0) return [];
	const usage = await runUsage({
		cwd: input.cwd,
		config: input.config,
		ignore: [],
		strict: false,
		json: true,
		dynamicAsUsed: false,
		now: input.now,
		io: input.io
	});
	if (usage.code === 2) return [];
	return JSON.parse(usage.output).ungranted.map((item) => ({
		code: "PD003",
		severity: "warning",
		message: `${item.key} is used but never granted (${item.detail})`,
		fix: "add an allow() for this permission to a role passed to definePolicy"
	}));
}
async function pd004(input) {
	const collected = await runCollect({
		cwd: input.cwd,
		config: input.config,
		collect: input.config.collect ?? {},
		check: true,
		now: input.now,
		io: input.io
	});
	if (collected.code === 0) return [];
	if (collected.code === 2) return [];
	return [{
		code: "PD004",
		severity: "error",
		message: collected.message,
		fix: "pnpm exec permdock collect"
	}];
}
function pd005(cwd) {
	const lockPath = join(cwd, ".permdock/skills-lock.json");
	if (![
		join(cwd, ".agents/skills"),
		join(cwd, ".claude/skills"),
		join(cwd, ".cursor/skills")
	].some((folder) => existsSync(join(folder, "wire-permdock/SKILL.md")))) return [{
		code: "PD005",
		severity: "warning",
		message: "Agent Skills are not installed",
		fix: "pnpm exec permdock skills install"
	}];
	if (!existsSync(lockPath)) return [{
		code: "PD005",
		severity: "warning",
		message: "skills lock is missing",
		fix: "pnpm exec permdock skills install"
	}];
	return [];
}
function pd006(cwd) {
	try {
		const pkg = createRequire(resolve(cwd, "package.json"))("typescript/package.json");
		const major = Number(pkg.version.split(".")[0]);
		if (major < 5 || major === 5 && Number(pkg.version.split(".")[1]) < 9) return [{
			code: "PD006",
			severity: "error",
			message: `TypeScript ${pkg.version} is below the supported matrix (5.9, 6, 7)`,
			fix: "upgrade typescript to 5.9 or later"
		}];
		if (major > 7) return [{
			code: "PD006",
			severity: "error",
			message: `TypeScript ${pkg.version} is not in the supported matrix (5.9, 6, 7)`,
			fix: "use TypeScript 5.9, 6 or 7"
		}];
		return [];
	} catch {
		return [{
			code: "PD006",
			severity: "error",
			message: "typescript is not installed",
			fix: "add typescript 5.9, 6 or 7"
		}];
	}
}
function pd007(sources) {
	const hasNever = sources.some((source) => /validate\s*:\s*['"]never['"]/u.test(source.text));
	const hasAdapter = sources.some((source) => ADAPTER_SPECIFIERS.some((spec) => source.text.includes(spec)));
	if (hasNever && hasAdapter) return [{
		code: "PD007",
		severity: "warning",
		message: "policy sets validate: 'never' while an HTTP, MCP or agent adapter is imported",
		fix: "use validate: 'boundary' for untrusted input"
	}];
	return [];
}
function pd008(sources) {
	const findings = [];
	for (const source of sources) {
		if (!source.text.includes("permdock")) continue;
		if (/export\s+(?:const|function|class)\s+(?:dock|ability)\b/u.test(source.text)) findings.push({
			code: "PD008",
			severity: "warning",
			message: `${source.file} exports a reserved name (dock or ability)`,
			fix: "use createPermDock and permdock"
		});
		if (/export\s+(?:const|function|type|interface)\s+\$/u.test(source.text)) findings.push({
			code: "PD008",
			severity: "warning",
			message: `${source.file} exports a $ prefixed member`,
			fix: "drop the $ prefix"
		});
	}
	return findings;
}
function pd009(cwd) {
	const copies = [];
	function walk(dir, depth) {
		if (depth > 6 || !existsSync(dir)) return;
		const pkg = join(dir, "node_modules/permdock/package.json");
		if (existsSync(pkg)) copies.push(pkg);
		if (!existsSync(join(dir, "node_modules"))) return;
		for (const name of readdirSync(join(dir, "node_modules"))) {
			if (name.startsWith(".")) continue;
			const nested = join(dir, "node_modules", name);
			try {
				if (statSync(nested).isDirectory()) walk(nested, depth + 1);
			} catch {}
		}
	}
	walk(cwd, 0);
	if (copies.length > 1) return [{
		code: "PD009",
		severity: "error",
		message: `duplicate permdock copies: ${copies.map((item) => rel(cwd, dirname(dirname(item)))).join(", ")}`,
		fix: "dedupe so only one permdock version is installed"
	}];
	return [];
}
function pd010(sources) {
	const findings = [];
	for (const source of sources) for (const claim of UNTRUSTED_CLAIMS) if (source.text.includes(claim) && /roles|tenant/u.test(source.text)) findings.push({
		code: "PD010",
		severity: "error",
		message: `${source.file} reads roles or tenant from ${claim}`,
		fix: "use a server-set claim or a MembershipSource"
	});
	return findings;
}
function pd011(sources) {
	const findings = [];
	for (const source of sources) if (/tenant['"]?\s*:\s*['"]hd['"]/u.test(source.text) || /accounts\.google\.com/u.test(source.text) && /tenant/.test(source.text)) findings.push({
		code: "PD011",
		severity: "warning",
		message: `${source.file} reads tenant from an optional issuer claim`,
		fix: "compare the claim to onboarded tenants; do not default a tenant"
	});
	return findings;
}
function pd012(cwd, config) {
	const docs = config.openapi?.doc ?? [];
	const findings = [];
	for (const doc of docs) {
		const abs = resolve(cwd, doc);
		if (!existsSync(abs)) continue;
		const text = readFileSync(abs, "utf8");
		if (text.includes("\"drafts\"") && !text.includes("overlay")) findings.push({
			code: "PD012",
			severity: "warning",
			message: `${doc} carries a draft pin the CLI no longer emits`,
			fix: "regenerate with permdock openapi"
		});
	}
	return findings;
}
function pd013(sources) {
	const findings = [];
	for (const source of sources) {
		if (/algorithms[\s\S]{0,120}EdDSA/u.test(source.text)) findings.push({
			code: "PD013",
			severity: "warning",
			message: `${source.file} lists polymorphic EdDSA`,
			fix: "write Ed25519"
		});
		if (/algorithms[\s\S]{0,120}['"]none['"]/u.test(source.text)) findings.push({
			code: "PD013",
			severity: "error",
			message: `${source.file} allows alg none`,
			fix: "remove none and RSA1_5 from algorithms"
		});
	}
	return findings;
}
function pd014(sources) {
	const findings = [];
	for (const source of sources) {
		if (/discovery:\s*['"]http:/u.test(source.text)) findings.push({
			code: "PD014",
			severity: "error",
			message: `${source.file} uses a plain-HTTP discovery URL`,
			fix: "use an https: issuer"
		});
		if (/discovery\s*:/u.test(source.text) && /jwks\s*:/u.test(source.text)) findings.push({
			code: "PD014",
			severity: "error",
			message: `${source.file} sets discovery together with jwks or issuer`,
			fix: "use discovery alone, or jwks plus issuer"
		});
		if (/jwks\s*:/u.test(source.text) && !/issuer\s*:/u.test(source.text) && !/discovery\s*:/u.test(source.text)) findings.push({
			code: "PD014",
			severity: "error",
			message: `${source.file} sets jwks without issuer`,
			fix: "set issuer with jwks, or switch to discovery"
		});
	}
	return findings;
}
function pd015(sources) {
	const findings = [];
	for (const source of sources) if (/accept:\s*['"]id-token['"]/u.test(source.text)) findings.push({
		code: "PD015",
		severity: "warning",
		message: `${source.file} accepts id-token on what looks like an API resolver`,
		fix: "leave accept as 'access-token' for API routes"
	});
	return findings;
}
function formatDoctor(report, color) {
	const errorMark = color ? "✖" : "error";
	const warnMark = color ? "⚠" : "warn";
	const lines = ["permdock doctor", ""];
	for (const finding of report.findings) {
		const mark = finding.severity === "error" ? errorMark : warnMark;
		lines.push(`  ${mark} ${finding.code}  ${finding.message}`);
		lines.push(`           fix: ${finding.fix}`);
	}
	if (report.findings.length === 0) lines.push("  no findings");
	lines.push("");
	lines.push(`  ${String(report.errors)} error${report.errors === 1 ? "" : "s"}, ${String(report.warnings)} warning${report.warnings === 1 ? "" : "s"}`);
	return `${lines.join("\n")}\n`;
}
//#endregion
//#region src/run.ts
const HELP = `permdock — @permdock/cli

Commands:
  collect [--check] [--src <path>] [--watch]
  catalog [--format json|schema|markdown] [--from <module>] [--include <key>]
  usage [--json] [--strict] [--ignore <glob>]
  doctor [--json] [--only <codes>] [--fix]
  skills [install|list|update] [--agent <name>]

Global:
  --cwd <dir>   --config <file>   --json   --no-color
`;
async function run(argv, options) {
	const stdoutChunks = [];
	const stderrChunks = [];
	const io = options?.io ?? {
		stdout: (text) => {
			stdoutChunks.push(text);
		},
		stderr: (text) => {
			stderrChunks.push(text);
		}
	};
	const writeOut = (text) => {
		const line = text.endsWith("\n") ? text : `${text}\n`;
		io.stdout(line);
		if (options?.io !== void 0) stdoutChunks.push(line);
	};
	const writeErr = (text) => {
		const line = text.endsWith("\n") ? text : `${text}\n`;
		io.stderr(line);
		if (options?.io !== void 0) stderrChunks.push(line);
	};
	const args = parseArgs(argv);
	if (flagBool(args.flags, "help") || args.command === "help") {
		writeOut(HELP);
		return finish(0, stdoutChunks, stderrChunks);
	}
	const cwd = resolveCwd(args, options?.cwd ?? process.cwd());
	const now = io.now?.() ?? /* @__PURE__ */ new Date();
	let config;
	try {
		config = await loadConfig(cwd, args);
	} catch (error) {
		writeErr(error instanceof Error ? error.message : String(error));
		return finish(2, stdoutChunks, stderrChunks);
	}
	const json = flagBool(args.flags, "json");
	const strict = flagBool(args.flags, "strict");
	const color = !flagBool(args.flags, "no-color");
	try {
		switch (args.command) {
			case void 0:
				writeErr(HELP);
				return finish(2, stdoutChunks, stderrChunks);
			case "collect": {
				const src = flagList(args.flags, "src");
				const out = flagString(args.flags, "out");
				const result = await runCollect({
					cwd,
					config,
					collect: {
						...src.length > 0 ? { srcPath: src } : {},
						...out === void 0 ? {} : { out }
					},
					check: flagBool(args.flags, "check"),
					now,
					io
				});
				writeOut(result.message);
				return finish(result.code, stdoutChunks, stderrChunks);
			}
			case "catalog": {
				const formatFlag = flagString(args.flags, "format") ?? "json";
				if (formatFlag !== "json" && formatFlag !== "schema" && formatFlag !== "markdown") {
					writeErr("catalog --format must be json, schema or markdown");
					return finish(2, stdoutChunks, stderrChunks);
				}
				const result = await runCatalog({
					cwd,
					config,
					format: formatFlag,
					from: flagString(args.flags, "from"),
					include: flagList(args.flags, "include"),
					now,
					io
				});
				writeOut(result.output);
				return finish(result.code, stdoutChunks, stderrChunks);
			}
			case "usage": {
				const result = await runUsage({
					cwd,
					config,
					ignore: flagList(args.flags, "ignore"),
					strict,
					json,
					dynamicAsUsed: flagBool(args.flags, "dynamic-as-used"),
					now,
					io
				});
				writeOut(result.output);
				return finish(result.code, stdoutChunks, stderrChunks);
			}
			case "doctor": {
				const result = await runDoctor({
					cwd,
					config,
					only: flagList(args.flags, "only"),
					json,
					fix: flagBool(args.flags, "fix"),
					strict,
					color,
					now,
					io
				});
				writeOut(result.output);
				return finish(result.code, stdoutChunks, stderrChunks);
			}
			case "skills": {
				const result = runSkills({
					cwd,
					action: args.rest[0],
					agents: flagList(args.flags, "agent")
				});
				writeOut(result.output);
				return finish(result.code, stdoutChunks, stderrChunks);
			}
			case "openapi":
			case "rls":
				writeErr(`'${args.command}' is not in this Phase 1 CLI. Use collect, catalog, usage, doctor or skills.`);
				return finish(2, stdoutChunks, stderrChunks);
			default:
				writeErr(`unknown command '${args.command}'. Use collect, catalog, usage, doctor or skills.`);
				return finish(2, stdoutChunks, stderrChunks);
		}
	} catch (error) {
		writeErr(error instanceof Error ? error.message : String(error));
		return finish(2, stdoutChunks, stderrChunks);
	}
}
function finish(code, stdout, stderr) {
	return {
		code,
		stdout: stdout.join(""),
		stderr: stderr.join("")
	};
}
//#endregion
export { run as t };
