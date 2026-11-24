---
"permdock": minor
---

`permdock config --print` reports the `effective` config with each default filled in, doctor `PD120` warns about a key set to its default, and `permdock codemod config --prune` removes such keys after proving every generated file stays byte-identical.
