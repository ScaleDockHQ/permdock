---
"permdock": minor
---

Every event, webhook, problem, route and protocol field now follows its standard: CloudEvents types are `com.permdock.<family>.<operation>`, webhooks are Standard Webhooks over a CloudEvents batch, and the approvals API addresses a request by `id`. Every format keeps `v: 1` because nothing outside the PermDock repositories reads these formats yet.

CloudEvents types:

| Before                                              | After                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `dev.permdock.decision`                             | `com.permdock.decision`                                                                                         |
| `dev.permdock.approval` with `data.phase`           | `com.permdock.approval.requested`, `.resolved`, `.expired`, `.cancelled`                                        |
| `dev.permdock.directory`                            | `com.permdock.directory.created`, `.replaced`, `.patched`, `.deleted`                                           |
| `dev.permdock.membership`                           | `com.permdock.membership.added`, `.removed`, `.changed`                                                         |
| `dev.permdock.credential`                           | `com.permdock.credential.created`, `.used`, `.rotated`, `.revoked`                                              |
| `dev.permdock.catalog`                              | `com.permdock.catalog.published`, `.drifted`                                                                    |
| `dev.permdock.access.started`, `.ended`, `.revoked` | `com.permdock.support-session.started`, `.ended` (`revoked` is `ended` with `data.operation: 'revoked'`)        |
| none                                                | `com.permdock.automation.*` and `com.permdock.delivery.*`, in `RESERVED_CLOUD_EVENT_TYPES`; parsers refuse them |

Events and the envelope:

| Before                                               | After                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `toCloudEvent(event, { source? })`, any `source`     | `source` required and an absolute URI; `dataschema`, `traceparent` and `tracestate` added |
| Decision event `source`; `DecideOptions.source`      | `call`; `DecideOptions.call`                                                              |
| Event `expiresAt` in Unix seconds                    | RFC 3339 date-times                                                                       |
| Event `delegation: { scopes, authorizationDetails }` | `delegation: { scope, authorization_details }`                                            |
| Event `membership` in the internal shape             | The canonical membership `{ scope, id, roles, … }`                                        |

`parseSinkEvent`, `parseSinkEvents`, `parseCloudEventBatch`, `cloudEventType`, `CLOUDEVENTS_CONTENT_TYPE`, `CLOUDEVENTS_BATCH_CONTENT_TYPE`, `EVENT_SCHEMA_IDS`, `SINK_EVENT_SCHEMAS` and the `<FAMILY>_EVENT_SCHEMA` constants are new on `permdock`, with the schemas published at `https://permdock.com/schemas/<family>-event-v1.json`.

Webhooks:

| Before                                                                                | After                                                                                                                                  |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A `vnd.permdock.evidence+jwt` JWS with an `events` claim, posted as `application/jwt` | `webhook-id`, `webhook-timestamp` and `webhook-signature` (`v1a` Ed25519, `v1` HMAC) over an `application/cloudevents-batch+json` body |
| `verifyWebhook(request, { jwks, audience, replay })`                                  | `verifyWebhook(request, { verifier })` or `{ jwks, secret, replay }`                                                                   |
| `verifyWebhook` reasons `unsigned`, `invalid-token`, `invalid-events`, `replayed`     | `unsigned`, `invalid-signature` (with `cause`), `invalid-events`, `replayed`                                                           |

`webhookSigner` and `webhookVerifier` on `permdock/server` sign and verify any body. `signDecisionBatch` keeps the JWS for offline evidence exports.

Approvals HTTP API and the Cloud store:

| Before                                              | After                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /:token`                                       | `GET /:id` with a strong `ETag` and `If-None-Match`; no response carries `token`                       |
| `POST /:token/approve`, `POST /:token/reject`       | `POST /:id/approve`, `POST /:id/reject` with `If-Match` (`412`) and `Idempotency-Key` (`422` on reuse) |
| `signed` in the approve response                    | `GET /:id/signature` as `application/jwt`, linked with `Link: rel="alternate"`                         |
| Lists with `next` only                              | `next` and `Link: rel="next"`                                                                          |
| Cloud `GET /approvals/{token}`                      | `GET /approvals/by-token` with the `PermDock-Approval` header; `GET /approvals/{id}` is new            |
| Cloud `POST /approvals/{token}/resolve`, `/consume` | `POST /approvals/by-token/resolve`, `/by-token/consume` with the `PermDock-Approval` header            |
| `PermDock-Approval: <any string>`                   | One RFC 9651 sf-token; anything else reads as no token, and `approvalHeaders` throws on it             |

`memoryIdempotencyStore`, `IdempotencyStore` and `ApprovalView` are new on `permdock/approvals`.

Problem Details, AuthZEN, SCIM, SSF, OpenTelemetry, OCSF and Web Bot Auth:

| Before                                                                                                               | After                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `type` `…/unauthenticated`, `…/not-found`, `…/method-not-allowed`, `…/conflict`, `…/payload-too-large`, `…/internal` | `about:blank` with the HTTP status title; `PROBLEM_EXAMPLES` on `permdock/testing` holds one body per remaining type                            |
| `…/step-up-required` without a `title`                                                                               | `title: "Step-up required"`                                                                                                                     |
| AuthZEN `context.delegation: { scopes, authorizationDetails }`                                                       | `{ scope, authorization_details }`                                                                                                              |
| AuthZEN `resource.id` always a row                                                                                   | `"*"` names the collection                                                                                                                      |
| AuthZEN results without reasons; `evaluations_semantic` and `X-Request-ID` on `permdock/authzen` only                | `context.reason_admin` and `context.reason_user`; `evaluations_semantic` and the `X-Request-ID` echo on `permdockHandler` too                   |
| SCIM extension `urn:permdock:scim:schemas:extension:roles:1.0`                                                       | `urn:ietf:params:scim:schemas:extension:permdock:2.0:Group`                                                                                     |
| SCIM without versioning; `scimType` on any error                                                                     | `meta.version` and `ETag`, `If-Match` (`412`), `If-None-Match` (`304`); `scimType` on `400` and `409` only                                      |
| SSF handler failure `400` with an `err` body                                                                         | `500` with an empty body; CAEP 1.0's eight events, RISC `account-disabled`, `account-purged`, `credential-compromise` and stream `verification` |
| OTel `permdock.*` attributes only; lists comma-joined                                                                | `user.id`, `user.roles`, `gen_ai.agent.id`, `gen_ai.request.model`, `error.type`; lists as arrays                                               |
| OCSF 1.3.0; `time: 0` for a bad `at`; status `Other` for `approval-required`                                         | OCSF 1.9.0; the event projects to `undefined`; status `Approval Required`                                                                       |
| `accessToOcsf` Account Change (3001), `OcsfAccountChange`                                                            | User Management (3007), `OcsfUserManagement`                                                                                                    |
| Web Bot Auth accepted any RFC 9421 signature                                                                         | `tag="web-bot-auth"`, a covered `@authority`, and a covered `signature-agent` when the header is sent                                           |
