import { legacyKeySql } from "../rls/custom-role-rebuild.ts";
import { byKey } from "../shared/compare.ts";
import { quoteIdent, quoteLiteral } from "../sql/quote.ts";
import { CUSTOM_ROLES } from "../sql/shared.ts";

/**
 * A data migration that moves stored custom-role grants from former keys to
 * their current keys in `<schema>.custom_role_permissions`. A row whose
 * current-key twin already exists is deleted first, so the unique index holds;
 * the table's statement triggers recompile `custom_role_compiled`.
 */
export function renameGrantsSql(input: {
  readonly schema: string;
  /** Every former key and its current key, chains already resolved. */
  readonly renamed: Readonly<Record<string, string>>;
  /** The command line, for the header. */
  readonly invocation: string;
}): string {
  const table = `${quoteIdent(input.schema)}.${quoteIdent(CUSTOM_ROLES.permissions)}`;
  const formers = Object.keys(input.renamed)
    .toSorted()
    .map((key) => quoteLiteral(key))
    .join(", ");
  const current = (alias: string) =>
    legacyKeySql(
      `${alias}.permission`,
      { helpers: {}, keys: input.renamed },
      {},
    );
  const pairs = Object.entries(input.renamed)
    .toSorted(byKey)
    .map(([from, to]) => `--   ${from} -> ${to}`)
    .join("\n");
  return `-- ${input.invocation}
-- Moves stored custom-role grants to their current permission keys:
${pairs}

delete from ${table} d
where d.permission in (${formers})
  and exists (
    select 1
    from ${table} k
    where (to_jsonb(k) - 'permission') = (to_jsonb(d) - 'permission')
      and ${current("k")} = ${current("d")}
      and (k.permission not in (${formers}) or k.ctid < d.ctid)
  );

update ${table} r
set permission = ${current("r")}
where r.permission in (${formers});
`;
}
