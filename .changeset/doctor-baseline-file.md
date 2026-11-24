---
"permdock": minor
---

BREAKING: `permdock doctor` reads accepted findings from `doctor.baseline`, a JSON file in better-supabase's grouped format `[{ code, reason, targets }]`; an entry without a reason or one that matches no finding is an error, `--update-baseline` rewrites the file, and `doctor.failOn: "warning"` fails on warnings. `doctor.waivers` and `doctor.ignore` are removed, and `permdock codemod 0.32` moves both into the baseline file.
