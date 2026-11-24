import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sharedFunctionsOf } from "../../src/cli/rls/shared-functions.ts";
import { tableReads } from "../../src/cli/rls/table-reads.ts";

const TMP = join(import.meta.dirname, "../../tmp");

const TABLES = `create table public.invoices (id uuid primary key, organization_id uuid not null, total numeric);
alter table public.invoices enable row level security;
create policy invoices_read on public.invoices for select to authenticated
  using (organization_id in (select permdock.permitted_organization_ids_by_permission('invoice.read')));

create table public.lines (id uuid primary key, invoice_id uuid not null, organization_id uuid not null);
alter table public.lines enable row level security;
create policy lines_read on public.lines for select to authenticated
  using (organization_id in (select permdock.permitted_organization_ids_by_permission('invoice.read')));

create table public.notes (id uuid primary key, organization_id uuid not null, owner_id uuid);
alter table public.notes enable row level security;
create policy notes_read on public.notes for select to authenticated
  using (owner_id = auth.uid());
`;

const FUNCTIONS = `create function public.invoice_total() returns numeric language sql stable as $$
  select coalesce(sum(total), 0) from invoices
$$;

create function public.line_count() returns bigint language sql stable security invoker as $$
  select count(*) from public.lines l join public.invoices i on i.id = l.invoice_id
$$;

create function public.both() returns numeric language sql stable as $$
  select public.invoice_total() + public.line_count()
$$;

create function public.volatile_total() returns numeric language sql as $$
  select sum(total) from invoices
$$;

create function public.definer_total() returns numeric language sql stable security definer as $$
  select sum(total) from invoices
$$;

create function public.my_total() returns numeric language sql stable as $$
  select sum(total) from invoices where organization_id::text = current_setting('app.org', true)
$$;

create function public.who_total() returns numeric language sql stable as $$
  select sum(total) from invoices where auth.uid() is not null
$$;

create function public.notes_count() returns bigint language sql stable as $$
  select count(*) from notes
$$;

create function public.helper_total() returns boolean language sql stable as $$
  select permdock.permdock_has('invoice.read')
$$;

create function public.plpgsql_total() returns numeric language plpgsql stable as $$
begin return 1; end $$;

create function public.uses_unknown() returns numeric language sql stable as $$
  select sum(total) from invoices where other_schema.fn() > 0
$$;

create function public.cte_total() returns numeric language sql stable as $$
  with t as (select total from invoices) select sum(total) from t
$$;

create function public.role_total() returns bigint language sql stable as $$
  select count(*) from invoices where current_user = 'x'
$$;
`;

const dirs: string[] = [];

function project(): string {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, "shared-functions-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, "supabase/schemas"), { recursive: true });
  writeFileSync(join(cwd, "supabase/schemas/tables.sql"), TABLES);
  writeFileSync(join(cwd, "supabase/schemas/functions.sql"), FUNCTIONS);
  return cwd;
}

describe(sharedFunctionsOf, () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists the invoker functions that read only tenant tables and no caller", async () => {
    const cwd = project();
    const config = { rls: { dialect: "supabase" } } as const;
    const reads = await tableReads({
      cwd,
      config,
      schema: "permdock",
      root: "organization",
    });
    expect(
      await sharedFunctionsOf({
        cwd,
        config,
        schema: "permdock",
        tableReads: reads,
      }),
    ).toStrictEqual([
      {
        function: "public.both",
        tables: ["public.invoices", "public.lines"],
        permissions: ["invoice.read"],
      },
      {
        function: "public.cte_total",
        tables: ["public.invoices"],
        permissions: ["invoice.read"],
      },
      {
        function: "public.invoice_total",
        tables: ["public.invoices"],
        permissions: ["invoice.read"],
      },
      {
        function: "public.line_count",
        tables: ["public.invoices", "public.lines"],
        permissions: ["invoice.read"],
      },
    ]);
  });
});
