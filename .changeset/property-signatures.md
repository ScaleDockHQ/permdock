---
"permdock": minor
---

Breaking, types only: the members of the extension interfaces and the other public object types are declared as properties (`get: (token: string) => …`) instead of methods (`get(token: string): …`). TypeScript now checks their parameters contravariantly, so an implementation that declares a narrower parameter type than the interface fails to compile; widen the parameter to the declared type. `Policy`'s `principal`, `subject` and `context`, `ServerPermDock.protectOn`, `OperationData` and `OpenAiRunState` stay methods, so a `Policy<User>` or a `ServerPermDock<V>` is still accepted where the default is.
