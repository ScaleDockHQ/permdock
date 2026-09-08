import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getResource, listPermissions } from "permdock";
import { parseSync } from "oxc-parser";
//#region src/args.ts
const ARRAY_FLAGS = /* @__PURE__ */ new Set([
	"src",
	"include",
	"ignore",
	"agent",
	"only",
	"doc"
]);
function parseArgs(argv) {
	const flags = {};
	const positionals = [];
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === void 0) continue;
		if (token === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (token.startsWith("--")) {
			const body = token.slice(2);
			const eq = body.indexOf("=");
			if (eq !== -1) {
				setFlag(flags, body.slice(0, eq), body.slice(eq + 1));
				continue;
			}
			const next = argv[i + 1];
			if (next !== void 0 && !next.startsWith("-")) {
				setFlag(flags, body, next);
				i += 1;
				continue;
			}
			flags[body] = true;
			continue;
		}
		positionals.push(token);
	}
	return {
		command: positionals[0],
		rest: positionals.slice(1),
		flags
	};
}
function setFlag(flags, name, value) {
	if (ARRAY_FLAGS.has(name)) {
		const current = flags[name];
		const pieces = value.split(",").map((item) => item.trim());
		if (Array.isArray(current)) {
			flags[name] = [...current, ...pieces];
			return;
		}
		flags[name] = pieces;
		return;
	}
	flags[name] = value;
}
function flagString(flags, name) {
	const value = flags[name];
	return typeof value === "string" ? value : void 0;
}
function flagBool(flags, name) {
	return flags[name] === true;
}
function flagList(flags, name) {
	const value = flags[name];
	if (Array.isArray(value)) return value;
	if (typeof value === "string") return [value];
	return [];
}
//#endregion
//#region src/load.ts
async function loadModule(abs) {
	const loaded = await import(pathToFileURL(abs).href);
	if (loaded === null || typeof loaded !== "object") throw new Error(`PermDock CLI: module '${abs}' did not export an object`);
	return loaded;
}
function pickNamed(mod, names) {
	for (const name of names) if (name in mod) return mod[name];
	return mod.default;
}
function asPermissionTree(value) {
	if (value === null || typeof value !== "object") throw new Error("PermDock CLI: permissions export is not a permission tree");
	return value;
}
function asPolicy(value) {
	if (value === null || typeof value !== "object" || !("roles" in value) || !("permissions" in value)) throw new Error("PermDock CLI: policy export is not a Policy");
	return value;
}
function leavesOf(tree) {
	return listPermissions(tree);
}
//#endregion
//#region src/config.ts
const CONFIG_FILES = [
	"permdock.config.ts",
	"permdock.config.mts",
	"permdock.config.js",
	"permdock.config.mjs"
];
function defineConfig(config) {
	return config;
}
async function loadConfig(cwd, args) {
	const fromFlag = flagString(args.flags, "config");
	const path = fromFlag ? resolve(cwd, fromFlag) : CONFIG_FILES.map((name) => resolve(cwd, name)).find((file) => existsSync(file));
	if (path === void 0) return {};
	if (!existsSync(path)) throw new Error(`PermDock CLI: config file not found: ${path}`);
	const value = pickNamed(await loadModule(path), ["default"]);
	if (value === null || typeof value !== "object") return {};
	return value;
}
function resolveCwd(args, fallback) {
	const cwd = flagString(args.flags, "cwd");
	return cwd === void 0 ? fallback : resolve(fallback, cwd);
}
//#endregion
//#region src/version.ts
const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
function cliVersion() {
	return JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version;
}
function generatorBanner() {
	return `@permdock/cli@${cliVersion()}`;
}
const CATALOG_SCHEMA = "https://permdock.dev/schemas/catalog-v1.json";
const USAGE_REPORT_SCHEMA = "https://permdock.dev/schemas/usage-report-v1.json";
const DOCTOR_REPORT_SCHEMA = "https://permdock.dev/schemas/doctor-report-v1.json";
//#endregion
//#region src/catalog-doc.ts
function buildCatalog(tree, scan, generatedAt) {
	const resources = {};
	const definedIn = scan.definitionFiles.permissions;
	for (const leaf of listPermissions(tree)) {
		if (resources[leaf.resource] !== void 0) continue;
		const node = getResource(tree, leaf.resource);
		resources[leaf.resource] = compactResource(definedIn === void 0 ? {
			id: node?.id ?? "id",
			schema: node === void 0 ? null : jsonSchemaOf(node)
		} : {
			id: node?.id ?? "id",
			schema: node === void 0 ? null : jsonSchemaOf(node),
			definedIn
		});
	}
	const permissions = listPermissions(tree).map((leaf) => ({
		key: leaf.key,
		scope: leaf.scope,
		resource: leaf.resource,
		action: leaf.action,
		arity: leaf.kind,
		meta: metaRecord(leaf.meta),
		usages: scan.usages[leaf.key] ?? []
	})).toSorted((a, b) => a.key.localeCompare(b.key));
	return {
		$schema: CATALOG_SCHEMA,
		version: 1,
		generatedAt,
		generator: generatorBanner(),
		resources,
		permissions
	};
}
function compactResource(resource) {
	if (resource.definedIn === void 0) return {
		id: resource.id,
		schema: resource.schema
	};
	return resource;
}
function metaRecord(meta) {
	return { ...meta };
}
function jsonSchemaOf(node) {
	const output = node.schema?.["~standard"]?.jsonSchema?.output;
	if (typeof output === "function") try {
		return output();
	} catch {
		return null;
	}
	return null;
}
function formatCatalogJson(doc) {
	return `${JSON.stringify(doc, null, 2)}\n`;
}
function catalogForCompare(doc) {
	const { generatedAt: _generatedAt, ...rest } = doc;
	return `${JSON.stringify(rest, null, 2)}\n`;
}
function formatCatalogMarkdown(doc) {
	const lines = ["# Permissions", ""];
	const byResource = /* @__PURE__ */ new Map();
	for (const permission of doc.permissions) {
		const current = byResource.get(permission.resource) ?? [];
		byResource.set(permission.resource, [...current, permission]);
	}
	for (const resource of [...byResource.keys()].toSorted()) {
		lines.push(`## ${resource}`, "");
		lines.push("| Action | Arity | Scope | Usages |");
		lines.push("| --- | --- | --- | --- |");
		for (const permission of byResource.get(resource) ?? []) lines.push(`| \`${permission.action}\` | ${permission.arity} | \`${permission.scope}\` | ${String(permission.usages.length)} |`);
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}
function catalogSchemaDocument() {
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: CATALOG_SCHEMA,
		type: "object",
		required: [
			"$schema",
			"version",
			"permissions",
			"resources"
		],
		properties: {
			$schema: { type: "string" },
			version: { const: 1 },
			generatedAt: { type: "string" },
			generator: { type: "string" },
			resources: { type: "object" },
			permissions: {
				type: "array",
				items: {
					type: "object",
					required: [
						"key",
						"resource",
						"action",
						"arity",
						"scope"
					]
				}
			}
		}
	};
}
//#endregion
//#region src/files.ts
const SOURCE_EXT = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts"
]);
const SKIP_DIRS = /* @__PURE__ */ new Set([
	"node_modules",
	"dist",
	".next",
	".turbo",
	"coverage",
	".git"
]);
function listSourceFiles(cwd, srcPath) {
	const out = /* @__PURE__ */ new Set();
	for (const entry of srcPath) {
		if (entry.includes("*") || entry.includes("?")) {
			collectGlob(cwd, entry, out);
			continue;
		}
		collectRoot(resolve(cwd, entry), out, !entry.includes("node_modules"));
	}
	return [...out].toSorted();
}
function collectGlob(cwd, pattern, out) {
	const prefix = pattern.split("*")[0] ?? "";
	const root = resolve(cwd, prefix);
	if (!existsSync(root)) return;
	collectRoot(root, out, false);
}
function collectRoot(root, out, skipNestedNodeModules) {
	if (!existsSync(root)) return;
	if (statSync(root).isFile()) {
		if (SOURCE_EXT.has(extname(root))) out.add(root);
		return;
	}
	walkDir(root, out, skipNestedNodeModules);
}
function walkDir(dir, out, skipNestedNodeModules) {
	for (const name of readdirSync(dir)) {
		if (name.startsWith(".") && name !== ".agents") continue;
		if (SKIP_DIRS.has(name) && skipNestedNodeModules) continue;
		if (name === "node_modules" && skipNestedNodeModules) continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			walkDir(full, out, skipNestedNodeModules);
			continue;
		}
		if (SOURCE_EXT.has(extname(name)) && !name.endsWith(".generated.ts")) out.add(full);
	}
}
function rel(cwd, abs) {
	return relative(cwd, abs).split("\\").join("/");
}
function defaultSrcPath() {
	return ["./src"];
}
//#endregion
//#region src/scan.ts
const CHECK_CALLS = /* @__PURE__ */ new Set([
	"can",
	"decide",
	"assert",
	"filter",
	"where",
	"simulate",
	"usePermission",
	"getPermission",
	"protect",
	"allow",
	"deny",
	"registerTool"
]);
function scanSources(cwd, files, knownKeys) {
	const roots = /* @__PURE__ */ new Set(["permissions"]);
	const definitionFiles = {};
	const usages = {};
	const unknown = [];
	const dynamic = [];
	const roleNames = /* @__PURE__ */ new Set();
	const allowKeys = /* @__PURE__ */ new Set();
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		let program;
		try {
			program = parseSync(file, source).program;
		} catch {
			continue;
		}
		const fileRel = rel(cwd, file);
		walk(program, void 0, (node, parent) => {
			if (node.type === "CallExpression") recordCall(node, parent, source, fileRel, roots, definitionFiles, usages, unknown, dynamic, roleNames, allowKeys, knownKeys);
			if (node.type === "MemberExpression" && parent?.type !== "MemberExpression") recordMember(node, parent, source, fileRel, roots, usages, unknown, dynamic, allowKeys, knownKeys);
			if (node.type === "ImportDeclaration") recordImport(node, roots);
		});
	}
	return {
		roots: [...roots].toSorted(),
		definitionFiles,
		usages,
		unknown,
		dynamic,
		roleNames: [...roleNames].toSorted(),
		allowKeys: [...allowKeys].toSorted()
	};
}
function recordImport(node, roots) {
	for (const spec of node.specifiers ?? []) {
		const imported = spec.imported?.name ?? spec.local?.name;
		const local = spec.local?.name;
		if (imported === "permissions" && local !== void 0) roots.add(local);
	}
}
function recordCall(node, parent, source, fileRel, roots, definitionFiles, usages, unknown, dynamic, roleNames, _allowKeys, knownKeys) {
	const callee = calleeName(node.callee);
	const line = lineAt(source, node.start ?? 0);
	if (callee === "definePermissions") {
		const name = declaredName(parent);
		if (name !== void 0) {
			roots.add(name);
			definitionFiles[name] = fileRel;
		}
		return;
	}
	if (callee === "role") {
		const first = node.arguments?.[0];
		if (typeof first?.value === "string") roleNames.add(first.value);
		return;
	}
	if (callee === "findPermission") {
		const second = node.arguments?.[1];
		if (typeof second?.value === "string") {
			pushUsage(second.value, {
				file: fileRel,
				line,
				call: "findPermission"
			}, knownKeys, usages, unknown);
			return;
		}
		dynamic.push({
			file: fileRel,
			line,
			call: "findPermission"
		});
	}
}
function recordMember(node, parent, source, fileRel, roots, usages, unknown, dynamic, allowKeys, knownKeys) {
	if (node.computed === true) {
		const root = rootName(node);
		if (root !== void 0 && roots.has(root)) dynamic.push({
			file: fileRel,
			line: lineAt(source, node.start ?? 0),
			call: callName(parent)
		});
		return;
	}
	const path = memberPath(node);
	if (path === void 0 || path.length < 2) return;
	const [root, ...rest] = path;
	if (root === void 0 || !roots.has(root)) return;
	const key = rest.join(".");
	const call = callName(parent);
	const usage = {
		file: fileRel,
		line: lineAt(source, node.start ?? 0),
		call
	};
	if (call === "allow") allowKeys.add(key);
	pushUsage(key, usage, knownKeys, usages, unknown);
}
function pushUsage(key, usage, knownKeys, usages, unknown) {
	if (knownKeys.size > 0 && !knownKeys.has(key)) {
		unknown.push({
			...usage,
			call: `${usage.call}:${key}`
		});
		return;
	}
	const list = usages[key] ?? [];
	list.push(usage);
	usages[key] = list;
}
function calleeName(node) {
	if (node === void 0) return;
	if (node.type === "Identifier") return node.name;
	if (node.type === "MemberExpression" && node.property?.type === "Identifier") return node.property.name;
}
function declaredName(parent) {
	if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") return parent.id.name;
}
function callName(parent) {
	if (parent?.type === "CallExpression") {
		const name = calleeName(parent.callee);
		if (name !== void 0 && CHECK_CALLS.has(name)) return name;
	}
	if (parent?.type === "Property" || parent?.type === "ObjectProperty") return "tools";
	return "reference";
}
function memberPath(node) {
	const parts = [];
	let current = node;
	while (current?.type === "MemberExpression") {
		if (current.computed === true) return;
		const name = current.property?.name;
		if (name === void 0) return;
		parts.unshift(name);
		current = current.object;
	}
	if (current?.type !== "Identifier" || current.name === void 0) return;
	parts.unshift(current.name);
	return parts;
}
function rootName(node) {
	let current = node;
	while (current?.type === "MemberExpression") current = current.object;
	return current?.type === "Identifier" ? current.name : void 0;
}
function lineAt(source, index) {
	let line = 1;
	const end = Math.min(index, source.length);
	for (let i = 0; i < end; i += 1) if (source.charCodeAt(i) === 10) line += 1;
	return line;
}
function walk(node, parent, visit) {
	if (node === void 0 || typeof node !== "object" || node.type === void 0) return;
	visit(node, parent);
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const item of value) walk(item, node, visit);
			continue;
		}
		if (value !== null && typeof value === "object" && "type" in value) walk(value, node, visit);
	}
}
//#endregion
//#region src/collect.ts
async function runCollect(input) {
	const srcPath = input.collect.srcPath ?? input.config.collect?.srcPath ?? defaultSrcPath();
	const outRel = input.collect.out ?? input.config.collect?.out ?? input.config.catalog?.out ?? "permissions.catalog.json";
	const outPath = resolve(input.cwd, outRel);
	const permissionsRel = input.config.permissions ?? guessPermissions(input.cwd, srcPath);
	if (permissionsRel === void 0) return {
		code: 2,
		document: void 0,
		scan: void 0,
		outPath,
		message: "usage: set permissions in permdock.config.ts or pass a definePermissions module"
	};
	const permissionsAbs = resolve(input.cwd, permissionsRel);
	if (!existsSync(permissionsAbs)) return {
		code: 2,
		document: void 0,
		scan: void 0,
		outPath,
		message: `PermDock CLI: permissions module not found: ${rel(input.cwd, permissionsAbs)}`
	};
	let tree;
	try {
		tree = asPermissionTree(pickNamed(await loadModule(permissionsAbs), ["permissions"]));
	} catch (error) {
		return {
			code: 2,
			document: void 0,
			scan: void 0,
			outPath,
			message: error instanceof Error ? error.message : String(error)
		};
	}
	const files = listSourceFiles(input.cwd, srcPath);
	const knownKeys = new Set(leavesOf(tree).map((leaf) => leaf.key));
	const scan = scanSources(input.cwd, files, knownKeys);
	const document = buildCatalog(tree, scan, input.now.toISOString());
	const next = formatCatalogJson(document);
	if (input.check) {
		if (!existsSync(outPath)) return {
			code: 1,
			document,
			scan,
			outPath,
			message: `catalog missing: ${rel(input.cwd, outPath)}`
		};
		const current = readFileSync(outPath, "utf8");
		if (catalogForCompare(JSON.parse(current)) !== catalogForCompare(document)) return {
			code: 1,
			document,
			scan,
			outPath,
			message: `catalog drift: ${rel(input.cwd, outPath)}`
		};
		return {
			code: 0,
			document,
			scan,
			outPath,
			message: `catalog up to date: ${rel(input.cwd, outPath)}`
		};
	}
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, next);
	const barrel = input.collect.barrel ?? input.config.collect?.barrel;
	if (barrel !== void 0 && barrel !== false) writeBarrel(resolve(input.cwd, barrel === true ? "src/permissions.generated.ts" : barrel), permissionsRel);
	return {
		code: 0,
		document,
		scan,
		outPath,
		message: `wrote ${rel(input.cwd, outPath)}`
	};
}
function guessPermissions(cwd, srcPath) {
	return [
		"src/permissions.ts",
		"permissions.ts",
		...srcPath.map((entry) => `${entry.replace(/\/$/, "")}/permissions.ts`)
	].find((file) => existsSync(resolve(cwd, file)));
}
function writeBarrel(abs, permissionsRel) {
	const specifier = permissionsRel.replace(/\\/gu, "/").replace(/\.tsx?$/u, ".js");
	const body = `// @generated by @permdock/cli — do not edit
import { mergePermissions } from 'permdock'
import { permissions as collected } from '${specifier.startsWith(".") ? specifier : `./${specifier}`}'

export const permissions = mergePermissions(collected)
`;
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, body);
}
//#endregion
export { parseArgs as C, flagString as S, leavesOf as _, rel as a, flagBool as b, formatCatalogJson as c, USAGE_REPORT_SCHEMA as d, defineConfig as f, asPolicy as g, asPermissionTree as h, listSourceFiles as i, formatCatalogMarkdown as l, resolveCwd as m, scanSources as n, buildCatalog as o, loadConfig as p, defaultSrcPath as r, catalogSchemaDocument as s, runCollect as t, DOCTOR_REPORT_SCHEMA as u, loadModule as v, flagList as x, pickNamed as y };
