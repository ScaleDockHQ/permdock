import { C as parseArgs, S as flagString, _ as leavesOf, a as rel, b as flagBool, c as formatCatalogJson, d as USAGE_REPORT_SCHEMA, g as asPolicy, h as asPermissionTree, i as listSourceFiles, l as formatCatalogMarkdown, m as resolveCwd, n as scanSources, o as buildCatalog, p as loadConfig, r as defaultSrcPath, s as catalogSchemaDocument, t as runCollect, u as DOCTOR_REPORT_SCHEMA, v as loadModule, x as flagList, y as pickNamed } from "./collect-C-3dZgTM.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createPermDock, definePolicy, findPermission } from "permdock";
import { createRequire } from "node:module";
import { createPermDock as createPermDock$1 } from "permdock/openapi";
import { createHash } from "node:crypto";
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
	"permdock/supabase",
	"permdock/ssf",
	"permdock/better-auth",
	"permdock/clerk",
	"permdock/convex",
	"permdock/pdp",
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
//#region src/openapi.ts
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function mergeRecord(base, extra) {
	const result = {};
	for (const [key, value] of Object.entries(base)) result[key] = value;
	for (const [key, value] of Object.entries(extra)) result[key] = value;
	return result;
}
function stableJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}
async function loadPolicy$1(cwd, config, from) {
	const policyPath = from ?? config.policy;
	if (policyPath !== void 0) {
		const abs = resolve(cwd, policyPath);
		return asPolicy(pickNamed(await loadModule(abs), ["policy"]));
	}
	const permissionsPath = config.permissions;
	if (permissionsPath === void 0) throw new Error("PermDock CLI: openapi needs --from, policy or permissions in the config");
	const tree = asPermissionTree(pickNamed(await loadModule(resolve(cwd, permissionsPath)), ["permissions"]));
	return definePolicy(tree, {
		roles: [],
		subject: () => null
	});
}
function applyDocument(document, policy, factory) {
	const components = isRecord$1(document.components) ? document.components : {};
	const nextSchemes = mergeRecord(isRecord$1(components.securitySchemes) ? components.securitySchemes : {}, factory.securitySchemes());
	const requirements = factory.securityProfileRequirements();
	const nextComponents = mergeRecord(components, mergeRecord({ securitySchemes: nextSchemes }, requirements === void 0 ? {} : { securityProfileRequirements: requirements }));
	const paths = isRecord$1(document.paths) ? document.paths : {};
	const nextPaths = {};
	for (const [path, item] of Object.entries(paths)) {
		if (!isRecord$1(item)) {
			nextPaths[path] = item;
			continue;
		}
		const nextItem = {};
		for (const [method, operation] of Object.entries(item)) {
			if (!isRecord$1(operation)) {
				nextItem[method] = operation;
				continue;
			}
			const keys = operation["x-permdock-permissions"];
			if (!Array.isArray(keys)) {
				nextItem[method] = operation;
				continue;
			}
			const leaves = keys.map((key) => {
				if (typeof key !== "string") throw new TypeError("PermDock CLI: x-permdock-permissions must be strings");
				const leaf = findPermission(policy.permissions, key);
				if (leaf === void 0) throw new Error(`PermDock CLI: unknown permission '${key}'`);
				return leaf;
			});
			nextItem[method] = mergeRecord(operation, factory.describe(leaves));
		}
		nextPaths[path] = nextItem;
	}
	return mergeRecord(document, {
		components: nextComponents,
		paths: nextPaths,
		"x-permdock-catalog": factory.catalog()
	});
}
async function runOpenapi(input) {
	const action = input.rest[0] ?? "emit";
	if (action !== "emit" && action !== "import") return {
		code: 2,
		output: "openapi action must be emit or import"
	};
	if (input.doc === void 0) return {
		code: 2,
		output: "openapi --doc is required"
	};
	const policy = await loadPolicy$1(input.cwd, input.config, input.from);
	const factory = createPermDock$1(policy, {
		target: input.target,
		...input.profile === void 0 ? {} : { securityProfile: input.profile },
		...input.profileScheme === void 0 ? {} : { profileScheme: input.profileScheme },
		scheme: {
			name: input.scheme,
			type: "oauth2",
			...input.metadataUrl === void 0 ? {} : { oauth2MetadataUrl: input.metadataUrl },
			flows: input.deviceFlow ? {
				authorizationCode: {},
				deviceAuthorization: {}
			} : { authorizationCode: {} }
		}
	});
	const docPath = resolve(input.cwd, input.doc);
	if (action === "import") return {
		code: 2,
		output: "openapi import ships in a later Phase 2 slice"
	};
	if (!existsSync(docPath)) return {
		code: 2,
		output: `PermDock CLI: document not found: ${input.doc}`
	};
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(docPath, "utf8"));
	} catch {
		return {
			code: 2,
			output: "PermDock CLI: --doc must be a JSON OpenAPI document"
		};
	}
	if (!isRecord$1(parsed)) return {
		code: 2,
		output: "PermDock CLI: OpenAPI document must be an object"
	};
	const text = stableJson(input.format === "overlay" ? factory.overlay({
		extends: input.doc,
		version: input.overlay
	}) : applyDocument(parsed, policy, factory));
	const outPath = resolve(input.cwd, input.out ?? input.doc);
	if (input.check) {
		if (!existsSync(outPath)) return {
			code: 1,
			output: `openapi drift: missing ${input.out ?? input.doc}`
		};
		if (readFileSync(outPath, "utf8") === text) return {
			code: 0,
			output: "openapi up to date"
		};
		return {
			code: 1,
			output: "openapi drift"
		};
	}
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, text);
	return {
		code: 0,
		output: `wrote ${input.out ?? input.doc}`
	};
}
//#endregion
//#region src/rls-sql.ts
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLAIM = /^[A-Za-z_][A-Za-z0-9_]*$/;
function quoteIdent(name) {
	if (!IDENT.test(name)) throw new Error(`PermDock CLI: unsafe SQL identifier '${name}'`);
	return `"${name}"`;
}
function quoteTable(name) {
	return name.split(".").map(quoteIdent).join(".");
}
function quoteLiteral(value) {
	return `'${value.replaceAll("'", "''")}'`;
}
function subjectIdSql(ctx) {
	switch (ctx.dialect) {
		case "supabase": return "(select auth.uid())";
		case "neon": return "(select auth.user_id())";
		case "guc": return `current_setting(${quoteLiteral(`${ctx.gucPrefix}.user_id`)}, true)`;
		default: return ctx.dialect;
	}
}
function subjectClaimSql(ctx, claim) {
	if (!CLAIM.test(claim)) throw new Error(`PermDock CLI: unsafe claim name '${claim}'`);
	switch (ctx.dialect) {
		case "supabase": return `((select auth.jwt()) ->> ${quoteLiteral(claim)})`;
		case "neon": return `((select auth.session()) ->> ${quoteLiteral(claim)})`;
		case "guc": return `current_setting(${quoteLiteral(`${ctx.gucPrefix}.${claim}`)}, true)`;
		default: return ctx.dialect;
	}
}
function sqlValue(value, ctx) {
	if (value !== null && typeof value === "object" && "ref" in value) return compileRef(value.ref, ctx);
	if (value !== null && typeof value === "object" && "date" in value) return quoteLiteral(value.date);
	if (Array.isArray(value)) return `array[${value.map((item) => sqlValue(item, ctx)).join(", ")}]`;
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
	if (typeof value === "string") return quoteLiteral(value);
	throw new Error("PermDock CLI: non-portable condition value");
}
function compileRef(ref, ctx) {
	if (ref === "subject.id") return subjectIdSql(ctx);
	if (ref === "subject.principal.tenant" || ref === "subject.tenant") return subjectClaimSql(ctx, ctx.tenantClaim);
	const claim = ref.startsWith("subject.claim.") || ref.startsWith("subject.claims.") ? ref.slice(ref.indexOf(".", 8) + 1) : void 0;
	if (claim !== void 0) return subjectClaimSql(ctx, claim);
	throw new Error(`PermDock CLI: non-portable subject ref '${ref}'`);
}
function compareSql(op, field, value) {
	const left = quoteIdent(field);
	switch (op) {
		case "eq": return `${left} = ${value}`;
		case "ne": return `${left} <> ${value}`;
		case "gt": return `${left} > ${value}`;
		case "gte": return `${left} >= ${value}`;
		case "lt": return `${left} < ${value}`;
		case "lte": return `${left} <= ${value}`;
		case "contains": return `${left}::text like '%' || ${value}::text || '%'`;
		default: return op;
	}
}
function existsSql(table, rowColumn, rowField, roles, ctx, tenantColumn) {
	const roleList = roles.map((role) => role.replaceAll("'", "''")).join(",");
	const parts = [
		`m.${quoteIdent(rowColumn)} = ${quoteIdent(rowField)}`,
		`m.${quoteIdent(table.user)} = ${subjectIdSql(ctx)}`,
		`m.${quoteIdent(table.role)} = any('{${roleList}}')`
	];
	if (table.expiresAt !== void 0) parts.push(`(m.${quoteIdent(table.expiresAt)} is null or m.${quoteIdent(table.expiresAt)} > now())`);
	if (tenantColumn !== void 0) parts.push(`m.${quoteIdent(tenantColumn)} = ${subjectClaimSql(ctx, ctx.tenantClaim)}`);
	return `exists (select 1 from ${quoteTable(table.table)} m where ${parts.join(" and ")})`;
}
function compileMemberOf(condition, ctx) {
	const mapping = condition.scope === "resource" ? condition.resource === void 0 ? void 0 : ctx.memberships?.resource?.[condition.resource] : ctx.memberships?.[condition.scope];
	if (mapping !== void 0) {
		const rowColumn = condition.scope === "tenant" ? mapping.tenant : condition.scope === "team" ? mapping.team : mapping.id;
		if (rowColumn === void 0) throw new Error(`PermDock CLI: memberships mapping for ${condition.scope} is missing the row column`);
		const tenantColumn = condition.scope === "team" ? mapping.tenant : void 0;
		const primary = existsSql(mapping, rowColumn, condition.field, condition.roles, ctx, tenantColumn);
		if (condition.scope !== "resource" || condition.parents === void 0) return primary;
		return `(${[primary, ...condition.parents.map((parent) => existsSql(mapping, rowColumn, parent, condition.roles, ctx, tenantColumn))].join(" or ")})`;
	}
	if (condition.scope === "tenant") return `${quoteIdent(condition.field)} = ${subjectClaimSql(ctx, ctx.tenantClaim)}`;
	throw new Error(`PermDock CLI: memberOf ${condition.scope} needs a memberships table mapping`);
}
function compileConditionSql(condition, ctx) {
	switch (condition.op) {
		case "eq":
		case "ne":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
		case "contains": return compareSql(condition.op, condition.field, sqlValue(condition.value, ctx));
		case "in":
		case "notIn": {
			const keyword = condition.op === "in" ? "in" : "not in";
			if (!Array.isArray(condition.value) && typeof condition.value === "object" && "ref" in condition.value) throw new Error(`PermDock CLI: non-portable ${condition.op} against '${condition.value.ref}'`);
			const values = condition.value.map((item) => sqlValue(item, ctx));
			return `${quoteIdent(condition.field)} ${keyword} (${values.join(", ")})`;
		}
		case "isNull": return `${quoteIdent(condition.field)} is ${condition.value ? "" : "not "}null`;
		case "and": return `(${condition.conditions.map((item) => compileConditionSql(item, ctx)).join(" and ")})`;
		case "or":
			if (condition.conditions.length === 0) return "false";
			return `(${condition.conditions.map((item) => compileConditionSql(item, ctx)).join(" or ")})`;
		case "not": return `not (${compileConditionSql(condition.condition, ctx)})`;
		case "memberOf": return compileMemberOf(condition, ctx);
		case "opaque": return condition.sql;
		default: return condition;
	}
}
function parseMembershipsFlag(raw) {
	if (raw === void 0 || raw === "") return;
	const colon = raw.indexOf(":");
	const table = colon === -1 ? raw : raw.slice(0, colon);
	const cols = (colon === -1 ? "" : raw.slice(colon + 1)).split(",").map((item) => item.trim()).filter((item) => item !== "");
	return { tenant: {
		table,
		tenant: cols[0] ?? "tenant_id",
		user: cols[1] ?? "user_id",
		role: cols[2] ?? "role",
		...cols[3] === void 0 ? {} : { expiresAt: cols[3] }
	} };
}
function andConditions(left, right) {
	if (left === void 0) return right;
	if (right === void 0) return left;
	return {
		op: "and",
		conditions: [left, right]
	};
}
//#endregion
//#region src/rls-generate.ts
const HEADER = "-- generated by permdock rls generate\n-- fail-closed: never target a bypass role\n";
function commandFor(action) {
	switch (action) {
		case "read":
		case "list":
		case "get": return "select";
		case "create": return "insert";
		case "update": return "update";
		case "delete": return "delete";
		default: return;
	}
}
function tableFor(resource, tables) {
	return tables?.[resource] ?? resource;
}
function parentFields(policy, resourceName) {
	const fields = [];
	let current = policy.resources.get(resourceName);
	const seen = /* @__PURE__ */ new Set();
	while (current?.parent !== void 0) {
		if (seen.has(current.name)) break;
		seen.add(current.name);
		fields.push(current.parent.field);
		current = policy.resources.get(current.parent.resource);
	}
	return fields;
}
function scopeCondition(grant, policy) {
	if (grant.scope === "global") return;
	if (grant.scope === "tenant") {
		const field = policy.scopes.tenant?.key;
		if (field === void 0) throw new Error("PermDock CLI: tenant-scoped grant needs definePolicy({ scopes.tenant })");
		return {
			op: "memberOf",
			scope: "tenant",
			field,
			roles: [grant.role]
		};
	}
	if (grant.scope === "team") {
		const field = policy.scopes.team?.key;
		if (field === void 0) throw new Error("PermDock CLI: team-scoped grant needs definePolicy({ scopes.team })");
		return {
			op: "memberOf",
			scope: "team",
			field,
			roles: [grant.role]
		};
	}
	const resourceName = grant.scope.resource;
	return {
		op: "memberOf",
		scope: "resource",
		field: policy.resources.get(resourceName)?.id ?? "id",
		roles: [grant.role],
		resource: resourceName,
		parents: parentFields(policy, resourceName)
	};
}
function policyRoles(roleName) {
	if (roleName === "anonymous" || roleName === "anon") return ["anon", "authenticated"];
	return ["authenticated"];
}
function policyName(role, resource, action, effect) {
	return `${effect === "deny" ? "deny_" : ""}${role}_${resource}_${action}`.replaceAll(/[^A-Za-z0-9_]/g, "_");
}
function compileGrant(grant, policy, ctx, tables, rbac, warnings, skipClosures) {
	if (grant.closure !== void 0 || grant.portable === false) {
		if (skipClosures) {
			warnings.push(`skipped non-portable grant ${grant.role}/${grant.permission.key}`);
			return;
		}
		throw new Error(`PermDock CLI: closure grant ${grant.role}/${grant.permission.key} is not portable; rewrite it or pass --skip-closures`);
	}
	if (grant.approval === "human") {
		warnings.push(`skipped approval:human grant ${grant.role}/${grant.permission.key}`);
		return;
	}
	const command = commandFor(grant.permission.action);
	if (command === void 0) {
		warnings.push(`skipped ${grant.permission.key}: action is not a SQL command`);
		return;
	}
	const scoped = andConditions(scopeCondition(grant, policy), grant.where);
	const check = grant.check ?? (command === "update" ? grant.where : void 0);
	let using = command === "insert" ? void 0 : scoped === void 0 ? "true" : compileConditionSql(scoped, ctx);
	let withCheck = command === "insert" || command === "update" ? check === void 0 && scoped === void 0 ? "true" : compileConditionSql(check ?? scoped ?? {
		op: "eq",
		field: "_",
		value: true
	}, ctx) : void 0;
	if (command === "insert" && scoped !== void 0 && check === void 0) withCheck = compileConditionSql(scoped, ctx);
	if (rbac) {
		const call = `(select authorize(${quoteLiteral(grant.permission.key)}))`;
		using = using === void 0 || using === "true" ? call : `${call} and (${using})`;
		if (withCheck !== void 0) withCheck = withCheck === "true" ? call : `${call} and (${withCheck})`;
	}
	if (grant.effect === "deny") {
		if (using !== void 0) using = `not (${using})`;
		if (withCheck !== void 0) withCheck = `not (${withCheck})`;
	}
	return {
		name: policyName(grant.role, grant.permission.resource, grant.permission.action, grant.effect),
		table: tableFor(grant.permission.resource, tables),
		command,
		effect: grant.effect,
		roles: policyRoles(grant.role),
		...using === void 0 ? {} : { using },
		...withCheck === void 0 ? {} : { check: withCheck },
		permissionKey: grant.permission.key
	};
}
function ensureSelectCoverage(policies, warnings) {
	const extra = [];
	const seen = new Set(policies.filter((item) => item.command === "select").map((item) => `${item.table}:${item.roles.join(",")}`));
	for (const item of policies) {
		if (item.command !== "update" && item.command !== "delete") continue;
		const key = `${item.table}:${item.roles.join(",")}`;
		if (seen.has(key)) continue;
		seen.add(key);
		extra.push({
			name: `${item.name}_select_coverage`,
			table: item.table,
			command: "select",
			effect: "allow",
			roles: item.roles,
			using: item.using ?? "true",
			permissionKey: item.permissionKey
		});
		warnings.push(`added SELECT coverage for ${item.table} (${item.permissionKey})`);
	}
	return [...policies, ...extra];
}
function assertNoServiceRole$1(text) {
	if (/\bto\s+service_role\b|\bfrom\s+service_role\b|\bservice_role\b\s*;/i.test(text)) throw new Error("PermDock CLI: generated RLS must never emit service_role");
}
function emitSql(policies, rbac) {
	const tables = [...new Set(policies.map((item) => item.table))];
	const chunks = [HEADER];
	if (rbac !== "") chunks.push(rbac);
	for (const table of tables) {
		const cmds = new Set(policies.filter((item) => item.table === table).map((item) => item.command));
		const grants = [
			"select",
			"insert",
			"update",
			"delete"
		].filter((cmd) => cmds.has(cmd));
		chunks.push(`revoke all on table ${quoteTable(table)} from anon, authenticated;`);
		if (grants.length > 0) chunks.push(`grant ${grants.join(", ")} on table ${quoteTable(table)} to authenticated;`);
		chunks.push(`alter table ${quoteTable(table)} enable row level security;`);
		chunks.push("");
	}
	for (const item of policies) {
		const as = item.effect === "deny" ? "restrictive" : "permissive";
		const to = item.roles.join(", ");
		const lines = [
			`drop policy if exists ${quoteIdent(item.name)} on ${quoteTable(item.table)};`,
			`create policy ${quoteIdent(item.name)}`,
			`  on ${quoteTable(item.table)}`,
			`  as ${as}`,
			`  for ${item.command}`,
			`  to ${to}`
		];
		if (item.using !== void 0) lines.push(`  using (${item.using})`);
		if (item.check !== void 0) lines.push(`  with check (${item.check})`);
		chunks.push(`${lines.join("\n")};\n`);
	}
	const text = `${chunks.join("\n").trim()}\n`;
	assertNoServiceRole$1(text);
	return text;
}
function emitDrizzle(policies, rbac) {
	const lines = [
		"// generated by permdock rls generate",
		"// fail-closed: never target a bypass role",
		"import { sql } from 'drizzle-orm'",
		"import { authenticatedRole, pgPolicy } from 'drizzle-orm/pg-core'",
		""
	];
	if (rbac !== "") lines.push("/*", rbac.trim(), "*/", "");
	for (const item of policies) {
		const as = item.effect === "deny" ? "restrictive" : "permissive";
		const using = item.using === void 0 ? "" : `\n  using: sql\`${item.using}\`,`;
		const check = item.check === void 0 ? "" : `\n  withCheck: sql\`${item.check}\`,`;
		lines.push(`export const ${item.name} = pgPolicy('${item.name}', {`, `  as: '${as}',`, `  for: '${item.command}',`, `  to: authenticatedRole,${using}${check}`, "})", "");
	}
	const text = `${lines.join("\n")}\n`;
	assertNoServiceRole$1(text);
	return text;
}
function emitPrisma(policies, rbac) {
	const byTable = /* @__PURE__ */ new Map();
	for (const item of policies) {
		const list = byTable.get(item.table) ?? [];
		list.push(item);
		byTable.set(item.table, list);
	}
	const lines = [
		"// generated by permdock rls generate",
		"// fail-closed: never target a bypass role",
		""
	];
	if (rbac !== "") lines.push("/*", rbac.trim(), "*/", "");
	for (const [table, items] of byTable) {
		const model = table.charAt(0).toUpperCase() + table.slice(1);
		lines.push(`model ${model} {`);
		lines.push("  @@rls");
		for (const item of items) {
			const kind = `policy_${item.command}`;
			lines.push(`  ${kind} ${item.name} {`);
			lines.push(`    roles: [${item.roles.join(", ")}]`);
			if (item.using !== void 0) lines.push(`    using: ${JSON.stringify(item.using)}`);
			if (item.check !== void 0) lines.push(`    withCheck: ${JSON.stringify(item.check)}`);
			lines.push("  }");
		}
		lines.push("}", "");
	}
	const text = `${lines.join("\n")}\n`;
	assertNoServiceRole$1(text);
	return text;
}
function rbacScaffold(policy) {
	const permissions = [...new Set(policy.roles.flatMap((role) => role.grants.map((grant) => grant.permission.key)))];
	const roles = policy.roles.map((role) => role.name);
	const permEnum = permissions.map((key) => quoteLiteral(key)).join(", ");
	const roleEnum = roles.map((name) => quoteLiteral(name)).join(", ");
	const seeds = [];
	for (const role of policy.roles) for (const grant of role.grants) {
		if (grant.effect !== "allow") continue;
		seeds.push(`insert into public.role_permissions (role, permission) values (${quoteLiteral(role.name)}, ${quoteLiteral(grant.permission.key)}) on conflict do nothing;`);
	}
	return `-- rbac scaffold (supabase custom access token hook)
create type public.app_role as enum (${roleEnum});
create type public.app_permission as enum (${permEnum});

create table if not exists public.user_roles (
  user_id uuid primary key,
  role public.app_role not null
);

create table if not exists public.role_permissions (
  role public.app_role not null,
  permission public.app_permission not null,
  primary key (role, permission)
);

${seeds.join("\n")}

create or replace function public.authorize(
  requested_permission public.app_permission,
  requested_tenant uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  binduid uuid;
  user_role public.app_role;
begin
  select (select auth.uid()) into binduid;
  select ur.role into user_role from public.user_roles ur where ur.user_id = binduid;
  if user_role is null then
    return false;
  end if;
  return exists (
    select 1
    from public.role_permissions rp
    where rp.role = user_role
      and rp.permission = requested_permission
  );
end;
$$;

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  user_role public.app_role;
begin
  select role into user_role from public.user_roles where user_id = (event ->> 'user_id')::uuid;
  claims := event -> 'claims';
  if user_role is not null then
    claims := jsonb_set(claims, '{user_role}', to_jsonb(user_role));
  else
    claims := jsonb_set(claims, '{user_role}', 'null');
  end if;
  event := jsonb_set(event, '{claims}', claims);
  return event;
end;
$$;
`;
}
function defaultOut(target) {
	switch (target) {
		case "sql": return "rls.sql";
		case "drizzle": return "src/db/policies.ts";
		case "prisma": return "prisma/policies.prisma";
		default: return target;
	}
}
async function loadPolicy(cwd, config, from) {
	const policyPath = from === "drizzle" ? config.policy : from ?? config.policy;
	if (policyPath === void 0) throw new Error("PermDock CLI: rls generate needs policy in permdock.config.ts or --from");
	return asPolicy(pickNamed(await loadModule(resolve(cwd, policyPath)), ["policy"]));
}
async function runRlsGenerate(input) {
	const policy = await loadPolicy(input.cwd, input.config, input.from);
	const memberships = parseMembershipsFlag(input.memberships) ?? input.config.rls?.memberships;
	const ctx = {
		dialect: input.dialect,
		tenantClaim: input.config.rls?.tenantClaim ?? "tenant_id",
		gucPrefix: input.gucPrefix ?? input.config.rls?.gucPrefix ?? "app",
		...memberships === void 0 ? {} : { memberships }
	};
	const warnings = [];
	const compiled = [];
	for (const role of policy.roles) for (const grant of role.grants) {
		const item = compileGrant(grant, policy, ctx, input.config.rls?.tables, input.rbac, warnings, input.skipClosures);
		if (item !== void 0) compiled.push(item);
	}
	const withSelect = ensureSelectCoverage(compiled, warnings);
	const rbac = input.rbac ? rbacScaffold(policy) : "";
	let text;
	switch (input.target) {
		case "sql":
			text = emitSql(withSelect, rbac);
			break;
		case "drizzle":
			text = emitDrizzle(withSelect, rbac);
			break;
		case "prisma":
			text = emitPrisma(withSelect, rbac);
			break;
		default: return input.target;
	}
	const columns = /* @__PURE__ */ new Set();
	for (const role of policy.roles) for (const grant of role.grants) {
		const where = grant.where;
		if (where !== void 0 && "field" in where) columns.add(`${tableFor(grant.permission.resource, input.config.rls?.tables)}.${where.field}`);
	}
	for (const column of columns) warnings.push(`index suggestion: create index on ${column}`);
	const outRel = input.out ?? input.config.rls?.out ?? defaultOut(input.target);
	const outPath = resolve(input.cwd, outRel);
	if (input.check) {
		if (!existsSync(outPath)) return {
			code: 1,
			output: `rls generate drift: missing ${outRel}`,
			text
		};
		if (readFileSync(outPath, "utf8") === text) return {
			code: 0,
			output: "rls generate up to date",
			text
		};
		return {
			code: 1,
			output: "rls generate drift",
			text
		};
	}
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, text);
	return {
		code: 0,
		output: `wrote ${outRel}${warnings.length === 0 ? "" : `\n${warnings.join("\n")}`}`,
		text
	};
}
//#endregion
//#region src/rls-import.ts
const POLICY_RE = /create\s+policy\s+"?([A-Za-z0-9_]+)"?\s+on\s+"?([A-Za-z0-9_]+)"?([\s\S]*?);/gi;
function fingerprintOf(sql) {
	const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
function splitPolicies(sql) {
	const out = [];
	for (const match of sql.matchAll(POLICY_RE)) {
		const name = match[1] ?? "policy";
		const table = match[2] ?? "table";
		const body = match[3] ?? "";
		const asRestrictive = /\bas\s+restrictive\b/i.test(body);
		const cmdMatch = body.match(/\bfor\s+(all|select|insert|update|delete)\b/i);
		const toMatch = body.match(/\bto\s+([^\n]+)/i);
		const usingMatch = body.match(/\busing\s*\(([\s\S]*?)\)(?:\s+with\s+check|\s*$)/i);
		const checkMatch = body.match(/\bwith\s+check\s*\(([\s\S]*?)\)\s*$/i);
		const roles = (toMatch?.[1] ?? "authenticated").split(",").map((item) => item.trim()).filter((item) => item !== "");
		const cmd = (cmdMatch?.[1] ?? "all").toUpperCase();
		const commands = cmd === "ALL" ? [
			"SELECT",
			"INSERT",
			"UPDATE",
			"DELETE"
		] : [cmd];
		for (const command of commands) out.push({
			name,
			table,
			cmd: command,
			permissive: !asRestrictive,
			roles,
			...usingMatch?.[1] === void 0 ? {} : { using: usingMatch[1].trim() },
			...checkMatch?.[1] === void 0 ? {} : { check: checkMatch[1].trim() }
		});
	}
	return out;
}
function fieldFromEq(sql) {
	return sql.match(/"([A-Za-z_][A-Za-z0-9_]*)"/)?.[1];
}
function conditionFromSql(sql, memberships) {
	if (sql === void 0 || sql === "true") return {
		op: "eq",
		field: "_",
		value: true
	};
	if (/\(select\s+auth\.uid\(\)\)/i.test(sql) || /\(select\s+auth\.user_id\(\)\)/i.test(sql) || /current_setting\('app\.user_id'/i.test(sql)) return {
		op: "eq",
		field: fieldFromEq(sql) ?? "id",
		value: { ref: "subject.id" }
	};
	const exists = sql.match(/exists\s*\(\s*select\s+1\s+from\s+"?([A-Za-z0-9_]+)"?/i);
	if (exists?.[1] !== void 0) {
		const table = exists[1];
		const tenantTable = memberships?.tenant?.table;
		const teamTable = memberships?.team?.table;
		if (tenantTable === table) return {
			op: "memberOf",
			scope: "tenant",
			field: memberships?.tenant?.tenant ?? "tenant_id",
			roles: []
		};
		if (teamTable === table) return {
			op: "memberOf",
			scope: "team",
			field: memberships?.team?.team ?? "team_id",
			roles: []
		};
		return {
			op: "opaque",
			sql,
			fingerprint: fingerprintOf(sql)
		};
	}
	return {
		op: "opaque",
		sql,
		fingerprint: fingerprintOf(sql)
	};
}
function actionsFor(cmds) {
	const actions = [];
	const collection = [];
	if (cmds.includes("SELECT")) {
		actions.push("read");
		collection.push("list");
	}
	if (cmds.includes("INSERT")) collection.push("create");
	if (cmds.includes("UPDATE")) actions.push("update");
	if (cmds.includes("DELETE")) actions.push("delete");
	if (actions.length === 0) actions.push("read");
	return {
		actions,
		collection
	};
}
function schemaImport(kind) {
	switch (kind) {
		case "valibot": return "import * as v from 'valibot'";
		case "arktype": return "import { type } from 'arktype'";
		default: return "import { z } from 'zod'";
	}
}
function schemaExpr(kind) {
	switch (kind) {
		case "valibot": return "v.object({})";
		case "arktype": return "type({})";
		default: return "z.object({})";
	}
}
function emitGenerated(catalog, schema) {
	const resources = [...new Set(catalog.map((item) => item.table))].map((table) => {
		const { actions, collection } = actionsFor(catalog.filter((item) => item.table === table).map((item) => item.cmd));
		return `  ${table.replaceAll(/[^A-Za-z0-9_]/g, "_")}: resource(${schemaExpr(schema)}, {
    id: 'id',
    actions: ${JSON.stringify(actions)},
    collection: ${JSON.stringify(collection)},
  }),`;
	});
	return `// @generated by permdock rls import
import { definePermissions, resource } from 'permdock'
${schemaImport(schema)}

export const catalog = ${JSON.stringify(catalog, null, 2)} as const

export const permissions = definePermissions({
${resources.join("\n")}
})
`;
}
function assertNoServiceRole(sql) {
	if (/\bto\s+service_role\b|\bfrom\s+service_role\b/i.test(sql)) throw new Error("PermDock CLI: imported SQL must never target service_role");
}
function runRlsImport(input) {
	if (input.db !== void 0 && input.sql === void 0) return {
		code: 2,
		output: "PermDock CLI: rls import --db needs a live catalog reader; pass --sql for a dump in this release"
	};
	if (input.sql === void 0) return {
		code: 2,
		output: "PermDock CLI: rls import needs --sql <file> or --db <url>"
	};
	const sqlPath = resolve(input.cwd, input.sql);
	if (!existsSync(sqlPath)) return {
		code: 2,
		output: `PermDock CLI: SQL dump not found: ${input.sql}`
	};
	const sql = readFileSync(sqlPath, "utf8");
	assertNoServiceRole(sql);
	const memberships = parseMembershipsFlag(input.memberships) ?? input.config.rls?.memberships;
	const catalog = splitPolicies(sql).map((item) => {
		const sourceSql = item.using ?? item.check ?? "true";
		return {
			table: item.table,
			cmd: item.cmd,
			permissive: item.permissive,
			roles: item.roles,
			condition: conditionFromSql(item.using ?? item.check, memberships),
			fingerprint: fingerprintOf(sourceSql),
			sourceSql
		};
	});
	const outRel = input.out ?? "src/permissions.generated.ts";
	const outPath = resolve(input.cwd, outRel);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, emitGenerated(catalog, input.schema));
	return {
		code: 0,
		output: `wrote ${outRel}`
	};
}
//#endregion
//#region src/rls-verify.ts
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asFixtures(value) {
	const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.fixtures) ? value.fixtures : void 0;
	if (list === void 0) throw new Error("PermDock CLI: fixtures must be an array or { fixtures }");
	return list.map((item, index) => {
		if (!isRecord(item) || !isRecord(item.subject) || item.row === void 0) throw new Error(`PermDock CLI: fixture ${index} needs subject and row`);
		if (typeof item.action !== "string") throw new TypeError(`PermDock CLI: fixture ${index} needs action`);
		if (typeof item.subject.id !== "string") throw new TypeError(`PermDock CLI: fixture ${index} subject needs id`);
		const memberships = item.subject.memberships;
		if (memberships !== void 0 && !Array.isArray(memberships)) throw new Error(`PermDock CLI: fixture ${index} subject.memberships must be an array`);
		const tenant = item.subject.tenant;
		if (tenant !== void 0 && typeof tenant !== "string") throw new Error(`PermDock CLI: fixture ${index} subject.tenant must be a string`);
		return item;
	});
}
async function loadFixtures(cwd, path) {
	const abs = resolve(cwd, path);
	if (!existsSync(abs)) throw new Error(`PermDock CLI: fixtures not found: ${path}`);
	if (abs.endsWith(".json")) return asFixtures(JSON.parse(readFileSync(abs, "utf8")));
	const mod = await loadModule(abs);
	return asFixtures(pickNamed(mod, ["fixtures", "default"]));
}
function canFixture(dock, permission, row) {
	if (permission.kind === "collection") return dock.can(permission, row);
	return dock.can(permission, row);
}
function toSubject(fixture) {
	return {
		principal: {
			id: fixture.id,
			roles: fixture.roles ?? [],
			...fixture.tenant === void 0 ? {} : { tenant: fixture.tenant },
			memberships: fixture.memberships ?? []
		},
		context: {}
	};
}
function emitPgtap(fixtures) {
	const lines = [
		"begin;",
		`select plan(${fixtures.length});`,
		"-- fixtures carry memberships and tenant for the exists join"
	];
	for (const [index, fixture] of fixtures.entries()) {
		const claims = JSON.stringify({
			sub: fixture.subject.id,
			role: "authenticated",
			tenant_id: fixture.subject.tenant ?? null,
			memberships: fixture.subject.memberships ?? []
		});
		lines.push(`-- ${fixture.action}`, `select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true);`, `select set_config('request.jwt.claim.sub', ${JSON.stringify(fixture.subject.id)}, true);`, `select ok(true, 'fixture ${index} ${fixture.action}');`);
	}
	lines.push("select * from finish();", "rollback;");
	return `${lines.join("\n")}\n`;
}
async function runRlsVerify(input) {
	const policyPath = input.from ?? input.config.policy;
	if (policyPath === void 0) return {
		code: 2,
		output: "PermDock CLI: rls verify needs policy in the config or --from"
	};
	const policy = asPolicy(pickNamed(await loadModule(resolve(input.cwd, policyPath)), ["policy"]));
	const fixturesPath = input.fixtures ?? "rls.fixtures.json";
	const fixtures = await loadFixtures(input.cwd, fixturesPath);
	if (input.format === "pgtap") return {
		code: 0,
		output: emitPgtap(fixtures)
	};
	const mismatches = [];
	for (const fixture of fixtures) {
		const permission = findPermission(policy.permissions, fixture.action);
		if (permission === void 0) {
			mismatches.push(`${fixture.action}: unknown permission`);
			continue;
		}
		const outcome = canFixture(await createPermDock(policy, toSubject(fixture.subject)), permission, fixture.row) ? "granted" : "denied";
		if (fixture.expected !== void 0 && fixture.expected !== outcome) mismatches.push(`${fixture.action}: in-process ${outcome}, expected ${fixture.expected}`);
	}
	if (input.db !== void 0) mismatches.push("rls verify --db is reserved for tests/integration (testcontainers); in-process can() already ran");
	if (mismatches.length > 0) return {
		code: 1,
		output: mismatches.join("\n")
	};
	return {
		code: 0,
		output: `verified ${fixtures.length} fixture(s) in-process`
	};
}
//#endregion
//#region src/rls.ts
const RLS_HELP = `permdock rls generate | import | verify

  generate --target drizzle|sql|prisma --dialect supabase|neon|guc
           [--rbac supabase] [--rbac-scaffold] [--memberships <table>:tenant,user,role]
           [--out <path>] [--check] [--skip-closures] [--guc-prefix app]
  import   --sql schema.sql | --db $DATABASE_URL --out src/permissions.generated.ts
           [--schema zod|valibot|arktype] [--memberships <table>:tenant,user,role]
  verify   [--db $DATABASE_URL] [--fixtures rls.fixtures.ts] [--format pgtap|node]

Never emits service_role. memberOf compiles through the dialect memberships mapping.
`;
function asTarget(value) {
	if (value === void 0 || value === "sql" || value === "drizzle" || value === "prisma") return value ?? "sql";
}
function asDialect(value) {
	if (value === void 0 || value === "supabase" || value === "neon" || value === "guc") return value ?? "supabase";
}
async function runRls(input) {
	const action = input.rest[0];
	if (action === void 0 || action === "help") return {
		code: 2,
		output: RLS_HELP
	};
	switch (action) {
		case "generate": {
			const target = asTarget(input.target);
			const dialect = asDialect(input.dialect);
			if (target === void 0) return {
				code: 2,
				output: "rls generate --target must be drizzle, sql or prisma"
			};
			if (dialect === void 0) return {
				code: 2,
				output: "rls generate --dialect must be supabase, neon or guc"
			};
			return await runRlsGenerate({
				cwd: input.cwd,
				config: input.config,
				target,
				dialect,
				rbac: input.rbac,
				check: input.check,
				skipClosures: input.skipClosures,
				io: input.io,
				...input.out === void 0 ? {} : { out: input.out },
				...input.from === void 0 ? {} : { from: input.from },
				...input.memberships === void 0 ? {} : { memberships: input.memberships },
				...input.gucPrefix === void 0 ? {} : { gucPrefix: input.gucPrefix }
			});
		}
		case "import": return runRlsImport({
			cwd: input.cwd,
			config: input.config,
			schema: input.schema ?? "zod",
			io: input.io,
			...input.sql === void 0 ? {} : { sql: input.sql },
			...input.db === void 0 ? {} : { db: input.db },
			...input.out === void 0 ? {} : { out: input.out },
			...input.memberships === void 0 ? {} : { memberships: input.memberships }
		});
		case "verify": {
			const format = input.format ?? "node";
			if (format !== "node" && format !== "pgtap") return {
				code: 2,
				output: "rls verify --format must be pgtap or node"
			};
			return await runRlsVerify({
				cwd: input.cwd,
				config: input.config,
				format,
				io: input.io,
				...input.fixtures === void 0 ? {} : { fixtures: input.fixtures },
				...input.db === void 0 ? {} : { db: input.db },
				...input.from === void 0 ? {} : { from: input.from }
			});
		}
		default: return {
			code: 2,
			output: RLS_HELP
		};
	}
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
  openapi emit --doc <path> [--target 3.1|3.2|3.3] [--format document|overlay]
  rls generate|import|verify [--target sql|drizzle|prisma] [--dialect supabase|neon|guc]

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
			case "openapi": {
				const targetFlag = flagString(args.flags, "target") ?? "3.2";
				if (targetFlag !== "3.1" && targetFlag !== "3.2" && targetFlag !== "3.3") {
					writeErr("openapi --target must be 3.1, 3.2 or 3.3");
					return finish(2, stdoutChunks, stderrChunks);
				}
				const formatFlag = flagString(args.flags, "format") ?? "document";
				if (formatFlag !== "document" && formatFlag !== "overlay") {
					writeErr("openapi --format must be document or overlay");
					return finish(2, stdoutChunks, stderrChunks);
				}
				const overlayFlag = flagString(args.flags, "overlay") ?? "1.1";
				if (overlayFlag !== "1.1" && overlayFlag !== "1.2") {
					writeErr("openapi --overlay must be 1.1 or 1.2");
					return finish(2, stdoutChunks, stderrChunks);
				}
				const profileFlag = flagString(args.flags, "profile");
				if (profileFlag !== void 0 && profileFlag !== "fapi2") {
					writeErr("openapi --profile must be fapi2");
					return finish(2, stdoutChunks, stderrChunks);
				}
				const result = await runOpenapi({
					cwd,
					config,
					rest: args.rest,
					doc: flagString(args.flags, "doc") ?? flagList(args.flags, "doc")[0],
					out: flagString(args.flags, "out"),
					from: flagString(args.flags, "from"),
					target: targetFlag,
					format: formatFlag,
					overlay: overlayFlag,
					check: flagBool(args.flags, "check"),
					profile: profileFlag,
					profileScheme: flagString(args.flags, "profile-scheme"),
					scheme: flagString(args.flags, "scheme") ?? "permdockOAuth",
					metadataUrl: flagList(args.flags, "metadata-url")[0],
					deviceFlow: flagBool(args.flags, "device-flow"),
					io
				});
				writeOut(result.output);
				return finish(result.code, stdoutChunks, stderrChunks);
			}
			case "rls": {
				const rbacFlag = flagString(args.flags, "rbac");
				const result = await runRls({
					cwd,
					config,
					rest: args.rest,
					target: flagString(args.flags, "target"),
					dialect: flagString(args.flags, "dialect"),
					out: flagString(args.flags, "out"),
					from: flagString(args.flags, "from"),
					sql: flagString(args.flags, "sql"),
					db: flagString(args.flags, "db"),
					fixtures: flagString(args.flags, "fixtures"),
					schema: flagString(args.flags, "schema"),
					memberships: flagString(args.flags, "memberships"),
					format: flagString(args.flags, "format") ?? flagString(args.flags, "emit"),
					rbac: flagBool(args.flags, "rbac-scaffold") || rbacFlag === "supabase",
					check: flagBool(args.flags, "check"),
					skipClosures: flagBool(args.flags, "skip-closures"),
					gucPrefix: flagString(args.flags, "guc-prefix"),
					io
				});
				writeOut(result.output);
				return finish(result.code, stdoutChunks, stderrChunks);
			}
			default:
				writeErr(`unknown command '${args.command}'. Use collect, catalog, usage, doctor, skills, openapi or rls.`);
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
