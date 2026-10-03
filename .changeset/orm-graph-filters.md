---
"permdock": minor
---

Graph grants reach the ORMs. `toWhere` in `permdock/drizzle` and `permdock/kysely` compiles a `related` node to one subquery when given `relations: { tables?, closure? }`, and `resolveRelated` in `permdock/prisma` replaces each node with the ids it reads through a raw query. All three adapters export `checkRow`, which tells a missing row from a denied one in one query, and `withSubject`, which runs a transaction with the role and claims the generated RLS policies read.
