import { randomUUID } from 'node:crypto';

import type { MemoryEdge } from '../core/relations.ts';
import type { Policy, ResourceNode } from '../index.ts';
import type { PermDockConfig } from './types.ts';

import {
  isEdgeRelation,
  isFieldRelation,
  isPrincipalRelation,
} from '../core/permissions.ts';
import { createPermDock, listPermissions, memoryRelations } from '../index.ts';
import { jsonSchemaOf } from './catalog-doc.ts';
import { commandFor } from './rls-compile.ts';
import { graphPlan } from './rls-graph.ts';
import { columnTypesOf, quoteIdent, quoteTable } from './rls-sql.ts';

type Row = Readonly<Record<string, unknown>>;

type Query = (
  sql: string,
  values?: readonly unknown[],
) => Promise<{ readonly rows: readonly Row[] }>;

/** One generated object in a tree: its parent, whether it is restricted, and its depth. */
type TreeNode = {
  readonly id: string | number;
  readonly parent: string | number | null;
  readonly restricted: boolean;
};

const SUBJECTS = 3;

function tableSql(name: string): string {
  return quoteTable(name.includes('.') ? name : `public.${name}`);
}

function idFactory(node: ResourceNode): () => string | number {
  const type = columnTypesOf(jsonSchemaOf(node))[node.id];
  let next = 900_000;
  return type === 'numeric'
    ? () => {
        next += 1;
        return next;
      }
    : () => randomUUID();
}

/**
 * Two spines one level deeper than the walk depth, so the depth cap is
 * crossed; side branches under the first levels alternate restricted, and
 * the second spine is restricted two levels down.
 */
function generateTree(node: ResourceNode, depth: number): readonly TreeNode[] {
  const id = idFactory(node);
  const nodes: TreeNode[] = [];
  for (const spine of [0, 1]) {
    let parent: string | number | null = null;
    for (let level = 0; level <= depth + 1; level += 1) {
      const current = id();
      nodes.push({
        id: current,
        parent,
        restricted: node.restricted !== undefined && spine === 1 && level === 2,
      });
      if (spine === 0 && level >= 1 && level <= 3) {
        const side = id();
        nodes.push({
          id: side,
          parent: current,
          restricted: node.restricted !== undefined && level % 2 === 1,
        });
        nodes.push({ id: id(), parent: side, restricted: false });
      }
      parent = current;
    }
  }
  return nodes;
}

function insertSql(
  table: string,
  rows: readonly Row[],
): { readonly sql: string; readonly values: readonly unknown[] } {
  const columns = Object.keys(rows[0] ?? {});
  const values: unknown[] = [];
  const tuples = rows.map(
    (row) =>
      `(${columns
        .map((column) => {
          values.push(row[column]);
          return `$${String(values.length)}`;
        })
        .join(', ')})`,
  );
  return {
    sql: `insert into ${tableSql(table)} (${columns.map(quoteIdent).join(', ')}) values ${tuples.join(', ')} returning *`,
    values,
  };
}

export type TreeVerification = {
  readonly checked: number;
  /** Checks both sides granted, so a tree nobody reaches cannot pass by agreeing. */
  readonly granted: number;
  readonly mismatches: readonly string[];
  readonly notes: readonly string[];
};

/**
 * Parity between `decide` and RLS on a generated object graph: for every
 * self-parented resource a graph grant walks, a tree with restricted
 * branches and a chain past the walk depth, child rows under it, and edges
 * for a few generated principals. Everything runs in one transaction that
 * is rolled back.
 */
export async function verifyTree(input: {
  readonly policy: Policy;
  readonly config: PermDockConfig;
  readonly query: Query;
  readonly bind: (subject: string) => Promise<void>;
}): Promise<TreeVerification> {
  const { policy, query } = input;
  const tables = input.config.rls?.tables;
  const plan = graphPlan(policy);
  const walked = [...plan.values()].filter(
    (entry) => entry.closure !== undefined,
  );
  if (walked.length === 0) {
    return {
      checked: 0,
      granted: 0,
      mismatches: [],
      notes: ['no graph grant walks a self-parented resource'],
    };
  }
  const subjects: string[] = Array.from({ length: SUBJECTS }, () =>
    randomUUID(),
  );
  const rows: Record<string, Row[]> = {};
  const edges: Record<string, Record<string, MemoryEdge[]>> = {};
  const now = Date.now();
  for (const entry of walked) {
    const node = entry.node;
    const parent = node.parent;
    if (parent === undefined) {
      continue;
    }
    const tree = generateTree(node, entry.closure ?? 0);
    const seeded = tree.map((item, index) => {
      const row: Record<string, unknown> = {
        [node.id]: item.id,
        [parent.field]: item.parent,
      };
      if (node.restricted !== undefined) {
        row[node.restricted] = item.restricted;
      }
      for (const name of entry.relations) {
        const spec = node.relations[name];
        const column = isFieldRelation(spec)
          ? spec.memberOf === undefined
            ? spec.field
            : undefined
          : isPrincipalRelation(spec)
            ? spec.principal
            : undefined;
        if (column !== undefined && column !== parent.field) {
          row[column] =
            index % 4 === 0 ? subjects[index % SUBJECTS] : randomUUID();
        }
      }
      return row;
    });
    // A relation on the parent column (a reporting line) is held by the tree's own nodes.
    if (
      [...entry.relations].some((name) => {
        const spec = node.relations[name];
        return (
          (isPrincipalRelation(spec) && spec.principal === parent.field) ||
          (isFieldRelation(spec) && spec.field === parent.field)
        );
      })
    ) {
      subjects.push(
        ...tree
          .filter((_, index) => index % 3 === 0)
          .map((item) => String(item.id)),
      );
    }
    const inserted = insertSql(tables?.[node.name] ?? node.name, seeded);
    rows[node.name] = [...(await query(inserted.sql, inserted.values)).rows];
    for (const name of entry.relations) {
      const spec = node.relations[name];
      if (!isEdgeRelation(spec)) {
        continue;
      }
      const object = spec.object ?? `${node.name}_id`;
      const subject = spec.subject ?? 'user_id';
      const list: MemoryEdge[] = [];
      const edgeRows: Row[] = [];
      for (const [index, item] of tree.entries()) {
        const holder = subjects[index % SUBJECTS];
        if (holder === undefined || index % 5 !== 1) {
          continue;
        }
        const expired = spec.expiresAt !== undefined && index % 10 === 6;
        const expiresAt = expired ? new Date(now - 86_400_000) : undefined;
        edgeRows.push({
          [object]: item.id,
          [subject]: holder,
          ...(spec.expiresAt === undefined
            ? {}
            : { [spec.expiresAt]: expiresAt ?? null }),
        });
        list.push({
          id: String(item.id),
          principal: holder,
          ...(expiresAt === undefined
            ? {}
            : { expiresAt: expiresAt.getTime() / 1000 }),
        });
      }
      if (edgeRows.length > 0) {
        const edgeInsert = insertSql(spec.edge, edgeRows);
        await query(edgeInsert.sql, edgeInsert.values);
      }
      edges[node.name] = { ...edges[node.name], [name]: list };
    }
    for (const child of policy.resources.values()) {
      if (child.name === node.name || child.parent?.resource !== node.name) {
        continue;
      }
      const make = idFactory(child);
      const childRows = tree.map((item, index) => {
        const row: Record<string, unknown> = {
          [child.id]: make(),
          [child.parent?.field ?? '']: item.id,
        };
        if (child.restricted !== undefined) {
          row[child.restricted] = index % 7 === 3;
        }
        return row;
      });
      const childInsert = insertSql(
        tables?.[child.name] ?? child.name,
        childRows,
      );
      rows[child.name] = [
        ...(await query(childInsert.sql, childInsert.values)).rows,
      ];
    }
  }
  const relations = memoryRelations(policy.permissions, { rows, edges });
  const mismatches: string[] = [];
  let checked = 0;
  let granted = 0;
  const reads = listPermissions(policy.permissions).filter(
    (leaf) =>
      leaf.kind === 'instance' &&
      commandFor(leaf.action) === 'select' &&
      rows[leaf.resource] !== undefined,
  );
  for (const subject of subjects) {
    const dock = await createPermDock(
      policy,
      { principal: { id: subject, roles: [] }, context: {} },
      { relations },
    );
    await input.bind(subject);
    for (const permission of reads) {
      const node = policy.resources.get(permission.resource);
      const list = rows[permission.resource] ?? [];
      if (node === undefined || list.length === 0) {
        continue;
      }
      const ids = list.map((row) => String(row[node.id]));
      const visible = await query(
        `select ${quoteIdent(node.id)}::text as id from ${tableSql(tables?.[node.name] ?? node.name)} where ${quoteIdent(node.id)}::text = any($1::text[])`,
        [ids],
      );
      const seen = new Set(visible.rows.map((row) => String(row['id'])));
      for (const row of list) {
        checked += 1;
        const id = String(row[node.id]);
        // SAFETY: permission is a leaf of this policy's own permissions tree, which can() accepts.
        const allowed = dock.can(permission as never, row);
        if (allowed !== seen.has(id)) {
          mismatches.push(
            `${permission.key} ${id}: in-process ${allowed ? 'granted' : 'denied'}, database ${seen.has(id) ? 'allowed' : 'filtered'}`,
          );
        } else if (allowed) {
          granted += 1;
        }
      }
    }
  }
  return { checked, granted, mismatches, notes: [] };
}
