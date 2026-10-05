---
"permdock": minor
---

`rls.tenants: 'all'` stops the generated RLS helpers from narrowing to the tenant claim: `permitted_<scope>_ids`, the root `memberOf` (now `in (select member_<scope>_ids())`) and the nested membership `exists` admit every tenant the subject is a member of, for apps whose tenant comes from the URL. The default, `'active'`, keeps the current behaviour: narrow to the tenant claim when the token carries one.
