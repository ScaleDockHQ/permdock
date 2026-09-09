# @permdock/testing

Policy matrix tests, snapshot fixtures and extension-interface conformance runners for PermDock.

```ts
import { describePolicy } from '@permdock/testing'
import { policy } from '../src/policy'
import { permissions } from '../src/permissions'

describePolicy(policy, {
  subjects: { anonymous: null, member: { id: 'u1', roles: ['member'] } },
  fixtures: { ownPost: { id: 'p1', authorId: 'u1' } },
  matrix: {
    [permissions.post.create.key]: { anonymous: 'denied', member: 'granted' },
  },
})
```

Conformance runners include `testLimitStore(memoryLimitStore())` for quota stores.

Peer dependencies: `permdock`, `vitest`.
