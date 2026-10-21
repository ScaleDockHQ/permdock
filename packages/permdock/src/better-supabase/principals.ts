import type {
  PrincipalIdentity,
  PrincipalSource,
} from "../core/principal-source.ts";
import type { Principal } from "../core/subject.ts";
import type { BetterSupabaseSubjectOptions } from "./subject.ts";

import { isRecord } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { subjectFromBetterSupabase } from "./subject.ts";

/**
 * Where an identity link points: an app user, whose claims `principal` loads,
 * or a contact the app stores itself, which must be `kind: 'contact'`.
 */
export type BetterSupabaseIdentityLink =
  | { readonly user: string }
  | { readonly contact: Principal };

type Maybe<T> = T | null | undefined | Promise<T | null | undefined>;

export type PrincipalSourceOptions = {
  /**
   * The claims better-supabase mints for `userId` now, or `null` for a user
   * deleted, suspended or unknown. `sqlSupportStore(…).claims`, which runs the
   * custom access token hook, fills it.
   */
  readonly claims: (
    userId: string,
    options: { readonly tenant?: string },
  ) => Maybe<Readonly<Record<string, unknown>>>;
  /**
   * The identity link for an email address or chat user. Only links the app
   * created through a signed-in link flow or a verified address count. Without
   * it the source has no `principalByIdentity`.
   */
  readonly identities?: (
    identity: PrincipalIdentity,
  ) => Maybe<BetterSupabaseIdentityLink>;
  /**
   * How the claims map to a principal; the defaults of
   * `subjectFromBetterSupabase`.
   */
  readonly subject?: Omit<BetterSupabaseSubjectOptions, "apiKeys">;
};

/**
 * A `PrincipalSource` over better-supabase: `principal(id)` maps the claims
 * `claims` loads with `subjectFromBetterSupabase`, and `principalByIdentity`
 * follows `identities` to a user or a contact. Claims for another user, a link
 * to a non-contact principal and a missing link are `null`.
 */
export function principalSource(
  options: PrincipalSourceOptions,
): PrincipalSource {
  const principal = async (
    id: string,
    lookup: { readonly tenant?: string } = {},
  ): Promise<Principal | null> => {
    const claims = await options.claims(
      id,
      lookup.tenant === undefined ? {} : { tenant: lookup.tenant },
    );
    if (!isRecord(claims)) return null;
    const found = subjectFromBetterSupabase(
      { kind: "user", claims },
      options.subject,
    ).principal;
    return found?.id === id ? freezeDeep(structuredClone(found)) : null;
  };
  const { identities } = options;
  return Object.freeze({
    principal,
    ...(identities === undefined
      ? {}
      : {
          async principalByIdentity(
            identity: PrincipalIdentity,
          ): Promise<Principal | null> {
            const link = await identities(identity);
            if (!isRecord(link)) return null;
            if ("user" in link) {
              return typeof link.user === "string"
                ? principal(link.user)
                : null;
            }
            const contact = link.contact;
            return isRecord(contact) && contact.kind === "contact"
              ? freezeDeep(structuredClone(contact))
              : null;
          },
        }),
  });
}
