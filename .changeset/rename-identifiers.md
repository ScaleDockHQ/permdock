---
"permdock": minor
---

Breaking: `subjectFrom*` resolvers take the input first and return `Subject<<Source>Principal>`. In-process defaults are `memory<Interface>`, conformance runners `test<Interface>`, adapted sources `<origin><Interface>`, options take their interface's name, and failure results carry a `cause`. Run `permdock codemod 0.5` for the renames below; the call-shape changes in the second table need a manual edit.

| Old                                                           | New                                 |
| ------------------------------------------------------------- | ----------------------------------- |
| `subjectFromSession`                                          | `subjectFromEve`                    |
| `actorFromSession`                                            | `actorFromEve`                      |
| `CredentialPrincipal`                                         | `ApiKeyPrincipal`                   |
| `LinkPrincipal`                                               | `CapabilityPrincipal`               |
| `SsfSubjectMapper`                                            | `SsfSubjectResolver`                |
| `memorySettings`                                              | `memorySettingsSource`              |
| `memoryRelations`                                             | `memoryRelationSource`              |
| `MemoryRelationsData`                                         | `MemoryRelationSourceData`          |
| `memorySink`                                                  | `memoryDecisionSink`                |
| `MemorySink`                                                  | `MemoryDecisionSink`                |
| `MemorySinkOptions`                                           | `MemoryDecisionSinkOptions`         |
| `memoryApprovalPolicies`                                      | `memoryApprovalPolicySource`        |
| `memoryApprovalDelegations`                                   | `memoryApprovalDelegationSource`    |
| `memoryAccessReviews`                                         | `memoryAccessReviewStore`           |
| `MemoryAccessReviews`                                         | `MemoryAccessReviewStore`           |
| `memoryCredentials`                                           | `memoryCredentialStore`             |
| `MemoryCredentials`                                           | `MemoryCredentialStore`             |
| `memoryStorage`                                               | `memorySnapshotStorage`             |
| `RoleSource`                                                  | `CustomRoleSource`                  |
| `RoleSourceFactory`                                           | `CustomRoleSourceFactory`           |
| `memoryRoleSource`                                            | `memoryCustomRoleSource`            |
| `testRoleSource`                                              | `testCustomRoleSource`              |
| `betterAuthRoleSource`                                        | `betterAuthCustomRoleSource`        |
| `BetterAuthRoleSourceOptions`                                 | `BetterAuthCustomRoleSourceOptions` |
| `PermDockStorage`                                             | `SnapshotStorage`                   |
| `rlsParity`                                                   | `testRlsParity`                     |
| `ormParity`                                                   | `testOrmParity`                     |
| `fromStripeEntitlements`                                      | `stripeEntitlementSource`           |
| `fromTable`                                                   | `tableMembershipSource`             |
| `fromJunction`                                                | `junctionMembershipSource`          |
| `fromSupabasePostgres`                                        | `supabasePostgresQuery`             |
| `verifyWebBotAuth`                                            | `webBotAuthVerifier`                |
| `scimHandler` option `store`                                  | `directory`                         |
| `startAccessReview` option `store`                            | `reviews`                           |
| `approvalsHandler` and `matchDelegation` option `delegations` | `approvalDelegations`               |
| `decide`, `can` and `explain` option `source`                 | `call`                              |
| `LimitDetail` field `window`                                  | `per`                               |
| `testAuthZen`                                                 | `testAuthzen`                       |
| `TestAuthZenOptions`                                          | `TestAuthzenOptions`                |
| `AuthZenVectors`                                              | `AuthzenVectors`                    |
| `AuthZenEvaluationVector`                                     | `AuthzenEvaluationVector`           |
| `AuthZenEvaluationsVector`                                    | `AuthzenEvaluationsVector`          |
| `AuthZenSearchVector`                                         | `AuthzenSearchVector`               |
| `powersyncSource`                                             | `powerSyncSource`                   |
| `summariseSubject`                                            | `summarizeSubject`                  |
| `WebhookFailureReason`                                        | `WebhookFailureCause`               |
| `ApprovalResumeFailure`                                       | `ApprovalResumeFailureCause`        |

| Before                                                                  | After                                                                                         |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `subjectFromApiKey(options)(key, { tenant })`                           | `subjectFromApiKey(key, { ...options, tenant })`                                              |
| `subjectFromBetterAuth(auth, session, options)`                         | `subjectFromBetterAuth(session, { auth, ...options })`                                        |
| `capabilitySubject(capability)` from `permdock`                         | `subjectFromCapability(token, options)` from `permdock/jwt`                                   |
| `credentialSubject(credential, options)` from `permdock`                | `subjectFromApiKey(key, options)` from `permdock/server`                                      |
| `MappedSubject` from `permdock/jwt`                                     | `Subject<JwtPrincipal>`; `subjectFromIntrospection` returns `Subject<IntrospectionPrincipal>` |
| `verifyWebBotAuth(request, options)`                                    | `webBotAuthVerifier(options)(request)`, or `webBotAuth: webBotAuthVerifier(options)`          |
| `verifyWebhook` failure `{ ok: false, reason, cause? }`                 | `{ ok: false, cause }`, where `cause` is a `WebhookFailureCause`                              |
| `inspectApproval` and `consumeApproval` failure `{ ok: false, detail }` | `{ ok: false, cause }`                                                                        |
