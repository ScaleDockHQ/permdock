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
    claims["sub"] = principal.id;
    if (principal.tenant !== undefined) {
      claims[tenantClaim] = principal.tenant;
    }
  }
  if (role !== false) {
    claims["role"] = role;
  }
  const statements: SubjectStatement[] =
    role === false ? [] : [{ strings: [`set local role ${role}`], values: [] }];
  const dialect = options.dialect ?? "supabase";
  switch (dialect) {
    case "supabase":
    case "neon":
      statements.push(
        setConfig("request.jwt.claims", JSON.stringify(claims)),
        setConfig("request.jwt.claim.sub", principal?.id ?? ""),
      );
      return statements;
    case "guc": {
      const prefix = settingName(options.gucPrefix ?? "app", "setting prefix");
      statements.push(setConfig(`${prefix}.user_id`, principal?.id ?? ""));
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
