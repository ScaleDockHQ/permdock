---
"permdock": minor
---

`permdock.where(permission, { tenant })` compiles for that tenant's memberships instead of the active tenant's, and the result's `subject` carries the tenant, so `toWhere` for Drizzle, Kysely and Prisma compiles `memberOf` for it. A tenant the subject does not hold reaches no row.
