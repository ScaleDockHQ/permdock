import type { Snapshot } from "permdock";

import { cacheLife, cacheTag } from "next/cache";
import { snapshotTag } from "permdock/next";

import type { Quote } from "../permissions.ts";

import { getPermDock, getSnapshot } from "../permdock/server.ts";
import { permissions } from "../permissions.ts";
import { findQuote, quotesOf, staffOf } from "./store.ts";

export const orgTag = (organization: string): string => `org:${organization}`;

/** A store read with when it ran and how long it took; a cache hit keeps both from the run that filled it. */
export type Loaded<T> = {
  readonly value: T;
  /** Milliseconds since the epoch. */
  readonly loadedAt: number;
  readonly tookMs: number;
};

async function timed<T>(read: Promise<T>): Promise<Loaded<T>> {
  const started = performance.now();
  const value = await read;
  return {
    value,
    loadedAt: Date.now(),
    tookMs: Math.round(performance.now() - started),
  };
}

/** Shared layer: rows every member of the organization may be shown, before a permission check. */
export async function getQuotes(
  organization: string,
): Promise<Loaded<Quote[]>> {
  "use cache";
  cacheTag(orgTag(organization));
  cacheLife("hours");
  const loaded = await timed(quotesOf(organization));
  return loaded;
}

export async function getStaff(
  organization: string,
): Promise<Loaded<{ readonly user: string; readonly role: string }[]>> {
  "use cache";
  cacheTag(orgTag(organization));
  cacheLife("hours");
  const loaded = await timed(staffOf(organization));
  return loaded;
}

/**
 * Private layer: the session's snapshot for one organization. `getSnapshot`
 * sets `stale` from the snapshot (at least 30 s, so per-link prefetches carry
 * it; 300 s, so it joins the App Shell) and tags it for this subject.
 */
export async function loadSnapshot(organization: string): Promise<Snapshot> {
  "use cache: private";
  const snapshot = await getSnapshot({
    tenant: organization,
    tags: [orgTag(organization)],
  });
  return snapshot;
}

/** The quotes this session may read: every quote for staff, only their customer's for a contact. */
export async function visibleQuotes(
  organization: string,
): Promise<Loaded<Quote[]>> {
  "use cache: private";
  const permdock = await getPermDock({ tenant: organization });
  cacheLife({ stale: 300 });
  cacheTag(snapshotTag(permdock.subject.principal?.id), orgTag(organization));
  const quotes = await getQuotes(organization);
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
 */
export async function quoteAccess(
  organization: string,
  id: string,
): Promise<Loaded<QuoteAccess>> {
  "use cache: private";
  const permdock = await getPermDock({ tenant: organization });
  cacheLife({ stale: 300 });
  cacheTag(snapshotTag(permdock.subject.principal?.id), orgTag(organization));
  const loaded = await timed(findQuote(organization, id));
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
