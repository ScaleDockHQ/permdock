---
"permdock": minor
---

`permdock supabase inspect --functions <pattern>` prints, for each function the schema files define that matches the pattern (`public.*_payload`), a pass or every reason it is not shared: its header, a read of the caller, an unknown call, or the `row` table it reads with the rule behind it.
