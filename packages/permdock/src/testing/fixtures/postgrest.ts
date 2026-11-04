import type { MemberEntry } from "../../core/interfaces.ts";
import type { SubjectRecord } from "../../core/subject-cache.ts";
import type {
  SupabaseRpcClient,
  SupabaseRpcResult,
} from "../../supabase/postgrest.ts";

export type PostgrestFixtureOptions = {
  /** The users `subject_for` knows, by id. An unknown user answers `null`. */
  readonly subjects: Readonly<Record<string, SubjectRecord>>;
  /**
   * `authz_version_for` by id. A user missing here answers the `authzVersion`
   * of its record.
   */
  readonly versions?: Readonly<Record<string, number>>;
  /** What `members_of` returns for the entries whose scope and id match. */
  readonly members?: readonly MemberEntry[];
};

export type PostgrestFixtureCall = {
  readonly schema: string;
  readonly fn: string;
  readonly args: Readonly<Record<string, unknown>>;
};

export type PostgrestFixture = SupabaseRpcClient & {
  /** Every RPC the code under test made, in order. */
  readonly calls: readonly PostgrestFixtureCall[];
};

const answer = (data: unknown): SupabaseRpcResult => ({ data, error: null });

/**
 * A Supabase client double that answers the three functions `postgrestSources`
 * calls, `subject_for`, `authz_version_for` and `members_of`, under any schema
 * and any wrapper prefix (`permdock_subject_for` answers as `subject_for`). Any
 * other function answers an error.
 */
export function postgrestFixture(
  options: PostgrestFixtureOptions,
): PostgrestFixture {
  const calls: PostgrestFixtureCall[] = [];
  const read = (fn: string, args: Readonly<Record<string, unknown>>) => {
    const user = String(args["p_user"]);
    const record = options.subjects[user];
    if (fn.endsWith("authz_version_for")) {
      return answer(options.versions?.[user] ?? record?.authzVersion ?? null);
    }
    if (fn.endsWith("subject_for")) {
      return answer(record ?? null);
    }
    if (fn.endsWith("members_of")) {
      return answer(
        (options.members ?? []).filter(
          ({ membership }) =>
            membership.scope === args["p_scope"] &&
            membership.id === args["p_id"],
        ),
      );
    }
    return { data: null, error: { message: `unknown function ${fn}` } };
  };
  return {
    calls,
    schema: (schema) => ({
      rpc: async (fn, args) => {
        calls.push({ schema, fn, args });
        return read(fn, args);
      },
    }),
  };
}
