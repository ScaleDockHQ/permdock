# next-better-supabase measurements

Each checkpoint is one build of this sample. `main` is the before record. `after` is the branch head.

## main

Commit 9605cf83c21ff62b0b0c4e219b0cd862a857dbf3, 2026-11-26T09:49:52.959Z, Node v26.13.1.

## native-stack

Commit 005f6dd41d9d55f458339a44ad0fa75e929bc85a, 2026-11-26T10:06:07.804Z, Node v26.13.1.

## interface-kit

Commit faf3e1dfa5640aee9521733bc70b7cf1b93c7d9a, 2026-11-26T10:17:03.831Z, Node v26.13.1.

## after

Commit 3f3e221b0fb96cda57f2a3b9964447919e29c1c7, 2026-11-26T12:13:50.850Z, Node v26.13.1.

### Measurements

0 figures improved, 14 got worse, 11 stayed within spread, at 1,000 quotes.
Largest improvements: none.
Largest regressions: members RSC payload bytes (24636 → 83126); quotes-list RSC payload bytes (24654 → 75014); denied-staff RSC payload bytes (24636 → 43139).

Before is a same-session rebuild of the tooling commit. After is the branch head. The earlier `main` checkpoint stays in the report as a drift check. A lower number is the improvement.

| Route         | Figure             | Before | After | Difference                  |
| ------------- | ------------------ | ------ | ----- | --------------------------- |
| quotes-list   | warm TTFB ms       | 2.2    | 2.9   | within spread               |
| quotes-list   | warm LCP ms        | 40     | 40    | within spread               |
| quotes-list   | warm FCP ms        | 28     | 24    | within spread               |
| quotes-list   | HTML encoded bytes | 9285   | 20105 | +10820 (116.5%)             |
| quotes-list   | RSC payload bytes  | 24654  | 75014 | +50360 (204.3%)             |
| quotes-list   | snapshot bytes     | n/a    | n/a   | n/a                         |
| members       | warm TTFB ms       | 1.7    | 2.3   | +0.5999999999999999 (35.3%) |
| members       | warm LCP ms        | 32     | 40    | within spread               |
| members       | warm FCP ms        | 24     | 24    | within spread               |
| members       | HTML encoded bytes | 9275   | 20496 | +11221 (121.0%)             |
| members       | RSC payload bytes  | 24636  | 83126 | +58490 (237.4%)             |
| members       | snapshot bytes     | n/a    | n/a   | n/a                         |
| denied-staff  | warm TTFB ms       | 1.8    | 2.5   | +0.7 (38.9%)                |
| denied-staff  | warm LCP ms        | 40     | 36    | within spread               |
| denied-staff  | warm FCP ms        | 24     | 20    | within spread               |
| denied-staff  | HTML encoded bytes | 9273   | 16119 | +6846 (73.8%)               |
| denied-staff  | RSC payload bytes  | 24636  | 43139 | +18503 (75.1%)              |
| denied-staff  | snapshot bytes     | n/a    | n/a   | n/a                         |
| unauthorized  | warm TTFB ms       | 1.7    | 2.2   | +0.5000000000000002 (29.4%) |
| unauthorized  | warm LCP ms        | 40     | 40    | within spread               |
| unauthorized  | warm FCP ms        | 24     | 24    | within spread               |
| unauthorized  | HTML encoded bytes | 9285   | 15313 | +6028 (64.9%)               |
| unauthorized  | RSC payload bytes  | 24654  | 40170 | +15516 (62.9%)              |
| unauthorized  | snapshot bytes     | n/a    | n/a   | n/a                         |
| portal-quotes | warm TTFB ms       | 1.7    | 2.3   | +0.5999999999999999 (35.3%) |
| portal-quotes | warm LCP ms        | 24     | 40    | within spread               |
| portal-quotes | warm FCP ms        | 24     | 20    | within spread               |
| portal-quotes | HTML encoded bytes | 7980   | 13198 | +5218 (65.4%)               |
| portal-quotes | RSC payload bytes  | 23502  | 40296 | +16794 (71.5%)              |
| portal-quotes | snapshot bytes     | n/a    | n/a   | n/a                         |

<details>
<summary>100,000 quotes</summary>

| Route         | Figure             | Before | After | Difference                  |
| ------------- | ------------------ | ------ | ----- | --------------------------- |
| quotes-list   | warm TTFB ms       | 1.9    | 3.1   | +1.2000000000000002 (63.2%) |
| quotes-list   | warm LCP ms        | 36     | 336   | +300 (833.3%)               |
| quotes-list   | warm FCP ms        | 24     | 28    | within spread               |
| quotes-list   | HTML encoded bytes | 9285   | 20109 | +10824 (116.6%)             |
| quotes-list   | RSC payload bytes  | 24654  | 75015 | +50361 (204.3%)             |
| quotes-list   | snapshot bytes     | n/a    | n/a   | n/a                         |
| members       | warm TTFB ms       | 1.8    | 2.4   | +0.5999999999999999 (33.3%) |
| members       | warm LCP ms        | 36     | 40    | within spread               |
| members       | warm FCP ms        | 24     | 24    | within spread               |
| members       | HTML encoded bytes | 9273   | 20500 | +11227 (121.1%)             |
| members       | RSC payload bytes  | 24636  | 83126 | +58490 (237.4%)             |
| members       | snapshot bytes     | n/a    | n/a   | n/a                         |
| denied-staff  | warm TTFB ms       | 1.5    | 2.5   | +1 (66.7%)                  |
| denied-staff  | warm LCP ms        | 36     | 36    | within spread               |
| denied-staff  | warm FCP ms        | 20     | 24    | within spread               |
| denied-staff  | HTML encoded bytes | 9276   | 16117 | +6841 (73.7%)               |
| denied-staff  | RSC payload bytes  | 24636  | 43139 | +18503 (75.1%)              |
| denied-staff  | snapshot bytes     | n/a    | n/a   | n/a                         |
| unauthorized  | warm TTFB ms       | 1.8    | 2.3   | within spread               |
| unauthorized  | warm LCP ms        | 36     | 36    | within spread               |
| unauthorized  | warm FCP ms        | 24     | 20    | within spread               |
| unauthorized  | HTML encoded bytes | 9286   | 15309 | +6023 (64.9%)               |
| unauthorized  | RSC payload bytes  | 24654  | 40170 | +15516 (62.9%)              |
| unauthorized  | snapshot bytes     | n/a    | n/a   | n/a                         |
| portal-quotes | warm TTFB ms       | 1.5    | 2.2   | +0.7000000000000002 (46.7%) |
| portal-quotes | warm LCP ms        | 24     | 324   | +300 (1250.0%)              |
| portal-quotes | warm FCP ms        | 24     | 20    | within spread               |
| portal-quotes | HTML encoded bytes | 7977   | 13194 | +5217 (65.4%)               |
| portal-quotes | RSC payload bytes  | 23502  | 40297 | +16795 (71.5%)              |
| portal-quotes | snapshot bytes     | n/a    | n/a   | n/a                         |

</details>

Before commit 9605cf83c, after commit 3f3e221b0fb96cda57f2a3b9964447919e29c1c7. Node v26.13.1 on darwin arm64.

### Pages and the membership scenario

These pages have no before column. The five routes above stay the comparison. Membership rows are the quotes page for a user in 1, 13, 25 or 50 organizations, with 1, 3 or 10 custom roles, or in a suspended organization. The hook stops the membership list at a 1,024 byte budget.

| Route          | Status | Warm TTFB ms | Warm LCP ms | HTML bytes | RSC bytes | Statements | Requests                                             |
| -------------- | ------ | ------------ | ----------- | ---------- | --------- | ---------- | ---------------------------------------------------- |
| quote-detail   | 200    | 2.8          | 332         | 18056      | 62217     | 14         | document 1, prefetch 2, other 30, rsc 44             |
| approvals      | 200    | 2.1          | 360         | 16755      | 58996     | 5          | document 1, prefetch 2, other 29, rsc 41             |
| member-admin   | 200    | 2.1          | 352         | 18665      | 63203     | 5          | document 1, prefetch 2, other 29, rsc 41             |
| settings       | 200    | 2.1          | 56          | 15549      | 56165     | 3          | document 1, prefetch 2, other 17                     |
| access         | 200    | 2            | 44          | 18830      | 64984     | 5          | document 1, prefetch 2, other 30, permdock 1, rsc 41 |
| roles          | 200    | 2.6          | 356         | 17473      | 59576     | 5          | document 1, prefetch 2, other 29, rsc 41             |
| teams          | 200    | 2.6          | 360         | 17055      | 59432     | 5          | document 1, prefetch 2, other 29, rsc 41             |
| billing        | 200    | 2.7          | 328         | 17557      | 62257     | 3          | document 1, prefetch 2, other 29, rsc 42             |
| developers     | 200    | 2.4          | 336         | 18187      | 62484     | 3          | document 1, prefetch 2, other 29, rsc 41             |
| support        | 200    | 3            | 340         | 18287      | 62793     | 3          | document 1, prefetch 2, other 29, rsc 41             |
| automations    | 200    | 2.4          | 356         | 18153      | 62491     | 3          | document 1, prefetch 2, other 29, rsc 41             |
| audit          | 200    | 2.7          | 348         | 17738      | 60271     | 5          | document 1, prefetch 2, other 29, rsc 41             |
| access-reviews | 200    | 3            | 340         | 18298      | 62784     | 3          | document 1, prefetch 2, other 29, rsc 41             |
| saas-orgs-1    | 200    | 3.4          | 40          | 14874      | 38446     | 5          | document 1, prefetch 2, other 19, rsc 5              |
| saas-orgs-13   | 200    | 4            | 40          | 14873      | 38446     | 5          | document 1, prefetch 2, other 19, rsc 5              |
| saas-orgs-25   | 200    | 3.3          | 40          | 14874      | 38446     | 5          | document 1, prefetch 2, other 19, rsc 5              |
| saas-orgs-50   | 200    | 3.6          | 40          | 14875      | 38446     | 5          | document 1, prefetch 2, other 19, rsc 5              |
| saas-roles-1   | 200    | 3.6          | 40          | 14874      | 38446     | 5          | document 1, prefetch 2, other 19, rsc 5              |
| saas-roles-3   | 200    | 3.3          | 40          | 14875      | 38446     | 5          | document 1, prefetch 2, other 19, rsc 5              |
| saas-roles-10  | 200    | 3.4          | 44          | 14873      | 38446     | 5          | document 1, prefetch 2, other 19, rsc 5              |
| saas-suspended | 200    | 2.8          | 40          | 14882      | 38451     | 5          | document 1, prefetch 2, other 19, rsc 5              |

### JWT

Byte lengths of the Supabase access token, its claims, and the session cookie. A null token means sign-in returned no session.

| User      | Token bytes | Claim bytes | Cookie bytes |
| --------- | ----------- | ----------- | ------------ |
| Olivia    | 1284        | 825         | 3163         |
| Carla     | 1194        | 757         | 3051         |
| orgs1     | 902         | 538         | 2656         |
| orgs13    | 1447        | 947         | 3416         |
| orgs25    | 1984        | 1350        | 4132         |
| orgs50    | 2059        | 1406        | 4231         |
| roles1    | 900         | 537         | 2659         |
| roles3    | 991         | 605         | 2780         |
| roles10   | 1310        | 844         | 3237         |
| suspended | 880         | 522         | 2640         |

### Proxy

The after build's proxy bundle is 260 gzip bytes.

Quotes list, 50 probes, at commit f134f0abccb585730d960d6c798548d7c0c06f1a. Wall time is the document response. Proxy time is the `bsb-proxy` server timing.

| Proxy | Wall p50 ms | Wall p95 ms | Proxy p50 ms | Proxy p95 ms | Statements p50 | Gzip bytes |
| ----- | ----------- | ----------- | ------------ | ------------ | -------------- | ---------- |
| on    | 16.7        | 21          | 0.7          | 0.9          | 8              | 259        |
| off   | 16.4        | 24.9        | n/a          | n/a          | 7              | 259        |

Same-session rebuilds with one feature off. `bsb-proxy` is absent when the proxy is off, so that row's proxy timing is n/a. Gzip is the built `proxy.js`.

| Build            | Runs | Proxy p50 ms | Proxy p95 ms | Gzip bytes |
| ---------------- | ---- | ------------ | ------------ | ---------- |
| proxy off        | 0    | n/a          | n/a          | 260        |
| may-access off   | 200  | 0.1          | 0.2          | 260        |
| shared-cache off | 200  | 0.6          | 0.9          | 260        |
| warm off         | 200  | 0.6          | 0.9          | 260        |

Not measured:

- the four-way split matches chunk file names, which do not name source packages
