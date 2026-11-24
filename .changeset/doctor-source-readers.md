---
"permdock": patch
---

Doctor checks PD007, PD008, PD010, PD011, PD013, PD036, PD038, PD041 and PD057 read the parsed source, so text in a comment or a string no longer raises or silences them; PD013 reads only the `algorithms` array and PD008 also reads `export { x as dock }`.
