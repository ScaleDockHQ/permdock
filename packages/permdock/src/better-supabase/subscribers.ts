import type { PermDockOptions } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy } from "../core/policy-types.ts";
import type { PrincipalSource } from "../core/principal-source.ts";

import { createPermDock } from "../core/permdock.ts";
import { loadPrincipal } from "../core/principal-source.ts";
import { subscribersFor } from "../delivery/audience.ts";

/** The fields of better-supabase's `OutboxEvent` the policy reads. */
export type SubscriberPolicyEvent = {
  readonly type: string;
  readonly tenant: string | null;
  readonly actorId: string | null;
  readonly payload: unknown;
};

export type SubscriberPolicyOptions<
  E extends SubscriberPolicyEvent = SubscriberPolicyEvent,
> = {
  readonly policy: Policy;
  /** Loads the sender and every subscriber's principal. */
  readonly principals: PrincipalSource;
  /**
   * The permission a subscriber needs for each event type: an exact type,
   * `prefix.*` or `*`, with the exact type first and then the longest
   * pattern. A type with no entry reaches no one.
   */
  readonly events: Readonly<Record<string, Permission>>;
  /** The row the permission is decided on. Defaults to `event.payload`, validated against the resource schema. */
  readonly row?: (event: E) => unknown;
  /** The principal the fan-out runs as in the event's tenant. Defaults to `event.actorId`. */
  readonly sender?: (event: E) => string | null | undefined;
  /** Sources for the sender's and subscribers' instances. */
  readonly options?: Omit<
    PermDockOptions,
    "tenant" | "actor" | "delegation" | "session" | "expiresAt" | "principals"
  >;
};

function permissionFor(
  events: Readonly<Record<string, Permission>>,
  type: string,
): Permission | undefined {
  if (Object.hasOwn(events, type)) return events[type];
  let best: string | undefined;
  for (const pattern of Object.keys(events)) {
    const matches =
      pattern === "*" ||
      (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));
    if (matches && (best === undefined || pattern.length > best.length)) {
      best = pattern;
    }
  }
  return best === undefined ? undefined : events[best];
}

/**
 * The per-subscriber check for better-supabase's webhooks-out, outbox and
 * realtime fan-out: the subscribers whose `principal` `decideFor` grants
 * the event type's permission on its row, in the event's tenant, as the
 * sender. An unmapped type, an event without a tenant or sender, a sender
 * outside the tenant and a throw reach no one.
 */
export function subscriberPolicy<
  E extends SubscriberPolicyEvent = SubscriberPolicyEvent,
>(
  options: SubscriberPolicyOptions<E>,
): <S extends { readonly principal: string }>(
  event: E,
  subscribers: readonly S[],
) => Promise<S[]> {
  return async (event, subscribers) => {
    try {
      const permission = permissionFor(options.events, event.type);
      const tenant = event.tenant;
      const senderId = options.sender?.(event) ?? event.actorId;
      if (
        permission === undefined ||
        tenant === null ||
        senderId === null ||
        senderId === undefined
      ) {
        return [];
      }
      const sender = await loadPrincipal(options.principals, senderId, tenant);
      if (sender === null) return [];
      const permdock = await createPermDock(
        options.policy,
        { principal: sender, context: {} },
        { ...options.options, principals: options.principals, tenant },
      );
      if (permdock.subject.principal?.tenant !== tenant) return [];
      return await subscribersFor(
        permdock,
        {
          permission,
          row: options.row === undefined ? event.payload : options.row(event),
        },
        subscribers,
      );
    } catch {
      return [];
    }
  };
}
