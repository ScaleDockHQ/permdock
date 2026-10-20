# 0036. Org-level and per-row access on one resource

- Status: accepted
- Date: 2026-10-20

## Context

An adopter declares two resources over one table to get org-wide permissions and per-row grants:

| Org-level resource | Per-row resource      | Table                   |
| ------------------ | --------------------- | ----------------------- |
| `file`             | `fileNode`            | `file_nodes`            |
| `knowledge`        | `knowledgeCollection` | `knowledge_collections` |
| `workflow`         | `workflowDefinition`  | `workflow_definitions`  |
| `chat`             | `thread`              | `chat_threads`          |

Each pair doubles the permission keys (`file.read` and `fileNode.read`), the generated helpers (`permitted_file_rows` and `permitted_file_node_rows`) and the catalog entries. A policy author then has to pick a key per grant, and a check of the wrong key denies or grants a different set of rows.

The split is not required by the model. One resource can already carry both kinds of relation:

- A `memberOf` relation (`org: { field: "orgId", memberOf: "tenant" }`) scopes role grants to the row's tenant. A role with `on: "tenant"` that allows `file.read` reaches every row of its organisation.
- Row relations sit beside it: a field relation (`owner: "ownerId"`), an edge relation (`viewer: { edge: "file_shares" }`) and a `parent` closure (`relation(file, "viewer", { through: "parent" })`). Grants to them reach single rows.
- `src/core/resource-relations.ts` refuses only `memberOf` combined with `includes`. `memberOf` on its own beside edge and field relations is accepted.
- `tests/fixtures/restricted-stops.ts` declares that shape: `drive` has `org` (`memberOf`), `owner` and `viewer` (edge), and `node` adds a `parent` closure with `restricted` stops. Its role grant and relation grants compile to one set of policies.

## Decision

No new construct. Model both levels on one resource. Doctor check PD075 and the [merge guide](../../apps/docs/content/docs/guides/merge-resources.mdx) carry the migration.

- **One resource.** The org-level grant is a role grant scoped through `memberOf`. The per-row grant is a relation grant on the same leaf. `file.read` answers both: the RLS policy for `file_nodes` ORs the tenant branch (`orgId` in the caller's permitted tenant ids) with the relation branches (owner, share edge, parent closure). Org-only verbs that never touch a row (`manageSettings`, `export`) stay actions on the same resource; a collection verb (`create`, `list`) goes in `collection`.
- **Helpers.** `rls generate` writes one `permitted_file_rows(p_permission)` with one `case` arm per permission. Each arm already ORs the role branch and the relation branches, so a hand-written policy calls one helper instead of two. `permitted_tenant_ids` keeps answering the org-level question on its own.
- **Catalog.** One resource entry lists all of its relations (`org` with `memberOf`, `owner`, `viewer`) and one set of permissions. The catalog format is unchanged.
- **Doctor check.** PD075 warns when `rls.tables` maps two resources to the same table. It names both resources and the table, and links the merge guide. It reads only the config: for each table, it counts the resources whose `rls.tables` entry (a name or a `via` entry) resolves to that table. A deliberate split, two resources over disjoint row sets of one table, lists the table in `doctor.sharedTables`.
- **Migration.** For each pair:
  1. Move the per-row resource's relations and `parent` onto the org-level resource, and delete the per-row resource.
  2. Map each removed key to its survivor in `definePermissions(tree, { renamed: { "fileNode.read": "file.read" } })`. Stored custom roles, OAuth scopes in their `:` form, AuthZEN actions and hosted grants keep resolving. `rls generate` seeds `role_permissions` under the former keys too, and `permdock diff` reports `renamed`.
  3. Rewrite references to the removed leaves (`permissions.fileNode.read` to `permissions.file.read`). The type checker lists every site, because the leaf no longer exists; `permdock codemod` covers only release renames.
  4. Replace `permitted_file_node_rows` calls in hand-written SQL with `permitted_file_rows`, and drop the old function in the migration, because `rls generate` stops writing it but does not remove it from the database.
  5. Drop the `renamed` entries one major later; `permdock diff` flags it as `alias-removed`.

## Consequences

- A policy author picks one key per verb. A key covers org members and row holders alike, so a check of the key cannot miss one of the two sets.
- An adopter who wants an org member to see only shared rows can no longer get that by using the per-row key. They must leave the role grant out, or deny on a row condition.
- Two resources whose action sets differ on purpose need a decision per verb when they merge. PD075 only reports the overlap; it does not choose.
- `tests/integration/src/rls-merged-resource.test.ts` merges `file` and `fileNode` over one `file_nodes` table and checks, per user and verb, that the merged helper and the table's policies return the union of the split pair's rows, in Postgres and in process.
- Revisit this decision if a merged resource needs two different `id` columns or two different `rls.tables` entries. One resource has one table, so such a case is two resources by definition.

## Alternatives considered

- **A `level: "org" | "row"` flag on each action.** It keeps two key sets inside one resource and adds a concept the evaluator would have to interpret, while the grantee (role or relation) already says the level.
- **Generate both helpers from one resource.** That keeps the doubled SQL surface the adopter wants gone, and makes a second helper name for the same rows.
- **Leave the split and document it.** The doubled keys are the problem the adopter reported. Documentation would not remove them.
