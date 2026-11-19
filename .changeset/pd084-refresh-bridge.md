---
"permdock": patch
---

PD084 reads the doctor sources and is quiet when the app wires the refresh: a call to `nativeRefresh`, or an app bridge that calls `refreshSession()` and refreshes PermDock through `authzChangeRefresh`. Before, it warned for every stream that reads a token claim, even with the refresh in place.
