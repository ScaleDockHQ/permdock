---
'permdock': patch
---

The OCSF projections now match OCSF 1.3.0. `accessToOcsf` uses Account Change activity 2 (Enable) for `started` and 5 (Disable) for `ended` and `revoked`, instead of 1 (Create) and 4 (Password Reset), and sets the required `type_uid`. `toOcsf` always sets the required `user`, as `{ name: 'anonymous' }` for an anonymous subject.
