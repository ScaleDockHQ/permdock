---
"permdock": patch
---

The bundled Agent Skills are renamed `permdock-wire` and `permdock-audit`, and six skills join them: `permdock`, a general skill that routes to the others, plus `permdock-agents`, `permdock-approvals`, `permdock-tenancy`, `permdock-data` and `permdock-credentials`. `permdock skills install` copies all eight, and `permdock doctor` (PD005) looks for the `permdock` skill.
