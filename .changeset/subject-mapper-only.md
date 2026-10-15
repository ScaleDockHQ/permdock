---
"permdock": major
---

`definePolicy` takes one mapper name, `subject`, as AuthZEN, JWT (`sub`) and the `subjectFrom*` helpers do. The `principal` alias is removed, and `subject` is required by the type.

| Before                                                  | After                                                 |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `definePolicy(permissions, { principal: (user) => … })` | `definePolicy(permissions, { subject: (user) => … })` |
