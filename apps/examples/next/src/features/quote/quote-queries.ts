import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { cacheLifeFor } from "permdock/next";

import type { Loaded } from "../../lib/loaded.ts";
import type { Quote } from "../../permissions.ts";

import { timed } from "../../lib/loaded.ts";
import { findQuote, quotesOf } from "../../lib/store.ts";
import { getPermDock } from "../../permdock/server.ts";
import { permissions } from "../../permissions.ts";
import { orgTag } from "../organization/organization-cache.ts";
import { quoteReadTags } from "./quote-cache.ts";

/**
 * Shared layer: rows every member of the organization may be shown, before a
 * permission check. Every write calls `updateTag(orgTag(...))`, so the entry
 * lives until then.
 */
export async function getQuotes(
  organization: string,
): Promise<Loaded<Quote[]>> {
  "use cache";
  cacheTag(orgTag(organization));
  cacheLife("max");
  const loaded = await timed(quotesOf(organization));
  return loaded;
}

export async function getQuote(
  organization: string,
  id: string,
): Promise<Loaded<Quote | null>> {
  "use cache";
  cacheTag(orgTag(organization));
  cacheLife("max");
  const loaded = await timed(findQuote(organization, id));
  return loaded;
}

/**
 * The quotes this session may read: every quote for staff, only their
 * customer's for a contact.
 */
export async function visibleQuotes(
  organization: string,
): Promise<Loaded<Quote[]>> {
  "use cache: private";
  const [permdock, quotes] = await Promise.all([
    getPermDock({ tenant: organization }),
    getQuotes(organization),
  ]);
  cacheLife(cacheLifeFor(permdock.subject));
  cacheTag(...quoteReadTags(organization, permdock.subject.principal?.id));
  return {
    ...quotes,
    value: permdock.filter(permissions.quote.read, quotes.value),
  };
}

export type QuoteAccess = {
  readonly quote: Quote | null;
  readonly approve: boolean;
};

/**
 * Keyed on the quote id, so a `<Link prefetch={true}>` to the quote resolves
 * its gated actions before the click. A quote the session may not read is null.
 * The server never stores a private result, so every prefetch re-runs this
 * function; the row read stays in `getQuote` to keep it off the store.
 */
export async function quoteAccess(
  organization: string,
  id: string,
): Promise<Loaded<QuoteAccess>> {
  "use cache: private";
  const [permdock, loaded] = await Promise.all([
    getPermDock({ tenant: organization }),
    getQuote(organization, id),
  ]);
  cacheLife(cacheLifeFor(permdock.subject));
  cacheTag(...quoteReadTags(organization, permdock.subject.principal?.id));
  const quote = loaded.value;
  if (quote === null || !permdock.can(permissions.quote.read, quote)) {
    return { ...loaded, value: { quote: null, approve: false } };
  }
  const granted = permdock.actions(permissions.quote, quote);
  return {
    ...loaded,
    value: {
      quote,
      approve: granted.some(
        (permission) => permission.key === permissions.quote.approve.key,
      ),
    },
  };
}
