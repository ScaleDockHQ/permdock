# Plugins

```ts title="src/lib/supabase/index.ts"
import { defineSupabase } from "better-supabase";
import { actor } from "better-supabase/plugins/actor";
import { softDelete } from "better-supabase/plugins/soft-delete";
import { tenant } from "better-supabase/plugins/tenant";
import { timestamps } from "better-supabase/plugins/timestamps";
import { validation } from "better-supabase/plugins/validation";

import { schema } from "./generated.ts";
import { validators } from "./generated.zod.ts";

export const betterSupabase = defineSupabase(schema)
  .use(timestamps())
  .use(softDelete())
  .use(tenant())
  .use(actor())
  .use(validation({ schemas: validators }));
```

Plugins act on tables by the flags codegen writes. Turn them on in
`better-supabase.config.ts`, then rerun `gen`:

```ts
plugins: {
  timestamps: true,                      // created_at, updated_at
  softDelete: { column: 'archived_at' }, // default deleted_at
  tenant: { column: 'organization_id' },
  actor: true,                           // created_by, updated_by
}
```

A table without the columns is left alone, and the types follow:
`restore()` and `withDeleted` only exist on soft-delete tables.

| Plugin         | What it does                                                                            | Don't                                 |
| -------------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| `timestamps()` | Sets `createdAt` and `updatedAt`                                                        | set them in `create` or `update`      |
| `softDelete()` | Hides deleted rows, turns `delete` into an update, adds `restore`                       | filter `deletedAt: null` by hand      |
| `tenant()`     | Scopes queries to the request's tenant and fills it on insert                           | pass `organizationId` from the client |
| `actor()`      | Sets `createdBy` and `updatedBy`                                                        | pass the user id yourself             |
| `validation()` | Validates writes with any Standard Schema                                               | validate the same input twice         |
| `rules()`      | Flags unbounded reads, missing tenants, sensitive columns and admin keys in the browser | disable a rule without a reason       |

## Order

Hooks run in `use()` order, with two exceptions. `softDelete()` runs first,
so `timestamps()` and `actor()` stamp a soft delete as the update it
becomes. `validation()` runs last, so it sees the row after `tenant()`
filled it.

RLS still decides what a user can read and write. `tenant()` makes queries
explicit and fills the column; it doesn't replace the policy.

The tenant comes from `context.tenant`, which the server's `tenant` resolver
sets per request (the default `sql.modules.access.activeTenant: 'resolver'`), then
the verified `tenant_id` claim (renamed with `claims.tenant` in
`better-supabase.config.ts`), then `app_metadata.tenant_id`. A resolver may
read the URL, but `current_tenant_id()` only returns a tenant the caller is a
member of. In Next.js Server Components and actions there is no request URL:
pass the route's tenant with `bs.context({ tenant })`, `bs.cached({ tenant })`
or `bs.action({ tenant: (input) => input.organizationId })`, which take the
resolver's path and get the same check. Never trust a tenant from
`user_metadata`, and never use one from a request body outside those options. When the config
has an `authorization` provider whose hook owns `memberships`, that hook
writes the claim and the memberships: don't run `sql add tenant`, and follow
the authorization providers reference of the `better-supabase-auth` skill
(https://bettersupabase.com/docs/extending/authorization-providers.md).

Docs: https://bettersupabase.com/docs/plugins.md
