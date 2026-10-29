import type { CallExpression } from "oxc-parser";

import { Visitor, parseSync } from "oxc-parser";

import type { DoctorFinding, DoctorSource } from "../shared/doctor-types.ts";

/** Factories whose answers or entries only pay off when one is shared. */
const SHARED_FACTORIES: Readonly<Record<string, "PD080" | "PD081">> = {
  postgrestSources: "PD080",
  memoryVersionCache: "PD080",
  instanceCache: "PD081",
};

const MESSAGES: Readonly<
  Record<"PD080" | "PD081", { readonly what: string; readonly fix: string }>
> = {
  PD080: {
    what: "so every call starts with no shared version reads",
    fix: "create it once at module scope and pass the same object to every getPermDock call",
  },
  PD081: {
    what: "so every call gets an empty cache and no instance is reused",
    fix: "create one instanceCache() at module scope and pass it as instances to every adapter",
  },
};

function isPermDockSpecifier(value: string): boolean {
  return value === "permdock" || value.startsWith("permdock/");
}

type Call = { readonly call: CallExpression; readonly factory: string };

/**
 * The calls to `postgrestSources`, `memoryVersionCache` and `instanceCache`
 * imported from PermDock that sit inside a function body, except the right side
 * of a `??=`, which builds the object once.
 */
function callsInFunctions(source: DoctorSource): readonly Call[] {
  const { program } = parseSync(source.file, source.text);
  const names = new Map<string, string>();
  const namespaces = new Set<string>();
  const lazy: { start: number; end: number }[] = [];
  const found: Call[] = [];
  let depth = 0;
  const enter = (): void => {
    depth += 1;
  };
  const exit = (): void => {
    depth -= 1;
  };
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
          specifier.type === "ImportSpecifier" &&
          specifier.importKind !== "type"
        ) {
          const imported =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value;
          if (Object.hasOwn(SHARED_FACTORIES, imported)) {
            names.set(specifier.local.name, imported);
          }
        }
      }
    },
    FunctionDeclaration: enter,
    "FunctionDeclaration:exit": exit,
    FunctionExpression: enter,
    "FunctionExpression:exit": exit,
    ArrowFunctionExpression: enter,
    "ArrowFunctionExpression:exit": exit,
    AssignmentExpression(node) {
      if (node.operator === "??=") {
        lazy.push({ start: node.right.start, end: node.right.end });
      }
    },
    CallExpression(node) {
      if (depth === 0) {
        return;
      }
      const { callee } = node;
      let factory: string | undefined;
      if (callee.type === "Identifier") {
        factory = names.get(callee.name);
      } else if (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        namespaces.has(callee.object.name) &&
        callee.property.type === "Identifier" &&
        Object.hasOwn(SHARED_FACTORIES, callee.property.name)
      ) {
        factory = callee.property.name;
      }
      if (factory !== undefined) {
        found.push({ call: node, factory });
      }
    },
  }).visit(program);
  return found.filter(
    ({ call }) =>
      !lazy.some((range) => call.start >= range.start && call.end <= range.end),
  );
}

function findings(
  sources: readonly DoctorSource[],
  code: "PD080" | "PD081",
): readonly DoctorFinding[] {
  const out: DoctorFinding[] = [];
  for (const source of sources) {
    if (!source.text.includes("permdock")) {
      continue;
    }
    for (const { call, factory } of callsInFunctions(source)) {
      if (SHARED_FACTORIES[factory] !== code) {
        continue;
      }
      const line = source.text.slice(0, call.start).split("\n").length;
      out.push({
        code,
        severity: "warning",
        message: `${source.file}:${String(line)} creates ${factory}() inside a function, ${MESSAGES[code].what}`,
        fix: MESSAGES[code].fix,
      });
    }
  }
  return out;
}

/** PD080: `postgrestSources` or `memoryVersionCache` created per call. */
export function pd080(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  return findings(sources, "PD080");
}

/** PD081: `instanceCache` created per call. */
export function pd081(
  sources: readonly DoctorSource[],
): readonly DoctorFinding[] {
  return findings(sources, "PD081");
}
