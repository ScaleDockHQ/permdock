---
"permdock": patch
---

`permdock codemod 0.26` names each `rls.actions` entry it drops because it repeats the inferred command, as `rls.actions approve: "update" → inferred`, instead of one `rls.actions → ""` line that read like a no-op. A file whose text a codemod leaves unchanged is no longer reported as changed.
