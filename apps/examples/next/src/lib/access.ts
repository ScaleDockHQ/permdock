import type { Snapshot } from 'permdock';

import { cacheLife, cacheTag } from 'next/cache';
import { snapshotFor } from 'permdock';
import { cacheLifeFor } from 'permdock/next';

import type { Quote } from '../permissions.ts';

import { getPermDock } from '../permdock/server.ts';
import { permissions } from '../permissions.ts';
import { policy } from '../policy.ts';
import { currentUser } from './session.ts';
import { findQuote, quotesOf, staffOf } from './store.ts';

export const userTag = (user: string | null | undefined): string =>
  `permdock:${user ?? 'anon'}`;

export const orgTag = (organization: string): string => `org:${organization}`;

/** Shared layer: rows every member of the organization may be shown, before a permission check. */
export async function getQuotes(organization: string): Promise<Quote[]> {
  'use cache';
  cacheTag(orgTag(organization));
  cacheLife('hours');
  const quotes = await quotesOf(organization);
  return quotes;
}

export async function getStaff(
  organization: string,
): Promise<{ readonly user: string; readonly role: string }[]> {
  'use cache';
  cacheTag(orgTag(organization));
  cacheLife('hours');
  const staff = await staffOf(organization);
  return staff;
}

/**
 * Private layer: the session's snapshot for one organization. `stale` stays at
 * or above 30 s, so per-link prefetches carry it, and at 300 s it joins the App Shell.
 */
export async function loadSnapshot(organization: string): Promise<Snapshot> {
  'use cache: private';
  const user = await currentUser();
  const snapshot = snapshotFor(policy, user, { tenant: organization });
  cacheLife(cacheLifeFor(snapshot));
  cacheTag(userTag(user?.id), orgTag(organization));
  return snapshot;
}

/** The quotes this session may read: every quote for staff, only their customer's for a contact. */
export async function visibleQuotes(organization: string): Promise<Quote[]> {
  'use cache: private';
  const permdock = await getPermDock({ tenant: organization });
  cacheLife({ stale: 300 });
  cacheTag(userTag(permdock.subject.principal?.id), orgTag(organization));
  return permdock.filter(permissions.quote.read, await getQuotes(organization));
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
): Promise<QuoteAccess> {
  'use cache: private';
  const permdock = await getPermDock({ tenant: organization });
  cacheLife({ stale: 300 });
  cacheTag(userTag(permdock.subject.principal?.id), orgTag(organization));
  const quote = await findQuote(organization, id);
  if (quote === null || !permdock.can(permissions.quote.read, quote)) {
    return { quote: null, approve: false };
  }
  return { quote, approve: permdock.can(permissions.quote.approve, quote) };
}
