---
'permdock': minor
---

Drizzle `toWhere` returns `SQL`, and `columns` accepts only columns of the given table. `permdock/prisma` adds `prismaModelFields`, which reads required and list fields from `schema.prisma` or a DMMF datamodel for the new `model` option, and `toPredicate`, which compiles a condition to a Prisma 8 field-proxy predicate.
