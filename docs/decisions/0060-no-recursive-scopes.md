# 0060. Scopes are not recursive

- Status: accepted
- Date: 2026-11-05

## Context

A CentraKit-style tenant tree (organization, region, branch) asks for a `memberOf` scope that follows `through: 'parent'`, so a role held on a parent organization reaches the rows of its children.

## Decision

- A scope stays flat tenancy: one key per row, one membership per scope instance. `definePolicy` keeps rejecting `through` over a `memberOf` relation.
- A hierarchy is a self-parented resource. Grants walk it with `relation(resource, name, { through: 'parent', depth })`, which every adapter already bounds (16 hops by default, 32 at most) and which compiles to the closure table.
- No code changes in 0.25.0.

## Consequences

An app that needs a role on a parent organization to reach child organizations declares the organizations as a resource with a `parent` and grants the role as a relation on it, as in [relationships](/docs/concepts/relationships#granting-through-the-graph). Membership checks, snapshot clients and the RLS helpers keep one lookup per scope.

## Alternatives considered

- Recursive scope membership: every check of `memberOf` would walk the chain, in `can`, in the snapshot evaluator and in each generated helper, and a cycle in tenant data would need its own guard.
- Flatten the tree into memberships at write time: the app owns the fan-out and its invalidation, which PermDock cannot see.
