---
"permdock": minor
---

Decision events carry an optional `model`: the agent model gate (`decideModel`, `permittedModels`) sets it to the model id, and any call can pass it through the new `DecideOptions.model`. `permdock/otel` sets `gen_ai.request.model` from it. The `permdock` entry now also exports `parseCloudEvent` and `parseCatalogEventData` next to `parseSinkEvents` and the event schemas, so a receiver validates events without its own schema.
