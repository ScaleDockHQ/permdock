import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { WhoCan } from "../core/who-can.ts";

import { whoCan } from "../core/who-can.ts";

export type Audience = {
  /**
   * Principal ids `decideFor` grants, in discovery or candidate order, each
   * once.
   */
  readonly principals: readonly string[];
  /**
   * `false` when `whoCan` could not list every holder: someone granted may be
   * missing.
   */
  readonly complete: boolean;
};

export type AudienceOptions = {
  /** Check only these principals instead of listing holders with `whoCan`. */
  readonly candidates?: readonly string[];
};

async function granted(
  permdock: PermDock,
  ids: readonly string[],
  permission: Permission,
  row: unknown,
): Promise<string[]> {
  const unique = [
    ...new Set(ids.filter((id) => typeof id === "string" && id !== "")),
  ];
  const decisions = await Promise.all(
    unique.map(async (id) => {
      try {
        return (await permdock.decideFor(id, permission, row)).outcome;
      } catch {
        return "denied";
      }
    }),
  );
  return unique.filter((_, index) => decisions[index] === "granted");
}

/**
 * Who may receive a delivery about `row`: the holders `whoCan` lists (or
 * `candidates`), kept only where `decideFor` grants `permission` in the
 * sender's active tenant. A collection permission has no holders to list, so it
 * needs `candidates`; without them it is empty and incomplete.
 */
export async function audience(
  permdock: PermDock,
  permission: Permission,
  row: unknown,
  options: AudienceOptions = {},
): Promise<Audience> {
  if (options.candidates !== undefined) {
    return Object.freeze({
      principals: Object.freeze(
        await granted(permdock, options.candidates, permission, row),
      ),
      complete: true,
    });
  }
  if (permission.kind !== "instance" || permdock.subject.principal === null) {
    return Object.freeze({
      principals: Object.freeze([]),
      complete: permdock.subject.principal === null,
    });
  }
  let listed: WhoCan;
  try {
    // SAFETY: `kind` is "instance", checked above.
    listed = await whoCan(
      permdock,
      permission as Permission<string, unknown, "instance">,
      row,
    );
  } catch {
    return Object.freeze({ principals: Object.freeze([]), complete: false });
  }
  return Object.freeze({
    principals: Object.freeze(
      await granted(
        permdock,
        listed.holders.map((holder) => holder.principal.id),
        permission,
        row,
      ),
    ),
    complete: listed.complete,
  });
}

/** One event a subscriber may receive: the permission its row needs. */
export type SubscriberEvent = {
  readonly permission: Permission;
  readonly row?: unknown;
};

/**
 * The subscribers whose principal `decideFor` grants the event's permission on
 * its row, in their order: the per-event filter for webhook endpoints and
 * realtime channels. A subscriber without a string `principal` is dropped.
 */
export async function subscribersFor<S extends { readonly principal: string }>(
  permdock: PermDock,
  event: SubscriberEvent,
  subscribers: readonly S[],
): Promise<S[]> {
  const ids = subscribers
    .map((subscriber) => subscriber.principal)
    .filter((id): id is string => typeof id === "string");
  const allowed = new Set(
    await granted(permdock, ids, event.permission, event.row),
  );
  return subscribers.filter(
    (subscriber) =>
      typeof subscriber.principal === "string" &&
      allowed.has(subscriber.principal),
  );
}
