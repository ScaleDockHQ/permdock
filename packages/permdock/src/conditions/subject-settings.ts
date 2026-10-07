import type { Subject } from "../core/subject.ts";

export type WithSubjectOptions = {
  /** Which settings the generated policies read; match `rls.dialect`. Default `supabase`. */
  readonly dialect?: "supabase" | "guc" | "neon";
  /**
   * `set local role` before the settings: `authenticated` with a principal, `anon` without.
   * `false` keeps the connection's role, for a login role that RLS already applies to.
   */
  readonly role?: "authenticated" | "anon" | false;
  /** Prefix of the `guc` dialect's settings (`rls.gucPrefix`). Default `app`. */
  readonly gucPrefix?: string;
  /** Claim holding the principal's tenant (`rls.tenantClaim`). Default `tenant_id`. */
  readonly tenantClaim?: string;
  /**
   * Further claims from the verified token, such as `user_role` or `memberships` for `jwt`-mode
   * helpers. `sub`, `role` and the tenant claim always come from the subject.
   */
  readonly claims?: Readonly<Record<string, unknown>>;
  /**
   * Field names of the API-key claim written for a principal that acts through a credential
   * (`rls.apiKeys`). Default `{ claim: 'api_key', scopes: 'scopes', tenant: 'tenant', roles: 'roles' }`.
   */
  readonly apiKeys?: {
    readonly claim?: string;
    readonly scopes?: string;
    readonly tenant?: string;
    readonly roles?: string;
  };
};

/** One statement of the preamble: `strings` and `values` interleave like a tagged template. */
export type SubjectStatement = {
  readonly strings: readonly string[];
  readonly values: readonly string[];
};

type SubjectHolder = { readonly subject: Subject };

const NAME = /^[a-z_][a-z0-9_]*$/u;

function settingName(name: string, what: string): string {
  if (!NAME.test(name)) {
    throw new Error(`PermDock: unsafe ${what} '${name}'`);
  }
  return name;
}

type HeldCredential = {
  readonly id: string;
  readonly kind: "user" | "service";
  readonly tenant: string | undefined;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The credential a principal acts through. Entries limited to `ids` are left
 * out of `scopes`: the claim has no per-row form, so the database allows less.
 */
function heldCredential(principal: object): HeldCredential | undefined {
  const credential: unknown = Reflect.get(principal, "credential");
  if (
    !isRecord(credential) ||
    typeof credential["id"] !== "string" ||
    (credential["kind"] !== "user" && credential["kind"] !== "service") ||
    !Array.isArray(credential["permissions"])
  ) {
    return undefined;
  }
  const scopes = credential["permissions"].flatMap((entry: unknown) =>
    isRecord(entry) &&
    typeof entry["permission"] === "string" &&
    entry["ids"] === undefined
      ? [entry["permission"]]
      : [],
  );
  const tenant = credential["tenant"];
  return {
    id: credential["id"],
    kind: credential["kind"],
    tenant: typeof tenant === "string" && tenant !== "" ? tenant : undefined,
    roles: strings(credential["roles"]),
    scopes,
  };
}

function field(name: string | undefined, fallback: string): string {
  return settingName(name ?? fallback, "API-key claim field");
}

function apiKeyClaim(
  held: HeldCredential,
  options: WithSubjectOptions["apiKeys"] = {},
): readonly [string, Record<string, unknown>] {
  const claim: Record<string, unknown> = {
    id: held.id,
    [field(options.scopes, "scopes")]: held.scopes,
  };
  if (held.tenant !== undefined) {
    claim[field(options.tenant, "tenant")] = held.tenant;
  }
  if (held.kind === "service") {
    claim[field(options.roles, "roles")] = held.roles;
  }
  return [field(options.claim, "api_key"), claim];
}

function setConfig(name: string, value: string): SubjectStatement {
  return {
    strings: [`select set_config('${name}', `, ", true)"],
    values: [value],
  };
}

/**
 * The transaction preamble that makes Postgres see `permdock.subject`: the role, then the
 * claims the generated policies read. Runs inside the caller's transaction, so every setting
 * is local to it.
 */
export function subjectStatements(
  permdock: SubjectHolder,
  options: WithSubjectOptions = {},
): readonly SubjectStatement[] {
  const principal = permdock.subject.principal;
  const role = options.role ?? (principal === null ? "anon" : "authenticated");
  if (role !== false && role !== "authenticated" && role !== "anon") {
    throw new Error(
      `PermDock: withSubject sets role authenticated or anon, not '${String(role)}'`,
    );
  }
  const tenantClaim = settingName(
    options.tenantClaim ?? "tenant_id",
    "tenant claim",
  );
  const claims: Record<string, unknown> = Object.fromEntries(
    Object.entries(options.claims ?? {}).filter(
      ([name]) => name !== "sub" && name !== "role" && name !== tenantClaim,
    ),
  );
  if (principal !== null) {
    const held = heldCredential(principal);
    claims["sub"] = held?.kind === "service" ? "" : principal.id;
    if (principal.tenant !== undefined) {
      claims[tenantClaim] = principal.tenant;
    }
    if (held !== undefined) {
      const [name, value] = apiKeyClaim(held, options.apiKeys);
      claims[name] = value;
    }
  }
  if (role !== false) {
    claims["role"] = role;
  }
  const subjectId = typeof claims["sub"] === "string" ? claims["sub"] : "";
  const statements: SubjectStatement[] =
    role === false ? [] : [{ strings: [`set local role ${role}`], values: [] }];
  const dialect = options.dialect ?? "supabase";
  switch (dialect) {
    case "supabase":
    case "neon":
      statements.push(
        setConfig("request.jwt.claims", JSON.stringify(claims)),
        setConfig("request.jwt.claim.sub", subjectId),
      );
      return statements;
    case "guc": {
      const prefix = settingName(options.gucPrefix ?? "app", "setting prefix");
      statements.push(setConfig(`${prefix}.user_id`, subjectId));
      for (const [name, value] of Object.entries(claims)) {
        if (name === "sub") {
          continue;
        }
        statements.push(
          setConfig(
            `${prefix}.${settingName(name, "claim name")}`,
            typeof value === "string" ? value : JSON.stringify(value),
          ),
        );
      }
      return statements;
    }
    default: {
      const exhaustive: never = dialect;
      return exhaustive;
    }
  }
}

/** A statement as text with `$1`, `$2` placeholders, for raw executors. */
export function statementText(statement: SubjectStatement): string {
  let text = "";
  for (const [index, part] of statement.strings.entries()) {
    text = index === 0 ? part : `${text}$${String(index)}${part}`;
  }
  return text;
}

/** A statement as a template-strings array, for `sql` tags. */
export function statementTemplate(
  statement: SubjectStatement,
): TemplateStringsArray {
  // SAFETY: a string array with a matching `raw` array is the shape a template tag reads.
  return Object.assign([...statement.strings], {
    raw: [...statement.strings],
  }) as unknown as TemplateStringsArray;
}
