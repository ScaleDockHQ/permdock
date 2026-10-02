# Relationship graph

Owning page: [relationships](https://permdock.dev/docs/concepts/relationships). Named scopes are tenancy (fixed levels); the graph is the objects under them, with no fixed depth.

## Declare

```ts
export const permissions = definePermissions({
  doc: resource(Doc, {
    actions: ['read', 'update'],
    parent: { field: 'folderId', resource: 'folder' },
    relations: { owner: 'ownerId' },
  }),
  folder: resource(Folder, {
    actions: ['read', 'share'],
    parent: { field: 'parentId', resource: 'folder' },
    relations: {
      editor: { edge: 'folder_editors' },
      viewer: { edge: 'folder_viewers', expiresAt: 'expires_at' },
    },
    restricted: 'restricted',
  }),
});
```

| Relation   | Declared as                                                | Held when                                                                                |
| ---------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Field      | `owner: 'ownerId'`                                         | the row's field is the principal's id                                                    |
| Edge table | `{ edge, object?, subject?, expiresAt?, match?, groups? }` | a row of `edge` links the object and the principal, and has not expired                  |
| Principal  | `{ principal, period? }`                                   | the row's column is the principal's id, inside `period` (a manager, an account delegate) |
| Implied    | `{ includes: ['editor'] }`                                 | the principal holds a listed relation                                                    |

A resource that parents itself makes a chain. `restricted` names a boolean column: a restricted row is reached only by grants on itself, never through its ancestors. `links` names to-one references a grant can cross with `through: ['folder', 'team']`.

## Grant

```ts
grants: [
  allow(permissions.doc.read, { to: relation(permissions.doc, 'owner') }),
  allow(permissions.doc.read, {
    to: relation(permissions.folder, 'viewer', { through: 'parent', depth: 16 }),
  }),
],
```

`depth` defaults to 16 and is at most 32. An array in `to:` is an intersection, so "owner or viewer" is two `allow` grants. Prefer `relation()` over `where: { authorId: principal.id }` when the resource declares the relation.

## Load

Pass `relations: memoryRelations(permissions, { rows, edges })` in tests, or a `RelationSource` (`ancestors`, `related`) over the app's tables, to `createPermDock`. Evaluation stays synchronous; with an async source, call `await permdock.loadRelations(permission, rows)` before `can` or `filter`. Without a source, or with one that threw, graph checks deny with `relation-unavailable`; a chain past `depth` denies with `relation-depth`. Answers are cached per instance, never at module level.

## Share dialogs

`const { holders, complete } = await permdock.whoCan(permission, row)` lists who holds a permission on one object and how. Show `complete: false` honestly: some holders could not be listed. `whoCan` never grants.

## In Postgres

`permdock rls generate` emits the `permdock_closure` table, its statement triggers and `permitted_<resource>_ids(relation)` helpers. Snapshots carry no graph: graph grants are `portable: false` on the client and go to the decision endpoint. Check with:

```bash
pnpm exec permdock rls verify --tree --db $DATABASE_URL
pnpm exec permdock doctor --only graph
```

`--tree` seeds a generated object graph in a rolled-back transaction and compares it with `can()` per principal. PD031 flags a self-parent no `through: 'parent'` grant walks, or a `restricted` column no graph grant reaches; PD032 flags a graph resource RLS cannot name.
