---
"permdock": minor
---

The application's own data, `x`, now rides on approval requests, sink events and SCIM resources. It is plain JSON and is never read by a decision.

- `requestApproval(store, decision, { x })` stores it as `ApprovalRequest.x`, and `approval-request-v1.json` lists it.
- `decide(permission, row, { x })` puts it on the decision event. The other event builders (`membershipEvent`, `credentialEvent`, `accessEvent`, `automationEvent`, `supportSessionEvent`, `deliveryEvent`) take `x` too and throw when it is not plain JSON. A decision drops an invalid `x` instead of throwing.
- SCIM Users and Groups carry it in the `urn:ietf:params:scim:schemas:extension:permdock:2.0:AppData` extension (`DirectoryUser.x`, `DirectoryGroup.x`, `APP_DATA_EXTENSION`).

The formats stay `v1`: `x` is optional. The event schemas set `additionalProperties: false`, so each now lists `x`. A consumer that validates events against a copy of an older schema must refresh that copy before events with `x` arrive.
