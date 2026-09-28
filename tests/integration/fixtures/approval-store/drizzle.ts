import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  ApprovalListQuery,
  ApprovalRequest,
  ApprovalStatus,
  ApprovalStore,
} from 'permdock/approvals';

import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { ApprovalError, assertApprover } from 'permdock/approvals';

// The recipe on adapters/approvals.mdx; keep the two in step.
export const approvals = pgTable('permdock_approvals', {
  token: text('token').primaryKey(),
  body: jsonb('body').$type<ApprovalRequest>().notNull(),
  status: text('status').$type<ApprovalStatus>().notNull(),
  tenant: text('tenant'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

export const approvalsDdl = `
create table if not exists permdock_approvals (
  token text primary key,
  body jsonb not null,
  status text not null,
  tenant text,
  expires_at timestamptz not null,
  consumed_at timestamptz
)`;

export function drizzleApprovalStore(db: NodePgDatabase): ApprovalStore {
  const get = async (token: string): Promise<ApprovalRequest | null> => {
    const [row] = await db
      .select({ body: approvals.body })
      .from(approvals)
      .where(eq(approvals.token, token));
    return row?.body ?? null;
  };

  return {
    async create(request) {
      const values = {
        token: request.token,
        body: request,
        status: request.status,
        tenant: request.subject.principal?.tenant ?? null,
        expiresAt: new Date(request.expiresAt),
        consumedAt: null,
      };
      // A repeated ask keeps the existing record; only an expired one is replaced.
      await db
        .insert(approvals)
        .values(values)
        .onConflictDoUpdate({
          target: approvals.token,
          set: values,
          setWhere: or(
            eq(approvals.status, 'expired'),
            lte(approvals.expiresAt, new Date()),
          ),
        });
    },
    get,
    async resolve(token, verdict) {
      const current = await get(token);
      if (current === null) {
        throw new ApprovalError('approval-not-found', 'approval was not found');
      }
      assertApprover(current, verdict.by, false);
      const next: ApprovalRequest = {
        ...current,
        status: verdict.status,
        resolvedAt: new Date().toISOString(),
        resolvedBy: verdict.by.principal!.id,
        ...(verdict.note === undefined ? {} : { note: verdict.note }),
      };
      const [row] = await db
        .update(approvals)
        .set({ status: next.status, body: next })
        .where(
          and(
            eq(approvals.token, token),
            eq(approvals.status, 'pending'),
            gt(approvals.expiresAt, new Date()),
          ),
        )
        .returning({ body: approvals.body });
      if (row === undefined) {
        throw new ApprovalError(
          'approval-not-pending',
          'approval is not pending',
        );
      }
      return row.body;
    },
    async consume(token, now = new Date()) {
      const [row] = await db
        .update(approvals)
        .set({
          consumedAt: now,
          body: sql`${approvals.body} || jsonb_build_object('consumedAt', ${now.toISOString()}::text)`,
        })
        .where(
          and(
            eq(approvals.token, token),
            eq(approvals.status, 'approved'),
            isNull(approvals.consumedAt),
            gt(approvals.expiresAt, now),
          ),
        )
        .returning({ body: approvals.body });
      return row?.body ?? null;
    },
    async list(query: ApprovalListQuery) {
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
      let after: readonly [string, string] | undefined;
      if (query.cursor !== undefined) {
        try {
          const parsed: unknown = JSON.parse(query.cursor);
          if (
            !Array.isArray(parsed) ||
            typeof parsed[0] !== 'string' ||
            typeof parsed[1] !== 'string'
          ) {
            return { items: [] };
          }
          after = [parsed[0], parsed[1]];
        } catch {
          return { items: [] };
        }
      }
      const createdAt = sql`${approvals.body} ->> 'createdAt'`;
      const rows = await db
        .select({ body: approvals.body })
        .from(approvals)
        .where(
          and(
            query.status === undefined
              ? undefined
              : eq(approvals.status, query.status),
            query.tenant === undefined
              ? undefined
              : eq(approvals.tenant, query.tenant),
            query.principalId === undefined
              ? undefined
              : sql`${approvals.body} #>> '{subject,principal,id}' = ${query.principalId}`,
            query.actorId === undefined
              ? undefined
              : sql`${approvals.body} #>> '{subject,actor,id}' = ${query.actorId}`,
            query.session === undefined
              ? undefined
              : sql`${approvals.body} #>> '{subject,session}' = ${query.session}`,
            after === undefined
              ? undefined
              : sql`(${createdAt}, ${approvals.token}) > (${after[0]}, ${after[1]})`,
          ),
        )
        .orderBy(createdAt, approvals.token)
        .limit(limit + 1);
      const items = rows.slice(0, limit).map((row) => row.body);
      const last = items.at(-1);
      return rows.length > limit && last !== undefined
        ? { items, next: JSON.stringify([last.createdAt, last.token]) }
        : { items };
    },
    async expire(now = new Date()) {
      const rows = await db
        .update(approvals)
        .set({
          status: 'expired',
          body: sql`${approvals.body} || '{"status":"expired"}'::jsonb`,
        })
        .where(
          and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, now)),
        )
        .returning({ token: approvals.token });
      return rows.length;
    },
  };
}
