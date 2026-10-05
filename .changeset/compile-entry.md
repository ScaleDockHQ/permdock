---
"permdock": minor
---

New entry `permdock/compile` exports `compileWhere` and the `CompiledWhere` tree that the Drizzle, Prisma and Kysely compilers render. `testWhereCompiler` takes an optional `matches(compiled, row)` and then checks that a compiler selects the rows the in-memory evaluator keeps.
