---
"permdock": minor
---

Ids that an integrator supplies and core only compares for equality are open unions: the values PermDock sets still autocomplete, and an application's own id type-checks.

| Type                | Where                                                                       | Known values                                            |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| `ActorKind`         | `Actor.kind`, a policy delegation's `to.kind`                               | `mcp-client`, `oauth-client`, `support`, `ai-sdk`, …    |
| `AdapterId`         | `DecideOptions.adapter`, `DecisionEvent.adapter`, `ApprovalRequest.adapter` | every adapter entry                                     |
| `MembershipVia`     | `Membership.via`, `viaOnly`, membership and access events                   | `direct`, `contact`, `credential`, `support`, `scim`, … |
| `OpenUnion<"scim">` | `DirectoryEvent.source`                                                     | `scim`                                                  |

`directory-event-v1.json` now accepts any string `source`, so a directory sync other than SCIM can emit the same event. Unions that core interprets member by member stay closed: denial reasons, approval modes, condition operators, credential kinds, delivery channels and problem types.
