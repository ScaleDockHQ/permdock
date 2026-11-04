---
"permdock": minor
---

Keep the policy vocabulary in `permdock/better-supabase`: `PermDockResolver`, `AuthorizerOptions`, `AuthorizationHooksOptions`, `SupportPolicyOptions`, `SubscriberPolicyOptions` and `AccessReviewApplierOptions` take a `V` that `authorizer`, `authorizationHooks`, `supportPolicy`, `subscriberPolicy` and `accessReviewApplier` infer from `policy`. A `permdockFor` of another vocabulary next to `policy` is now a type error.
