---
"permdock": minor
---

Breaking: options types drop their verb prefix, `Ctx` is spelled `Context`, the JWT and Clerk resolver factories lose `create` because they return a function, and `permdock/node` drops the `fromResponse` alias of `sendResponse`. Run `permdock codemod 0.5` to apply them.

| Old                          | New                    |
| ---------------------------- | ---------------------- |
| `DefinePermissionsOptions`   | `PermissionsOptions`   |
| `SignCapabilityOptions`      | `CapabilityOptions`    |
| `SignRunTicketOptions`       | `RunTicketOptions`     |
| `StartAccessReviewOptions`   | `AccessReviewOptions`  |
| `StartAutomationOptions`     | `AutomationOptions`    |
| `VerifyWebhookOptions`       | `WebhookOptions`       |
| `UseRolesOptions`            | `RolesOptions`         |
| `ConvexCtxLike`              | `ConvexContextLike`    |
| `createJwtSubjectResolver`   | `jwtSubjectResolver`   |
| `createClerkSubjectResolver` | `clerkSubjectResolver` |
| `fromResponse`               | `sendResponse`         |
| `fromResponse`               | `send`                 |
