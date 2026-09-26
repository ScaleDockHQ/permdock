---
'permdock': minor
---

Close fail-open paths in the adapters.

- `permdock/nest`: a protected route outside HTTP (GraphQL, WebSocket, microservices) is denied unless the new `request` option maps the `ExecutionContext` to a request. `PermDockExceptionFilter` emits an `exception` event to WebSocket clients and rethrows on other transports.
- `permdock/ai-sdk`: `needsApproval` throws `PermDockDeniedError` for a denied or unmapped call instead of returning `true`. `toolApproval` and `needsApproval` recognise the AI SDK's post-approval re-check and deny it unless the approval is recorded in `store`.
- `permdock/authzen`: new `trustedPep(pep)` allow-list, off by default. Without it, the request-body `subject`, `actor` and `delegation` are ignored and the authenticated caller is the subject.
- `permdock/server`: the decision endpoint validates `resource.properties` at the boundary. `protect(permission, loadData, { trusted: false })` (`ProtectOptions`) validates request-derived rows.
- `permdock/a2a`: the task body is never used as the row. Instance-level skills must declare a `data` loader (`createPermDock` throws otherwise); the loaded row is validated, and a loader that throws or finds nothing is a denial.
- `permdock/trpc`: `errorFormatter` merges only PermDock Problem Details into the error shape, so other error causes no longer reach the client.
- `memoryApprovalStore`: `create` is idempotent per token and replaces only an expired record.
