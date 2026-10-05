---
"permdock": patch
---

`permdock doctor`, `collect` and `usage` no longer throw on a `for` loop with an empty initialiser (`for (;;)`, `for (; test; )`) or on an array hole in a `snapshot({ include })` list. The PD002 scanner reads every `for`, `for...in`, `for...of` and `for await` form.
