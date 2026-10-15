---
"permdock": patch
---

A deny whose wire validity window is malformed now stays in force in `fromSnapshot` and in client `where()`. Before, the malformed window read as "never active" for every grant, which skipped the deny and let an allow through.
