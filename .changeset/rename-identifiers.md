---
"permdock": minor
---

Breaking: in-process defaults are named `memory<Interface>`. Run `permdock codemod 0.5` for the renames below.

| Old | New |
| --- | --- |
| `memorySettings` | `memorySettingsSource` |
| `memoryRelations` | `memoryRelationSource` |
| `MemoryRelationsData` | `MemoryRelationSourceData` |
| `memorySink` | `memoryDecisionSink` |
| `MemorySink` | `MemoryDecisionSink` |
| `MemorySinkOptions` | `MemoryDecisionSinkOptions` |
| `memoryApprovalPolicies` | `memoryApprovalPolicySource` |
| `memoryApprovalDelegations` | `memoryApprovalDelegationSource` |
| `memoryAccessReviews` | `memoryAccessReviewStore` |
| `MemoryAccessReviews` | `MemoryAccessReviewStore` |
| `memoryCredentials` | `memoryCredentialStore` |
| `MemoryCredentials` | `MemoryCredentialStore` |
| `memoryStorage` | `memorySnapshotStorage` |
