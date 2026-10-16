---
"permdock": patch
---

`permdock/terminal` reads device authorization, token and GitHub Actions OIDC responses through the 1 MiB body cap; a larger response yields no token instead of being buffered whole.
