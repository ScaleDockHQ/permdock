---
"permdock": patch
---

Arazzo `simulate` and `permdock arazzo check` follow the 1.0 and 1.1 specs more closely:

- Documents are validated against the required fields.
- Patch versions are accepted.
- `$sourceDescriptions` forms of `operationId` and `operationPath` select their source.
- `$inputs.*` and `$components.parameters` references resolve.
- Nested workflows take their calling step's parameters as inputs.
- Results are kept per step position, so equal stepIds in nested workflows no longer collide.

`simulate` now emits the one `simulate` audit event its docs describe, with the batch's worst decision and counts.
