# Block extensions

Four blocks carry a repository extension next to their SQL. With the block
in `better-supabase.config.ts`, `gen` marks every table that has the columns
and installs the extension in the generated schema, so
`defineSupabase(schema)` applies it with no `.use()` call:

```ts
blocks: {
  "updated-at": {},                                     // created_at, updated_at
  trash: { options: { deletedAt: "archived_at" } },     // default deleted_at
  "created-by": {},                                     // created_by, updated_by
  memberships: {},                                      // organization_id
}
```

An app with its own tenancy sets `auth.organization.column` instead of
installing `memberships`. With a `zod()`, `valibot()` or `standardSchema()`
generator, the generated schema also validates every write.

A table without the columns is left alone, and the types follow:
`restore()` and `withDeleted` only exist on tables with the trash column.

| Block         | What its extension does                                           | Don't                                 |
| ------------- | ----------------------------------------------------------------- | ------------------------------------- |
| `updated-at`  | Sets `createdAt` and `updatedAt`                                  | set them in `create` or `update`      |
| `trash`       | Hides deleted rows, turns `delete` into an update, adds `restore` | filter `deletedAt: null` by hand      |
| `memberships` | Scopes queries to the request's organization and fills it         | pass `organizationId` from the client |
| `created-by`  | Sets `createdBy` and `updatedBy`                                  | pass the user id yourself             |

`validation()` from `better-supabase` and `guards()` from
`better-supabase/lint` (unbounded reads, missing organizations, sensitive
columns, admin keys in the browser) are installed with `.use()`. Installing
an extension yourself, for example `membershipsExtension({ resolve })`,
replaces the one the generated schema installed.

## Order

`guards()` runs first, so it sees the query as written. The trash extension
runs next, so updated-at and created-by stamp a soft delete as the update it
becomes. Validation runs last, so it sees the row after the memberships
extension filled it.

RLS still decides what a user can read and write. The memberships extension
makes queries explicit and fills the column; it doesn't replace the policy.

The organization comes from `context.tenant`, which the server's `tenant` resolver
sets per request (the default `blocks.permissions.activeTenant: 'resolver'`), then
the verified `tenant_id` claim (renamed with `auth.organization.claim` in
`better-supabase.config.ts`), then `app_metadata.tenant_id`. A resolver may
read the URL, but `current_tenant_id()` only returns a tenant the caller is a
member of. In Next.js Server Components and actions there is no request URL:
pass the route's tenant with `bsb.context({ tenant })`, `bsb.cached({ tenant })`
or `bsb.action({ tenant: (input) => input.organizationId })`, which take the
resolver's path and get the same check. Never trust a tenant from
`user_metadata`, and never use one from a request body outside those options. When the config
has an `authorization` provider whose hook owns `memberships`, that hook
writes the claim and the memberships: don't run `add tenant`, and follow
the authorization providers reference of the `better-supabase-auth` skill
(https://bettersupabase.com/docs/extending/authorization-providers.md).

Docs: https://bettersupabase.com/docs/blocks/memberships.md,
https://bettersupabase.com/docs/blocks/trash.md and
https://bettersupabase.com/docs/repository/guards.md
