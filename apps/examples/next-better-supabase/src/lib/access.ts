import type { Snapshot } from 'permdock';

import { cacheLife, cacheTag } from 'next/cache';
import { emptySnapshot, snapshotFor } from 'permdock';
import { cacheLifeFor, snapshotTag } from 'permdock/next';
import { subjectFromSupabaseSession } from 'permdock/supabase';

import { policy } from '../policy.ts';
import { bs, postgres } from './supabase/server.ts';

export type Organization = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
};

export const orgTag = (organization: string): string => `org:${organization}`;

/** Shared layer: slugs are public, so the lookup reads no session and every visitor shares it. */
export async function organizationBySlug(
  slug: string,
): Promise<Organization | null> {
  'use cache';
  cacheTag(`org-slug:${slug}`);
  cacheLife('hours');
  const rows = await postgres.anon.queryRaw<Organization>(
    'select id, slug, name from public.organizations where slug = $1',
    [slug],
  );
  return rows[0] ?? null;
}

/**
 * Private layer: the session's snapshot for one organization. `bs.cached()`
 * caps `stale` at the token's expiry and at 300 s, which joins the App Shell
 * so a prefetch carries the snapshot; `cacheLifeFor` caps it at the
 * snapshot's, and Next keeps the smaller of the two.
 */
export async function loadSnapshot(organization: string): Promise<Snapshot> {
  'use cache: private';
  const { session } = await bs.cached({
    tags: [orgTag(organization)],
  });
  cacheTag(snapshotTag(session.kind === 'user' ? session.user.id : null));
  const subject = subjectFromSupabaseSession(session, {
    memberships: 'memberships',
    plans: 'features',
  });
  const snapshot = snapshotFor(policy, subject, { tenant: organization });
  cacheLife({ stale: cacheLifeFor(snapshot).stale });
  return snapshot;
}

/** The layout's snapshot: an unknown slug gets the empty one, and the page answers 404. */
export async function snapshotForSlug(slug: string): Promise<Snapshot> {
  const organization = await organizationBySlug(slug);
  return organization === null
    ? emptySnapshot()
    : loadSnapshot(organization.id);
}

export type StaffRow = {
  readonly id: string;
  readonly name: string;
  readonly title: string;
};

/** Read through RLS as the caller: `permitted_organization_ids('staff.list')` filters the rows. */
export async function visibleStaff(
  organization: string,
): Promise<readonly StaffRow[]> {
  'use cache: private';
  const { sql, session } = await bs.cached({ tags: [orgTag(organization)] });
  cacheTag(snapshotTag(session.kind === 'user' ? session.user.id : null));
  if (session.kind !== 'user' || !sql) {
    return [];
  }
  return sql.staff
    .findMany({
      where: { organization_id: organization },
      select: ['id', 'name', 'title'],
      orderBy: { name: 'asc' },
    })
    .orThrow();
}

export type QuoteRow = {
  readonly id: string;
  readonly title: string;
  readonly amount: number;
};

/** A contact reads only their customer's quotes; the policy on `quotes` decides, not this filter. */
export async function visibleQuotes(
  organization: string,
): Promise<readonly QuoteRow[]> {
  'use cache: private';
  const { sql, session } = await bs.cached({ tags: [orgTag(organization)] });
  cacheTag(snapshotTag(session.kind === 'user' ? session.user.id : null));
  if (session.kind !== 'user' || !sql) {
    return [];
  }
  return sql.quotes
    .findMany({
      where: { organization_id: organization },
      select: ['id', 'title', 'amount'],
      orderBy: { title: 'asc' },
    })
    .orThrow();
}
