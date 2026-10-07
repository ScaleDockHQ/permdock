---
"permdock": patch
---

`permdock rls generate` names graph helpers after the resource's snake_case name, so a camelCase resource such as `chatThread` gets `permitted_chat_thread_ids`, `permdock_link_chat_thread_<link>` and `permdock_closure_chat_thread` instead of failing with "unsafe scope name". Link names are converted the same way. Doctor PD032 now also reports two resources that share one snake_case name. Lowercase resource names generate the same SQL as before.
