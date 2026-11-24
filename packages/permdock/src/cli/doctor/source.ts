import type {
  Argument,
  CallExpression,
  Expression,
  ObjectExpression,
  ObjectProperty,
} from "oxc-parser";

import { existsSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { DoctorFinding, DoctorSource } from "../shared/doctor-types.ts";

import { createVisitor, jiti, parseSync } from "../core/optional.ts";

/**
 * Entries a client file must not import; `tests/cli/doctor-entries.test.ts`
 * keeps it in step with `exports`.
 */
export const SERVER_SPECIFIERS = [
  "permdock/a2a",
  "permdock/agent",
  "permdock/ai-sdk",
  "permdock/app",
  "permdock/approvals",
  "permdock/astro",
  "permdock/authzen",
  "permdock/better-auth",
  "permdock/better-supabase",
  "permdock/chat",
  "permdock/chat-sdk",
  "permdock/claude-agent",
  "permdock/clerk",
  "permdock/cloud",
  "permdock/convex",
  "permdock/delivery",
  "permdock/drizzle",
  "permdock/elysia",
  "permdock/eve",
  "permdock/express",
  "permdock/fastify",
  "permdock/h3",
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
  "permdock/resend",
  "permdock/scim",
  "permdock/seeds",
  "permdock/server",
  "permdock/solid-start",
  "permdock/ssf",
  "permdock/supabase",
  "permdock/supabase/middleware",
  "permdock/sveltekit",
  "permdock/tanstack-start",
  "permdock/terminal",
  "permdock/trpc",
  "permdock/workflow",
  "permdock/workflow-sdk",
] as const;

/** Entries that feed request, tool or model data into a check. */
export const ADAPTER_SPECIFIERS = [
  "permdock/a2a",
  "permdock/agent",
  "permdock/ai-sdk",
  "permdock/astro",
  "permdock/authzen",
  "permdock/chat",
  "permdock/chat-sdk",
  "permdock/claude-agent",
  "permdock/elysia",
  "permdock/eve",
  "permdock/express",
  "permdock/fastify",
  "permdock/h3",
  "permdock/hono",
  "permdock/mcp",
  "permdock/nest",
  "permdock/next",
  "permdock/node",
  "permdock/openai",
  "permdock/orpc",
  "permdock/server",
  "permdock/solid-start",
  "permdock/supabase/middleware",
  "permdock/sveltekit",
  "permdock/tanstack-start",
  "permdock/terminal",
  "permdock/trpc",
  "permdock/webmcp",
] as const;

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

/**
 * Specifiers a module loads at runtime: value imports, re-exports and literal
 * dynamic imports.
 */
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
 * A resolver for imports of `file`, the way the bundler resolves them: relative
 * paths with or without an extension, the `paths` of the nearest
 * `tsconfig.json`, and package names through `node_modules` and each package's
 * `exports`. An unresolvable specifier gives `undefined`.
 */
export function resolverFor(
  file: string,
): (specifier: string) => string | undefined {
  const resolver = jiti().createJiti(file, { tsconfigPaths: dirname(file) });
  const parentURL = pathToFileURL(file);
  return (specifier) => {
    if (specifier === "" || isBuiltin(specifier)) {
      return undefined;
    }
    try {
      const url = resolver.esmResolve(specifier, { parentURL, try: true });
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

/** Their `jwks` holds Standard Webhooks `v1a` keys, not a token issuer's. */
const WEBHOOK_VERIFIERS: ReadonlySet<string> = new Set([
  "cloudApprovalWaiter",
  "verifyWebhook",
  "webhookVerifier",
]);

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
  createVisitor({
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
        } else if (specifier.type === "ImportDefaultSpecifier") {
          functions.add(specifier.local.name);
        } else if (
          specifier.importKind !== "type" &&
          !WEBHOOK_VERIFIERS.has(
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value,
          )
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
