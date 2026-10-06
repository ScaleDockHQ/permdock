import { createJiti } from "jiti";
import { existsSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type Argument,
  type CallExpression,
  type Expression,
  type ObjectExpression,
  type ObjectProperty,
  Visitor,
  parseSync,
} from "oxc-parser";

import type { DoctorFinding, DoctorSource } from "./doctor-types.ts";

/** Entries a client file must not import; `tests/cli/doctor-entries.test.ts` keeps it in step with `exports`. */
export const SERVER_SPECIFIERS = [
  "permdock/a2a",
  "permdock/ai-sdk",
  "permdock/approvals",
  "permdock/authzen",
  "permdock/better-auth",
  "permdock/claude-agent",
  "permdock/clerk",
  "permdock/cloud",
  "permdock/convex",
  "permdock/drizzle",
  "permdock/elysia",
  "permdock/eve",
  "permdock/express",
  "permdock/fastify",
  "permdock/hono",
  "permdock/jwt",
  "permdock/kysely",
  "permdock/mcp",
  "permdock/nest",
  "permdock/next",
  "permdock/node",
  "permdock/openai",
  "permdock/openapi",
  "permdock/orpc",
  "permdock/otel",
  "permdock/pdp",
  "permdock/prisma",
  "permdock/scim",
  "permdock/server",
  "permdock/ssf",
  "permdock/supabase",
  "permdock/supabase/middleware",
  "permdock/terminal",
  "permdock/trpc",
] as const;

/** Entries that feed request, tool or model data into a check. */
export const ADAPTER_SPECIFIERS = [
  "permdock/a2a",
  "permdock/ai-sdk",
  "permdock/authzen",
  "permdock/claude-agent",
  "permdock/elysia",
  "permdock/eve",
  "permdock/express",
  "permdock/fastify",
  "permdock/hono",
  "permdock/mcp",
  "permdock/nest",
  "permdock/next",
  "permdock/node",
  "permdock/openai",
  "permdock/orpc",
  "permdock/server",
  "permdock/supabase/middleware",
  "permdock/terminal",
  "permdock/trpc",
  "permdock/webmcp",
] as const;

const UNTRUSTED_CLAIMS = [
  "user_metadata",
  "unsafeMetadata",
  "untrusted_metadata",
  "clientMetadata",
  "preferred_username",
] as const;

function withoutComments(source: DoctorSource): string {
  const { comments } = parseSync(source.file, source.text);
  let text = source.text;
  for (const comment of comments) {
    text =
      text.slice(0, comment.start) +
      " ".repeat(comment.end - comment.start) +
      text.slice(comment.end);
  }
  return text;
}

export function isClientSource(
  source: DoctorSource,
  clientEntries: ReadonlySet<string>,
): boolean {
  return (
    clientEntries.has(source.file) ||
    source.text.includes("'use client'") ||
    source.text.includes('"use client"') ||
    source.file.includes(".client.")
  );
}

/** Specifiers a module loads at runtime: value imports, re-exports and literal dynamic imports. */
export function runtimeSpecifiers(source: DoctorSource): readonly string[] {
  const { module } = parseSync(source.file, source.text);
  const out = new Set<string>();
  for (const item of module.staticImports) {
    if (
      item.entries.length === 0 ||
      item.entries.some((entry) => !entry.isType)
    ) {
      out.add(item.moduleRequest.value);
    }
  }
  for (const item of module.staticExports) {
    for (const entry of item.entries) {
      if (entry.moduleRequest !== null && !entry.isType) {
        out.add(entry.moduleRequest.value);
      }
    }
  }
  for (const item of module.dynamicImports) {
    const literal = /^\s*(['"`])([^'"`$]+)\1\s*$/u.exec(
      source.text.slice(item.moduleRequest.start, item.moduleRequest.end),
    );
    if (literal?.[2] !== undefined) {
      out.add(literal[2]);
    }
  }
  return [...out];
}

function realFile(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * A resolver for imports of `file`, the way the bundler resolves them:
 * relative paths with or without an extension, the `paths` of the nearest
 * `tsconfig.json`, and package names through `node_modules` and each
 * package's `exports`. An unresolvable specifier gives `undefined`.
 */
export function resolverFor(
  file: string,
): (specifier: string) => string | undefined {
  const jiti = createJiti(file, { tsconfigPaths: dirname(file) });
  const parentURL = pathToFileURL(file);
  return (specifier) => {
    if (specifier === "" || isBuiltin(specifier)) {
      return undefined;
    }
    try {
      const url = jiti.esmResolve(specifier, { parentURL, try: true });
      const path =
        url?.startsWith("file:") === true ? fileURLToPath(url) : undefined;
      return path !== undefined && existsSync(path)
        ? realFile(path)
        : undefined;
    } catch {
      return undefined;
    }
  };
}

export type PolicyModule = {
  readonly cwd: string;
  /** The configured `policy` path, relative to `cwd`. */
  readonly path: string;
};

export function pd001(
  sources: readonly DoctorSource[],
  clientEntries: ReadonlySet<string> = new Set(),
  policy?: PolicyModule,
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const policyFile =
    policy === undefined
      ? undefined
      : realFile(resolve(policy.cwd, policy.path));
  for (const source of sources) {
    if (!isClientSource(source, clientEntries)) {
      continue;
    }
    if (policy !== undefined && policyFile !== undefined) {
      const resolveImport = resolverFor(resolve(policy.cwd, source.file));
      for (const specifier of runtimeSpecifiers(source)) {
        if (
          specifier !== "permdock" &&
          !specifier.startsWith("permdock/") &&
          resolveImport(specifier) === policyFile
        ) {
          findings.push({
            code: "PD001",
            severity: "error",
            message: `${source.file} imports the policy module through ${specifier}`,
            fix: "decide on the server and pass a snapshot to the client ('permdock/react'); never import the policy into a client entry",
          });
        }
      }
    }
    for (const spec of SERVER_SPECIFIERS) {
      if (
        source.text.includes(`'${spec}'`) ||
        source.text.includes(`"${spec}"`)
      ) {
        findings.push({
          code: "PD001",
          severity: "error",
          message: `${source.file} imports ${spec}`,
          fix: "move the check into a Server Component or import from 'permdock/react'",
        });
      }
    }
  }
  return findings;
}

export function pd007(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const hasNever = sources.some((source) =>
    /validate\s*:\s*['"]never['"]/u.test(source.text),
  );
  const hasAdapter = sources.some((source) =>
    ADAPTER_SPECIFIERS.some((spec) => source.text.includes(spec)),
  );
  if (hasNever && hasAdapter) {
    return [
      {
        code: "PD007",
        severity: "warning",
        message:
          "policy sets validate: 'never' while an HTTP, MCP or agent adapter is imported",
        fix: "use validate: 'boundary' for untrusted input",
      },
    ];
  }
  return [];
}

export function pd008(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    if (!source.text.includes("permdock")) {
      continue;
    }
    if (
      /export\s+(?:const|function|class)\s+(?:dock|ability)\b/u.test(
        source.text,
      )
    ) {
      findings.push({
        code: "PD008",
        severity: "warning",
        message: `${source.file} exports a reserved name (dock or ability)`,
        fix: "use createPermDock and permdock",
      });
    }
    if (/export\s+(?:const|function|type|interface)\s+\$/u.test(source.text)) {
      findings.push({
        code: "PD008",
        severity: "warning",
        message: `${source.file} exports a $ prefixed member`,
        fix: "drop the $ prefix",
      });
    }
  }
  return findings;
}

export function pd010(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    const text = withoutComments(source);
    for (const claim of UNTRUSTED_CLAIMS) {
      if (text.includes(claim) && /roles|tenant/u.test(text)) {
        findings.push({
          code: "PD010",
          severity: "error",
          message: `${source.file} reads roles or tenant from ${claim}`,
          fix: "use a server-set claim or a MembershipSource",
        });
      }
    }
  }
  return findings;
}

export function pd011(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    if (
      /tenant['"]?\s*:\s*['"]hd['"]/u.test(source.text) ||
      (/accounts\.google\.com/u.test(source.text) && /tenant/.test(source.text))
    ) {
      findings.push({
        code: "PD011",
        severity: "warning",
        message: `${source.file} reads tenant from an optional issuer claim`,
        fix: "compare the claim to onboarded tenants; do not default a tenant",
      });
    }
  }
  return findings;
}

export function pd013(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    if (/algorithms[\s\S]{0,120}EdDSA/u.test(source.text)) {
      findings.push({
        code: "PD013",
        severity: "warning",
        message: `${source.file} lists polymorphic EdDSA`,
        fix: "write Ed25519",
      });
    }
    if (/algorithms[\s\S]{0,120}['"]none['"]/u.test(source.text)) {
      findings.push({
        code: "PD013",
        severity: "error",
        message: `${source.file} allows alg none`,
        fix: "remove none and RSA1_5 from algorithms",
      });
    }
  }
  return findings;
}

type OptionExpression = Argument | Expression;

function unwrapped(
  node: OptionExpression | null | undefined,
): OptionExpression | undefined {
  let current = node ?? undefined;
  while (
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "ParenthesizedExpression"
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(property: ObjectProperty): string | undefined {
  if (property.computed) {
    return undefined;
  }
  const key = property.key;
  if (key.type === "Identifier") {
    return key.name;
  }
  return key.type === "Literal" && typeof key.value === "string"
    ? key.value
    : undefined;
}

function stringValue(node: OptionExpression | undefined): string | undefined {
  const value = unwrapped(node);
  if (value?.type === "Literal") {
    return typeof value.value === "string" ? value.value : undefined;
  }
  return value?.type === "TemplateLiteral"
    ? (value.quasis[0]?.value.cooked ?? undefined)
    : undefined;
}

function isPermDockSpecifier(value: string): boolean {
  return value === "permdock" || value.startsWith("permdock/");
}

function permdockOptionObjects(
  source: DoctorSource,
): readonly ObjectExpression[] {
  const { program } = parseSync(source.file, source.text);
  const functions = new Set<string>();
  const namespaces = new Set<string>();
  const constants = new Map<string, ObjectExpression>();
  const calls: CallExpression[] = [];
  new Visitor({
    ImportDeclaration(node) {
      if (
        node.importKind === "type" ||
        !isPermDockSpecifier(node.source.value)
      ) {
        return;
      }
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          namespaces.add(specifier.local.name);
        } else if (
          specifier.type === "ImportDefaultSpecifier" ||
          specifier.importKind !== "type"
        ) {
          functions.add(specifier.local.name);
        }
      }
    },
    VariableDeclarator(node) {
      const init = unwrapped(node.init);
      if (node.id.type === "Identifier" && init?.type === "ObjectExpression") {
        constants.set(node.id.name, init);
      }
    },
    CallExpression(node) {
      calls.push(node);
    },
  }).visit(program);
  const objects: ObjectExpression[] = [];
  const collect = (node: OptionExpression): void => {
    const value = unwrapped(node);
    const target =
      value?.type === "Identifier" ? constants.get(value.name) : value;
    if (target?.type !== "ObjectExpression" || objects.includes(target)) {
      return;
    }
    objects.push(target);
    for (const property of target.properties) {
      if (property.type === "Property") {
        collect(property.value);
      }
    }
  };
  for (const call of calls) {
    const callee = call.callee;
    if (
      (callee.type === "Identifier" && functions.has(callee.name)) ||
      (callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        namespaces.has(callee.object.name))
    ) {
      for (const argument of call.arguments) {
        collect(argument);
      }
    }
  }
  return objects;
}

export function pd014(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    if (!source.text.includes("permdock")) {
      continue;
    }
    for (const object of permdockOptionObjects(source)) {
      const keys = new Map<string, OptionExpression | undefined>();
      for (const property of object.properties) {
        if (property.type !== "Property") {
          continue;
        }
        const name = propertyName(property);
        if (name !== undefined) {
          keys.set(name, property.value);
        }
      }
      const discovery = keys.get("discovery");
      const setsDiscovery = keys.has("discovery");
      const setsJwks = keys.has("jwks");
      if (stringValue(discovery)?.startsWith("http:") === true) {
        findings.push({
          code: "PD014",
          severity: "error",
          message: `${source.file} uses a plain-HTTP discovery URL`,
          fix: "use an https: issuer",
        });
      }
      if (setsDiscovery && (setsJwks || keys.has("issuer"))) {
        findings.push({
          code: "PD014",
          severity: "error",
          message: `${source.file} sets discovery together with jwks or issuer`,
          fix: "use discovery alone, or jwks plus issuer",
        });
      }
      if (setsJwks && !setsDiscovery && !keys.has("issuer")) {
        findings.push({
          code: "PD014",
          severity: "error",
          message: `${source.file} sets jwks without issuer`,
          fix: "set issuer with jwks, or switch to discovery",
        });
      }
    }
  }
  return findings;
}

export function pd015(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    if (/accept:\s*['"]id-token['"]/u.test(source.text)) {
      findings.push({
        code: "PD015",
        severity: "warning",
        message: `${source.file} accepts id-token on what looks like an API resolver`,
        fix: "leave accept as 'access-token' for API routes",
      });
    }
  }
  return findings;
}

const SUPABASE_SUBJECT_CALL = /\bsubjectFromSupabase(?:Session)?\s*\(/gu;

/** Top-level arguments of the call whose `(` ends at `open`, or undefined when unbalanced. */
function callArguments(
  text: string,
  open: number,
): readonly string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = open + 1;
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "(" || char === "{" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "}" || char === "]") {
      if (depth === 0) {
        args.push(text.slice(start, index).trim());
        return args.filter((arg) => arg !== "");
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  return undefined;
}

/** The claim a `subjectFromSupabase` call reads the tenant from, or undefined when the options are not a literal. */
function readTenantClaim(
  options: string | undefined,
  fallback: string,
): string | undefined {
  if (options === undefined) {
    return fallback;
  }
  if (!options.startsWith("{")) {
    return undefined;
  }
  const tenant =
    /(?:^|[{,\s])tenant\s*:\s*(?:'([^']*)'|"([^"]*)"|([^,}\s]+))/u.exec(
      options,
    );
  if (tenant === null) {
    return fallback;
  }
  return tenant[1] ?? tenant[2];
}

export function pd038(
  sources: readonly DoctorSource[],
  tenantClaim: string,
  fallback: string,
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    for (const match of source.text.matchAll(SUPABASE_SUBJECT_CALL)) {
      const open = match.index + match[0].length - 1;
      const args = callArguments(source.text, open);
      if (args === undefined) {
        continue;
      }
      const read = readTenantClaim(args[1], fallback);
      if (read === undefined || read === tenantClaim) {
        continue;
      }
      const line = source.text.slice(0, match.index).split("\n").length;
      findings.push({
        code: "PD038",
        severity: "warning",
        message: `${source.file}:${line} reads the tenant from '${read}', but rls.tenantClaim is '${tenantClaim}'`,
        fix: `pass tenant: '${tenantClaim}' or set rls.tenantClaim to '${read}'`,
      });
    }
  }
  return findings;
}

/**
 * PD057: `rls.anonymousSignIns` is `'deny'`, so RLS refuses `signInAnonymously()` users, but a
 * `subjectFromSupabase(Session)` call maps them as signed-in users. Options that are not a
 * literal object are not read.
 */
export function pd057(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    for (const match of source.text.matchAll(SUPABASE_SUBJECT_CALL)) {
      const open = match.index + match[0].length - 1;
      const args = callArguments(source.text, open);
      if (args === undefined) {
        continue;
      }
      const options = args[1];
      if (options !== undefined && !options.startsWith("{")) {
        continue;
      }
      if (
        options !== undefined &&
        /(?:^|[{,\s])anonymousSignIns\s*:\s*['"]deny['"]/u.test(options)
      ) {
        continue;
      }
      const line = source.text.slice(0, match.index).split("\n").length;
      findings.push({
        code: "PD057",
        severity: "warning",
        message: `${source.file}:${line} maps anonymous sign-ins as users, but rls.anonymousSignIns is 'deny'`,
        fix: "pass anonymousSignIns: 'deny' so the subject agrees with RLS",
      });
    }
  }
  return findings;
}

const EXCHANGE_CALL = /\bexchangeCapability\s*\(/gu;

/** PD041: `exchangeCapability` signing link tokens with the project's shared JWT secret. */
export function pd041(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    for (const match of source.text.matchAll(EXCHANGE_CALL)) {
      const open = match.index + match[0].length - 1;
      const options = callArguments(source.text, open)?.[1];
      if (
        options === undefined ||
        !/(?:^|[{,\s])alg\s*:\s*['"]HS256['"]/u.test(options)
      ) {
        continue;
      }
      const line = source.text.slice(0, match.index).split("\n").length;
      findings.push({
        code: "PD041",
        severity: "warning",
        message: `${source.file}:${String(line)} signs capability tokens with HS256, the project's shared JWT secret: whoever holds it can mint any user's token`,
        fix: "sign with alg: 'ES256' and the private JWK of an asymmetric Supabase signing key; keep HS256 for the local stack only",
      });
    }
  }
  return findings;
}

const PROTECT_CALL = /\bprotect\s*\(/gu;
const ID_ROUTE =
  /['"`](\/[^'"`\s]*(?::[A-Za-z_$][\w$]*|\{[A-Za-z_$][\w$]*\})[^'"`\s]*)['"`]/gu;
const DYNAMIC_SEGMENT = /(?:^|[\\/])(\[[^\]/\\]+\])(?=[\\/])/u;

/** The id-bearing route a `protect` call at `index` sits in: the file's dynamic segment, or a route literal earlier in the same statement. */
function idRouteOf(source: DoctorSource, index: number): string | undefined {
  const segment = DYNAMIC_SEGMENT.exec(source.file);
  if (segment !== null) {
    return segment[1];
  }
  const window = source.text.slice(Math.max(0, index - 400), index);
  const start = Math.max(window.lastIndexOf(";"), window.lastIndexOf("\n\n"));
  const statement = window.slice(start + 1);
  return [...statement.matchAll(ID_ROUTE)].at(-1)?.[1];
}

/** PD036: a `protect(permission)` with no row loader on a route whose path names an object id (BOLA, OWASP API1). */
export function pd036(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const source of sources) {
    if (!source.text.includes("permdock")) {
      continue;
    }
    for (const match of source.text.matchAll(PROTECT_CALL)) {
      const open = match.index + match[0].length - 1;
      const args = callArguments(source.text, open);
      if (args?.length !== 1 || args[0]?.trim() === "null") {
        continue;
      }
      const route = idRouteOf(source, match.index);
      if (route === undefined) {
        continue;
      }
      const line = source.text.slice(0, match.index).split("\n").length;
      findings.push({
        code: "PD036",
        severity: "warning",
        message: `${source.file}:${String(line)} protects ${route} with ${args[0] ?? ""} and no row loader, so the check never sees the row the id names (BOLA, OWASP API1)`,
        fix: "pass a loader that fetches the row by the id: protect(permission, (request) => load(request))",
      });
    }
  }
  return findings;
}
