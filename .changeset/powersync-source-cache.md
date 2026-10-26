---
"permdock": minor
---

`permdock/react-native` exports `powerSyncSourceCache(db)`: its `source(options)` answers the same `powerSyncSource` for the same manifest and options, so a component that rebuilds its options on every render keeps one source and one set of `db.watch` subscriptions.
