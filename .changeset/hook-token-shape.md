---
"permdock": patch
---

The token hook writes the active tenant claim whenever the user holds a membership in that tenant, also when the budget left it out of `memberships`, and counts `user_role`, the tenant claim and the custom-role version in the budget. With 12 to 500 memberships and 1 to 20 roles each, the default 1024-byte budget gives a whole token of at most 2,154 characters. The `instanceCache` `maxAgeMs` default is 30,000 ms, as the code always had; the docs said 5,000.
