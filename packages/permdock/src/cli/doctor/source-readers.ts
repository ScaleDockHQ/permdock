import type { Estree } from "../codemod/ast.ts";
import type { DoctorFinding, DoctorSource } from "../shared/doctor-types.ts";

import { child, lineIndex, nameOf, nodes, walk } from "../codemod/ast.ts";
import { propertyKey } from "../source/edits.ts";
import { parseProgram } from "../source/program.ts";
import { ADAPTER_SPECIFIERS, runtimeSpecifiers } from "./source.ts";

const UNTRUSTED_CLAIMS: ReadonlySet<string> = new Set([
  "user_metadata",
  "unsafeMetadata",
  "untrusted_metadata",
  "clientMetadata",
  "preferred_username",
]);

const MODULE_SOURCES: ReadonlySet<string> = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
]);

/** One parsed source file; files the parser rejects are left out. */
type Parsed = {
  readonly file: string;
  readonly text: string;
  readonly program: Estree;
};

function parsedSources(sources: readonly DoctorSource[]): readonly Parsed[] {
  const out: Parsed[] = [];
  for (const source of sources) {
    const program = parseProgram(source.file, source.text);
    if (program !== undefined) {
      out.push({ file: source.file, text: source.text, program });
    }
  }
  return out;
}

function unwrapped(node: Estree | null | undefined): Estree | undefined {
  let current = node ?? undefined;
  while (
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "ParenthesizedExpression"
  ) {
    current = child(current, "expression");
  }
  return current;
}

/** The value of a string literal or a template literal without expressions. */
function stringOf(node: Estree | null | undefined): string | undefined {
  const value = unwrapped(node);
  if (value?.type === "Literal") {
    return typeof value.value === "string" ? value.value : undefined;
  }
  if (
    value?.type !== "TemplateLiteral" ||
    nodes(Reflect.get(value, "expressions")).length > 0
  ) {
    return undefined;
  }
  const quasi = nodes(Reflect.get(value, "quasis"))[0];
  const cooked: unknown =
    typeof quasi?.value === "object" && quasi.value !== null
      ? Reflect.get(quasi.value, "cooked")
      : undefined;
  return typeof cooked === "string" ? cooked : undefined;
}

/** The value of the property `key` of an object literal. */
function propertyValue(
  object: Estree | undefined,
  key: string,
): Estree | undefined {
  if (object?.type !== "ObjectExpression") {
    return undefined;
  }
  const property = nodes(object.properties).find(
    (item) => item.type === "Property" && propertyKey(item) === key,
  );
  return property === undefined ? undefined : child(property, "value");
}

/** The properties of every object literal in `program`. */
function properties(program: Estree): Estree[] {
  const found: Estree[] = [];
  walk(program, (node) => {
    if (node.type === "Property") {
      found.push(node);
    }
  });
  return found;
}

/**
 * Whether a module specifier of `program` names PermDock: a `permdock` entry or
 * an app module such as `./permdock.ts` that wraps one.
 */
function importsPermDock(program: Estree): boolean {
  let found = false;
  walk(program, (node) => {
    const value = MODULE_SOURCES.has(node.type)
      ? stringOf(node.source)
      : undefined;
    found ||= value?.includes("permdock") === true;
  });
  return found;
}

/** Calls whose callee is `name` or a member named `name`, in source order. */
function callsTo(
  program: Estree,
  names: ReadonlySet<string>,
): { call: Estree; ancestors: readonly Estree[] }[] {
  const found: { call: Estree; ancestors: readonly Estree[] }[] = [];
  walk(program, (node, _parent, ancestors) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const callee = unwrapped(node.callee);
    const name =
      callee?.type === "MemberExpression"
        ? nameOf(callee.property)
        : nameOf(callee);
    if (name !== undefined && names.has(name)) {
      found.push({ call: node, ancestors: [...ancestors] });
    }
  });
  return found;
}

export function pd007(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const parsed = parsedSources(sources);
  const hasNever = parsed.some(({ program }) =>
    properties(program).some(
      (property) =>
        propertyKey(property) === "validate" &&
        stringOf(child(property, "value")) === "never",
    ),
  );
  const hasAdapter = sources.some((source) =>
    runtimeSpecifiers(source).some((specifier) =>
      ADAPTER_SPECIFIERS.some((spec) => specifier === spec),
    ),
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

/** The names a module exports from its own declarations and `export { }`. */
function exportedNames(program: Estree): string[] {
  const names: string[] = [];
  for (const statement of nodes(program.body)) {
    if (statement.type !== "ExportNamedDeclaration") {
      continue;
    }
    const declaration = statement.declaration;
    if (declaration?.type === "VariableDeclaration") {
      for (const item of nodes(declaration.declarations)) {
        const name = nameOf(item.id ?? undefined);
        if (name !== undefined) {
          names.push(name);
        }
      }
    } else if (declaration !== null && declaration !== undefined) {
      const name = nameOf(declaration.id ?? undefined);
      if (name !== undefined) {
        names.push(name);
      }
    }
    if (statement.source === null || statement.source === undefined) {
      for (const specifier of nodes(statement.specifiers)) {
        const name = nameOf(specifier.exported);
        if (name !== undefined) {
          names.push(name);
        }
      }
    }
  }
  return names;
}

export function pd008(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const { file, program } of parsedSources(sources)) {
    if (!importsPermDock(program)) {
      continue;
    }
    const names = exportedNames(program);
    if (names.some((name) => name === "dock" || name === "ability")) {
      findings.push({
        code: "PD008",
        severity: "warning",
        message: `${file} exports a reserved name (dock or ability)`,
        fix: "use createPermDock and permdock",
      });
    }
    if (names.some((name) => name.startsWith("$"))) {
      findings.push({
        code: "PD008",
        severity: "warning",
        message: `${file} exports a $ prefixed member`,
        fix: "drop the $ prefix",
      });
    }
  }
  return findings;
}

/** Identifier names and the values of string literals, in source order. */
function namesAndStrings(program: Estree): {
  names: string[];
  strings: string[];
} {
  const names: string[] = [];
  const strings: string[] = [];
  walk(program, (node) => {
    if (node.type === "Identifier") {
      names.push(node.name ?? "");
    } else {
      const value = node.type === "Literal" ? stringOf(node) : undefined;
      if (value !== undefined) {
        strings.push(value);
      }
    }
  });
  return { names, strings };
}

/**
 * PD010: a file reads an untrusted claim (`user_metadata`, …) as a member or a
 * key, and names roles or a tenant in code.
 */
export function pd010(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const { file, program } of parsedSources(sources)) {
    const { names, strings } = namesAndStrings(program);
    const keys = new Set([
      ...names,
      ...properties(program)
        .map((property) => propertyKey(property))
        .filter((key) => key !== undefined),
    ]);
    const scoped = [...names, ...strings].some((value) =>
      /roles|tenant/u.test(value),
    );
    for (const claim of UNTRUSTED_CLAIMS) {
      if (keys.has(claim) && scoped) {
        findings.push({
          code: "PD010",
          severity: "error",
          message: `${file} reads roles or tenant from ${claim}`,
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
  for (const { file, program } of parsedSources(sources)) {
    const hd = properties(program).some(
      (property) =>
        propertyKey(property) === "tenant" &&
        stringOf(child(property, "value")) === "hd",
    );
    const { names, strings } = namesAndStrings(program);
    const google =
      strings.some((value) => value.includes("accounts.google.com")) &&
      (names.includes("tenant") ||
        properties(program).some(
          (property) => propertyKey(property) === "tenant",
        ));
    if (hd || google) {
      findings.push({
        code: "PD011",
        severity: "warning",
        message: `${file} reads tenant from an optional issuer claim`,
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
  for (const { file, program } of parsedSources(sources)) {
    const listed = new Set<string>();
    for (const property of properties(program)) {
      const value = unwrapped(child(property, "value"));
      if (
        propertyKey(property) !== "algorithms" ||
        value?.type !== "ArrayExpression"
      ) {
        continue;
      }
      for (const element of nodes(value.elements)) {
        const name = stringOf(element);
        if (name !== undefined) {
          listed.add(name);
        }
      }
    }
    if (listed.has("EdDSA")) {
      findings.push({
        code: "PD013",
        severity: "warning",
        message: `${file} lists polymorphic EdDSA`,
        fix: "write Ed25519",
      });
    }
    if (listed.has("none")) {
      findings.push({
        code: "PD013",
        severity: "error",
        message: `${file} allows alg none`,
        fix: "remove none and RSA1_5 from algorithms",
      });
    }
  }
  return findings;
}

const SUPABASE_SUBJECT: ReadonlySet<string> = new Set([
  "subjectFromSupabase",
  "subjectFromSupabaseSession",
]);

/**
 * The options argument of a call: `null` when it has none, `undefined` when it
 * is not an object literal.
 */
function optionsOf(call: Estree, index: number): Estree | null | undefined {
  const argument = nodes(call.arguments)[index];
  if (argument === undefined) {
    return null;
  }
  const value = unwrapped(argument);
  return value?.type === "ObjectExpression" ? value : undefined;
}

/**
 * The claim a `subjectFromSupabase` call reads the tenant from: `tenant` in its
 * options or their `claims`, the fallback when neither sets it, `undefined`
 * when the options or the value are not literals.
 */
function tenantClaimOf(call: Estree, fallback: string): string | undefined {
  const options = optionsOf(call, 1);
  if (options === null) {
    return fallback;
  }
  if (options === undefined) {
    return undefined;
  }
  const value =
    propertyValue(options, "tenant") ??
    propertyValue(unwrapped(propertyValue(options, "claims")), "tenant");
  return value === undefined ? fallback : stringOf(value);
}

export function pd038(
  sources: readonly DoctorSource[],
  tenantClaim: string,
  fallback: string,
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const { file, text, program } of parsedSources(sources)) {
    const lineAt = lineIndex(text);
    for (const { call } of callsTo(program, SUPABASE_SUBJECT)) {
      const read = tenantClaimOf(call, fallback);
      if (read === undefined || read === tenantClaim) {
        continue;
      }
      findings.push({
        code: "PD038",
        severity: "warning",
        message: `${file}:${lineAt(call.start).line} reads the tenant from '${read}', but rls.tenantClaim is '${tenantClaim}'`,
        fix: `pass claims: { tenant: '${tenantClaim}' } or set rls.tenantClaim to '${read}'`,
      });
    }
  }
  return findings;
}

/**
 * PD057: `rls.anonymousSignIns` is `'deny'`, so RLS refuses
 * `signInAnonymously()` users, but a `subjectFromSupabase(Session)` call maps
 * them as signed-in users. Options that are not a literal object are not read.
 */
export function pd057(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const { file, text, program } of parsedSources(sources)) {
    const lineAt = lineIndex(text);
    for (const { call } of callsTo(program, SUPABASE_SUBJECT)) {
      const options = optionsOf(call, 1);
      if (
        options === undefined ||
        (options !== null &&
          stringOf(propertyValue(options, "anonymousSignIns")) === "deny")
      ) {
        continue;
      }
      findings.push({
        code: "PD057",
        severity: "warning",
        message: `${file}:${lineAt(call.start).line} maps anonymous sign-ins as users, but rls.anonymousSignIns is 'deny'`,
        fix: "pass anonymousSignIns: 'deny' so the subject agrees with RLS",
      });
    }
  }
  return findings;
}

/**
 * PD041: `exchangeCapability` signing link tokens with the project's shared JWT
 * secret.
 */
export function pd041(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const { file, text, program } of parsedSources(sources)) {
    const lineAt = lineIndex(text);
    for (const { call } of callsTo(program, new Set(["exchangeCapability"]))) {
      const options = optionsOf(call, 1);
      if (
        options === null ||
        options === undefined ||
        stringOf(propertyValue(options, "alg")) !== "HS256"
      ) {
        continue;
      }
      findings.push({
        code: "PD041",
        severity: "warning",
        message: `${file}:${String(lineAt(call.start).line)} signs capability tokens with HS256, the project's shared JWT secret: whoever holds it can mint any user's token`,
        fix: "sign with alg: 'ES256' and the private JWK of an asymmetric Supabase signing key; keep HS256 for the local stack only",
      });
    }
  }
  return findings;
}

const ID_ROUTE = /^\/\S*(?::[A-Za-z_$][\w$]*|\{[A-Za-z_$][\w$]*\})/u;
const DYNAMIC_SEGMENT = /(?:^|[\\/])(\[[^\]/\\]+\])(?=[\\/])/u;

/**
 * The id-bearing route a `protect` call sits in: the file's dynamic segment, or
 * the route literal that is the first argument of a call around it.
 */
function idRouteOf(
  file: string,
  ancestors: readonly Estree[],
): string | undefined {
  const segment = DYNAMIC_SEGMENT.exec(file);
  if (segment !== null) {
    return segment[1];
  }
  for (const node of ancestors.toReversed()) {
    if (node.type !== "CallExpression") {
      continue;
    }
    const route = stringOf(nodes(node.arguments)[0]);
    if (route !== undefined && ID_ROUTE.test(route)) {
      return route;
    }
  }
  return undefined;
}

/**
 * PD036: a `protect(permission)` with no row loader on a route whose path names
 * an object id (BOLA, OWASP API1).
 */
export function pd036(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const { file, text, program } of parsedSources(sources)) {
    if (!importsPermDock(program)) {
      continue;
    }
    const lineAt = lineIndex(text);
    for (const { call, ancestors } of callsTo(program, new Set(["protect"]))) {
      const args = nodes(call.arguments);
      const only = args[0];
      if (
        args.length !== 1 ||
        only === undefined ||
        (only.type === "Literal" && only.value === null)
      ) {
        continue;
      }
      const route = idRouteOf(file, ancestors);
      if (route === undefined) {
        continue;
      }
      const permission = text.slice(only.start, only.end);
      findings.push({
        code: "PD036",
        severity: "warning",
        message: `${file}:${String(lineAt(call.start).line)} protects ${route} with ${permission} and no row loader, so the check never sees the row the id names (BOLA, OWASP API1)`,
        fix: "pass a loader that fetches the row by the id: protect(permission, (request) => load(request))",
      });
    }
  }
  return findings;
}
