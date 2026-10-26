import type {
  Approver as BetterSupabaseApprover,
  ApprovalRequestRef,
  AuthorizationHooks,
  AutomationRef,
  DelegationRef,
  IdentityRef,
  IdentityTarget,
  TicketSubject,
} from "better-supabase/server";

import type { Approver } from "../core/approvers.ts";
import type { PermDock, PermDockOptions } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy } from "../core/policy-types.ts";
import type { PrincipalSource } from "../core/principal-source.ts";
import type { ProviderApprovers } from "./approvers.ts";
import type { BetterSupabaseSubjectOptions } from "./subject.ts";
import type { SubscriberPolicyEvent } from "./subscribers.ts";
import type { SupportPolicyOptions } from "./support.ts";

import { asApprover } from "../core/approval-normalize.ts";
import { flattenApprovers } from "../core/approvers.ts";
import { isRecord } from "../core/compact.ts";
import { scopesReaching } from "../core/oauth-scopes.ts";
import { getPermDock } from "../core/permdock.ts";
import {
  findPermission,
  listPermissions,
} from "../core/permission-registry.ts";
import { subjectFromBetterSupabase } from "./subject.ts";
import { subscriberPolicy } from "./subscribers.ts";
import { supportPolicy } from "./support.ts";

type Maybe<T> = T | null | undefined | Promise<T | null | undefined>;
type Claims = Readonly<Record<string, unknown>>;
type RequestContext = NonNullable<Awaited<ReturnType<TicketSubject>>>;

/** better-supabase's claim that caps a context to the permission keys it lists. */
const PERMISSION_CAP_CLAIM = "bsb_permission_cap";

export type AuthorizationHooksOptions = {
  readonly policy: Policy;
  /**
   * The claims better-supabase mints for `userId` now, or `null` for a user
   * deleted, suspended or unknown: the same loader `principalSource` takes.
   */
  readonly claims: (
    userId: string,
    options: { readonly tenant?: string },
  ) => Maybe<Claims>;
  /**
   * How the claims map to a subject; the defaults of
   * `subjectFromBetterSupabase`.
   */
  readonly subject?: Omit<BetterSupabaseSubjectOptions, "apiKeys">;
  /** Sources for every instance the hooks build. */
  readonly options?: Omit<
    PermDockOptions,
    "tenant" | "actor" | "delegation" | "session" | "expiresAt"
  >;
  /**
   * The claims an organization-owned automation runs as in `tenant`, such as
   * its default service principal's. Without it such an automation runs as no
   * one.
   */
  readonly service?: (tenant: string | null) => Maybe<Claims>;
  /**
   * The `principalSource` for `identities` and `delivery`; without it neither
   * hook is set.
   */
  readonly principals?: PrincipalSource;
  /**
   * The permission each event type needs, for `delivery` (`subscriberPolicy`'s
   * `events`).
   */
  readonly events?: Readonly<Record<string, Permission>>;
  /** The row a delivery check decides on; defaults to `event.payload`. */
  readonly row?: (event: SubscriberPolicyEvent) => unknown;
  /**
   * Who may approve each request kind, as for `authorizationProvider`; sets
   * `approverOf`.
   */
  readonly approvers?: ProviderApprovers;
  /** `supportPolicy`'s options without `policy`; sets `support.authorize`. */
  readonly support?: Omit<SupportPolicyOptions, "policy">;
  /**
   * The user and tenant a run ticket stands for, looked up in the app's store;
   * `null` refuses the ticket. Sets `tickets.subject`, which loads the user's
   * current claims, so a suspended user's ticket runs as no one.
   */
  readonly tickets?: (
    ticket: string,
  ) => Maybe<{ readonly userId: string; readonly tenant?: string }>;
};

/**
 * Whether `permdock` is granted `key` with no row; an unknown key and
 * `approval-required` are `false`.
 */
function grants(permdock: PermDock, key: string): boolean {
  const permission = findPermission(permdock.permissions, key);
  return (
    permission !== undefined &&
    permdock.decide(permission, undefined).outcome === "granted"
  );
}

/**
 * A list matches when every entry does, `anyOf` when one does; other leaves
 * match nobody, as in SQL.
 */
function matches(
  approvers: Approver | readonly Approver[],
  userId: string,
  permdock: PermDock,
): boolean {
  const items = flattenApprovers(approvers);
  return (
    items.length > 0 &&
    items.every((item) => {
      switch (item.kind) {
        case "user":
          return item.id === userId;
        case "permission":
          return grants(permdock, item.permission);
        case "any-of":
          return item.of.some((entry) => matches(entry, userId, permdock));
        case "actor":
        case "anyone":
        case "assurance":
        case "authenticated":
        case "inherit":
        case "plan":
        case "relation":
        case "role":
          return false;
        default: {
          const exhaustive: never = item;
          return exhaustive;
        }
      }
    })
  );
}

/**
 * better-supabase's `AuthorizationHooks` (`createServer(betterSupabase, {
 * authorization })`), decided by `policy`. Every hook builds the principal's
 * instance from the claims `claims` loads now, never from the request, and
 * fails closed: a throw, an unknown key and `approval-required` refuse.
 * `automation` and `delegation` are always set; `identities`, `delivery`,
 * `approverOf`, `support` and `tickets` only with the options they read.
 * `delegation.permissions` maps each scope to the keys whose `.scope` it is,
 * was renamed from, or that a policy `oauthScopes` entry covers, and reads no
 * `authorization_details`.
 */
export function authorizationHooks(
  options: AuthorizationHooksOptions,
): AuthorizationHooks {
  const { policy } = options;
  const instance = async (
    claims: Claims,
    tenant: string | null | undefined,
  ): Promise<PermDock | null> => {
    const subject = subjectFromBetterSupabase(
      { kind: "user", claims },
      options.subject,
    );
    if (subject.principal === null) return null;
    const permdock = await getPermDock(policy, subject, {
      ...options.options,
      ...(tenant === null || tenant === undefined ? {} : { tenant }),
    });
    return tenant === null ||
      tenant === undefined ||
      permdock.subject.principal?.tenant === tenant
      ? permdock
      : null;
  };
  const holdsAll = async (
    claims: Claims,
    automation: AutomationRef,
  ): Promise<boolean> => {
    const permdock = await instance(claims, automation.tenant);
    return (
      permdock !== null &&
      automation.permissions.every((key) => grants(permdock, key))
    );
  };
  const claimsOf = async (
    userId: string,
    tenant: string | null | undefined,
  ): Promise<Claims | null> => {
    const claims = await options.claims(
      userId,
      tenant === null || tenant === undefined ? {} : { tenant },
    );
    return isRecord(claims) && claims["sub"] === userId ? claims : null;
  };

  const automation: NonNullable<AuthorizationHooks["automation"]> = {
    async mayPublish(ref) {
      try {
        return ref.publisher !== null && (await holdsAll(ref.claims, ref));
      } catch {
        return false;
      }
    },
    async runAs(ref) {
      try {
        const claims =
          ref.publisher === null
            ? await options.service?.(ref.tenant)
            : await claimsOf(ref.publisher, ref.tenant);
        if (!isRecord(claims) || !(await holdsAll(claims, ref))) return null;
        return Object.freeze({
          ...claims,
          [PERMISSION_CAP_CLAIM]: [...ref.permissions],
        });
      } catch {
        return null;
      }
    },
  };

  const delegation: NonNullable<AuthorizationHooks["delegation"]> = {
    permissions(ref: DelegationRef) {
      try {
        const scopes = new Set(ref.scopes);
        return listPermissions(policy.permissions)
          .filter((permission) =>
            scopesReaching(policy, permission).some((scope) =>
              scopes.has(scope),
            ),
          )
          .map((permission) => permission.key);
      } catch {
        return [];
      }
    },
  };

  const { principals, events, approvers, support, tickets } = options;
  const approverOf =
    approvers === undefined
      ? undefined
      : async (
          approver: BetterSupabaseApprover,
          request: ApprovalRequestRef,
        ): Promise<boolean> => {
          try {
            if (
              approver.userId === request.requester ||
              !Object.hasOwn(approvers, request.kind)
            ) {
              return false;
            }
            const given = approvers[request.kind];
            if (
              given === undefined ||
              approver.claims["sub"] !== approver.userId
            ) {
              return false;
            }
            const permdock = await instance(approver.claims, request.tenant);
            return (
              permdock !== null &&
              matches(asApprover(given), approver.userId, permdock)
            );
          } catch {
            return false;
          }
        };

  const identities =
    principals?.principalByIdentity === undefined
      ? undefined
      : {
          async principalByIdentity(
            identity: IdentityRef,
          ): Promise<IdentityTarget | null> {
            try {
              const found = await principals.principalByIdentity?.(identity);
              if (found === null || found === undefined) return null;
              return found.kind === "contact"
                ? { kind: "contact", contactId: found.id }
                : { kind: "user", userId: found.id };
            } catch {
              return null;
            }
          },
        };

  const fanOut =
    principals === undefined || events === undefined
      ? undefined
      : subscriberPolicy({
          policy,
          principals,
          events,
          ...(options.row === undefined ? {} : { row: options.row }),
          ...(options.options === undefined
            ? {}
            : { options: options.options }),
        });

  return Object.freeze({
    apiVersion: 1,
    name: "PermDock",
    automation: Object.freeze(automation),
    delegation: Object.freeze(delegation),
    ...(approverOf === undefined ? {} : { approverOf }),
    ...(identities === undefined
      ? {}
      : { identities: Object.freeze(identities) }),
    ...(fanOut === undefined
      ? {}
      : { delivery: Object.freeze({ subscribers: fanOut, audience: fanOut }) }),
    ...(support === undefined
      ? {}
      : {
          support: Object.freeze({
            authorize: supportPolicy({ ...support, policy }),
          }),
        }),
    ...(tickets === undefined
      ? {}
      : {
          tickets: Object.freeze({
            async subject(ticket: string): Promise<RequestContext | null> {
              try {
                const found = await tickets(ticket);
                if (!isRecord(found) || typeof found.userId !== "string") {
                  return null;
                }
                const claims = await claimsOf(found.userId, found.tenant);
                return claims === null
                  ? null
                  : {
                      claims,
                      ...(found.tenant === undefined
                        ? {}
                        : { tenant: found.tenant }),
                    };
              } catch {
                return null;
              }
            },
          }),
        }),
  });
}
