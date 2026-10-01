import { describe, expect, it } from 'vitest';

import { verifyTree } from '../../src/cli/rls-verify-tree.ts';
import { insertedRows } from '../fakes/sql.ts';
import { policy } from '../fixtures/graph.ts';

type Row = Readonly<Record<string, unknown>>;

/** Echoes inserts back as rows and answers every visibility select with `visible`. */
function database(visible: 'all' | 'none') {
  const inserts: { table: string; rows: Row[] }[] = [];
  const selects: string[] = [];
  const query = async (sql: string, values: readonly unknown[] = []) => {
    if (sql.startsWith('insert into ')) {
      const rows = insertedRows({ sql, values });
      inserts.push({ table: sql.split(' ')[2] ?? '', rows });
      return { rows };
    }
    selects.push(sql);
    const ids = Array.isArray(values[0]) ? values[0] : [];
    return {
      rows: visible === 'all' ? ids.map((id: unknown) => ({ id })) : [],
    };
  };
  return { query, inserts, selects };
}

describe('verifyTree', () => {
  it('seeds every walked tree, its child rows and its edges in one pass', async () => {
    const db = database('none');
    const bound: string[] = [];
    const result = await verifyTree({
      policy,
      config: { rls: { tables: { doc: 'documents' } } },
      query: db.query,
      bind: async (subject) => {
        bound.push(subject);
      },
    });
    const tables = db.inserts.map((insert) => insert.table);
    expect(tables).toContain('"public"."folder"');
    expect(tables).toContain('"public"."documents"');
    expect(tables).toContain('"public"."folder_members"');
    const folders = db.inserts.find(
      (insert) => insert.table === '"public"."folder"',
    );
    expect(folders?.rows.some((row) => row['restricted'] === true)).toBe(true);
    expect(
      folders?.rows.filter((row) => row['parentId'] === null),
    ).toHaveLength(2);
    expect(bound.length).toBeGreaterThanOrEqual(3);
    expect(result.checked).toBeGreaterThan(0);
    expect(db.selects[0]).toMatch(/::text = any\(\$1::text\[\]\)$/u);
  });

  it('counts agreement on visible rows and reports every row the database shows but decide denies', async () => {
    const db = database('all');
    const result = await verifyTree({
      policy,
      config: {},
      query: db.query,
      bind: async () => undefined,
    });
    expect(result.granted).toBeGreaterThan(0);
    expect(result.mismatches.length).toBeGreaterThan(0);
    expect(result.mismatches[0]).toMatch(
      /: in-process denied, database allowed$/u,
    );
    expect(result.granted + result.mismatches.length).toBe(result.checked);
  });

  it('reports every row decide grants but the database filters', async () => {
    const db = database('none');
    const result = await verifyTree({
      policy,
      config: {},
      query: db.query,
      bind: async () => undefined,
    });
    expect(result.granted).toBe(0);
    expect(
      result.mismatches.every((line) =>
        line.endsWith('in-process granted, database filtered'),
      ),
    ).toBe(true);
  });
});
