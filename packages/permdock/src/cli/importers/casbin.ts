import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { CommandResult } from "../shared/result.ts";
import type { ImportedGrant, ImportedRole } from "./policy-module.ts";

import { emitPolicyModule, isIdentifier } from "./policy-module.ts";

/** Why a Casbin policy line did not import. */
export type CasbinSkipReason =
  | "user-grant"
  | "domain-grant"
  | "not-an-identifier"
  | "deny-without-effect"
  | "malformed";

export type CasbinSkip = {
  readonly line: number;
  readonly text: string;
  readonly reason: CasbinSkipReason;
  readonly detail: string;
  /** Set when the line was a deny: leaving it out widens access. */
  readonly deny?: true;
};

/** A user's role, from a `g` line: PermDock reads it from a membership source, never from the policy. */
export type CasbinAssignment = {
  readonly user: string;
  readonly role: string;
  readonly domain?: string;
};

type Model = {
  readonly domains: boolean;
  readonly roles: boolean;
  readonly denies: boolean;
};

const MATCHER_TERMS = new Set([
  "g(r.sub,p.sub)",
  "g(r.sub,p.sub,r.dom)",
  "r.obj==p.obj",
  "r.act==p.act",
  "r.dom==p.dom",
]);

function sections(
  text: string,
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const found = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const header = /^\[(\w+)\]$/u.exec(line)?.[1];
    if (header !== undefined) {
      current = new Map();
      found.set(header, current);
      continue;
    }
    const at = line.indexOf("=");
    if (current !== undefined && at > 0) {
      current.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }
  return found;
}

function fieldsOf(value: string | undefined): readonly string[] {
  return (value ?? "").split(",").map((item) => item.trim());
}

/**
 * The model, when it is RBAC (optionally with domains) under the standard
 * matcher; otherwise the terms that are not. Deny rows need `p.eft` and an
 * effect that lets a deny override an allow, as PermDock always does.
 */
export function readCasbinModel(
  text: string,
): Model | { readonly refused: string } {
  const model = sections(text);
  const request = fieldsOf(model.get("request_definition")?.get("r"));
  const policy = fieldsOf(model.get("policy_definition")?.get("p"));
  const domains = request.includes("dom");
  const expected = domains
    ? ["sub", "dom", "obj", "act"]
    : ["sub", "obj", "act"];
  if (request.join(",") !== expected.join(",")) {
    return {
      refused: `r = ${request.join(", ")}: casbin import reads r = ${expected.join(", ")}`,
    };
  }
  const withEffect =
    policy.length === expected.length + 1 && policy.at(-1) === "eft";
  if (
    policy.slice(0, expected.length).join(",") !== expected.join(",") ||
    (policy.length !== expected.length && !withEffect)
  ) {
    return {
      refused: `p = ${policy.join(", ")}: casbin import reads p = ${expected.join(", ")}[, eft]`,
    };
  }
  const matcher = model.get("matchers")?.get("m") ?? "";
  const terms = matcher
    .replaceAll(/\s+/gu, "")
    .split("&&")
    .filter((term) => term !== "");
  const unsupported = terms.filter((term) => !MATCHER_TERMS.has(term));
  if (terms.length === 0 || unsupported.length > 0) {
    return {
      refused: `the matcher has terms casbin import cannot read: ${unsupported.join(" && ") || "(empty)"}; it reads g(r.sub, p.sub[, r.dom]), r.dom == p.dom, r.obj == p.obj and r.act == p.act`,
    };
  }
  const effect = (model.get("policy_effect")?.get("e") ?? "").replaceAll(
    /\s+/gu,
    "",
  );
  const allowOnly = effect === "some(where(p.eft==allow))";
  const denyOverrides =
    effect === "some(where(p.eft==allow))&&!some(where(p.eft==deny))";
  if (!allowOnly && !denyOverrides) {
    return {
      refused: `e = ${effect}: casbin import reads allow-only or deny-override effects; PermDock's deny always overrides an allow`,
    };
  }
  return {
    domains,
    roles: model.get("role_definition")?.get("g") !== undefined,
    denies: withEffect && denyOverrides,
  };
}

type Line = {
  readonly number: number;
  readonly text: string;
  readonly cells: readonly string[];
};

function policyLines(text: string): readonly Line[] {
  const lines: Line[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line !== "" && !line.startsWith("#")) {
      lines.push({
        number: index + 1,
        text: line,
        cells: line.split(",").map((cell) => cell.trim()),
      });
    }
  }
  return lines;
}

export type CasbinImport = {
  readonly actions: ReadonlyMap<string, ReadonlySet<string>>;
  readonly roles: readonly ImportedRole[];
  readonly assignments: readonly CasbinAssignment[];
  readonly skipped: readonly CasbinSkip[];
};

/** Every grant `role` holds through `g` role-to-role lines, its own included; a cycle stops. */
function inherited(
  role: string,
  own: ReadonlyMap<string, readonly ImportedGrant[]>,
  parents: ReadonlyMap<string, readonly string[]>,
): readonly ImportedGrant[] {
  const seen = new Set<string>();
  const grants: ImportedGrant[] = [];
  const visit = (name: string): void => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    grants.push(...(own.get(name) ?? []));
    for (const parent of parents.get(name) ?? []) {
      visit(parent);
    }
  };
  visit(role);
  return grants;
}

/**
 * Casbin RBAC policy lines as PermDock roles. A `p` line whose subject is a
 * role becomes a grant; a role that inherits another (`g, editor, viewer`)
 * holds its grants too, flattened, because code roles do not nest. A `g` line
 * for a user becomes an assignment the application loads as a membership.
 */
export function importCasbin(model: Model, policy: string): CasbinImport {
  const lines = policyLines(policy);
  const skipped: CasbinSkip[] = [];
  const width = model.domains ? 4 : 3;
  const roleNames = new Set<string>();
  for (const line of lines) {
    if (line.cells[0] === "g" && line.cells[2] !== undefined) {
      roleNames.add(line.cells[2]);
    }
  }
  const parents = new Map<string, string[]>();
  const assignments: CasbinAssignment[] = [];
  for (const line of lines.filter((item) => item.cells[0] === "g")) {
    const [, member, role, domain] = line.cells;
    if (member === undefined || role === undefined) {
      skipped.push({
        line: line.number,
        text: line.text,
        reason: "malformed",
        detail: "a g line names a member and a role",
      });
      continue;
    }
    if (roleNames.has(member)) {
      parents.set(member, [...(parents.get(member) ?? []), role]);
    } else {
      assignments.push({
        user: member,
        role,
        ...(domain === undefined || domain === "" ? {} : { domain }),
      });
    }
  }
  const own = new Map<string, ImportedGrant[]>();
  const actions = new Map<string, Set<string>>();
  for (const line of lines.filter((item) => item.cells[0] === "p")) {
    const cells = line.cells.slice(1);
    const subject = cells[0] ?? "";
    const domain = model.domains ? cells[1] : undefined;
    const [object, action] = cells.slice(model.domains ? 2 : 1);
    const eft = cells[width];
    const skip = (reason: CasbinSkipReason, detail: string): void => {
      skipped.push({
        line: line.number,
        text: line.text,
        reason,
        detail,
        ...(eft === "deny" ? { deny: true as const } : {}),
      });
    };
    if (object === undefined || action === undefined) {
      skip("malformed", `a p line has ${String(width)} fields`);
      continue;
    }
    if (!roleNames.has(subject)) {
      skip(
        "user-grant",
        `${subject} is not a role any g line names; PermDock grants roles, never users`,
      );
      continue;
    }
    if (domain !== undefined && domain !== "*") {
      skip(
        "domain-grant",
        `the grant holds only in domain ${domain}; a per-tenant grant is a custom role (CustomRoleSource)`,
      );
      continue;
    }
    if (eft === "deny" && !model.denies) {
      skip("deny-without-effect", "the model's effect never applies a deny");
      continue;
    }
    if (!isIdentifier(object) || !isIdentifier(action)) {
      skip(
        "not-an-identifier",
        `${object}.${action} is not a permission key; patterns and paths do not import`,
      );
      continue;
    }
    const set = actions.get(object) ?? new Set<string>();
    actions.set(object, set);
    set.add(action);
    own.set(subject, [
      ...(own.get(subject) ?? []),
      { effect: eft === "deny" ? "deny" : "allow", resource: object, action },
    ]);
  }
  const roles = [...roleNames].map((name) => ({
    name,
    grants: inherited(name, own, parents),
  }));
  return { actions, roles, assignments, skipped };
}

function readText(
  cwd: string,
  flag: string,
  path: string | undefined,
): string | { readonly error: string } {
  if (path === undefined) {
    return { error: `casbin import needs ${flag} <file>` };
  }
  const full = resolve(cwd, path);
  return existsSync(full)
    ? readFileSync(full, "utf8")
    : { error: `casbin import ${flag}: ${path} does not exist` };
}

/**
 * `permdock casbin import`: an RBAC model and its policy CSV into a
 * `permissions` and `policy` module, with user assignments as data. Exits 1
 * when a deny line did not import, because leaving one out would widen access.
 */
export function runCasbinImport(input: {
  readonly cwd: string;
  readonly model: string | undefined;
  readonly policy: string | undefined;
  readonly out: string | undefined;
  readonly json: boolean;
}): CommandResult {
  if (input.out === undefined) {
    return { code: 2, output: "casbin import needs --out <file>" };
  }
  const modelText = readText(input.cwd, "--model", input.model);
  const policyText = readText(input.cwd, "--policy", input.policy);
  for (const read of [modelText, policyText]) {
    if (typeof read !== "string") {
      return { code: 2, output: read.error };
    }
  }
  const model = readCasbinModel(String(modelText));
  if ("refused" in model) {
    return { code: 2, output: `casbin import --model: ${model.refused}` };
  }
  const imported = importCasbin(model, String(policyText));
  const out = resolve(input.cwd, input.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    emitPolicyModule({
      generator: "casbin import",
      actions: imported.actions,
      roles: imported.roles,
      exports: { assignments: imported.assignments },
    }),
  );
  const droppedDeny = imported.skipped.some((item) => item.deny === true);
  const code = droppedDeny ? 1 : 0;
  if (input.json) {
    return {
      code,
      output: JSON.stringify({
        out: input.out,
        assignments: imported.assignments.length,
        skipped: imported.skipped,
      }),
    };
  }
  return {
    code,
    output: [
      ...imported.skipped.map(
        (item) =>
          `${item.reason}: line ${String(item.line)} (${item.text}): ${item.detail}`,
      ),
      `casbin import: wrote ${String(imported.roles.length)} role(s) and ${String(imported.assignments.length)} assignment(s) to ${input.out}, skipped ${String(imported.skipped.length)}${droppedDeny ? "; a deny line did not import, so the policy allows more than the model: map it by hand" : ""}`,
    ].join("\n"),
  };
}
