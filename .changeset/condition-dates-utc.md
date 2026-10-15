---
"permdock": patch
---

A condition date compiles the same everywhere. The ORM compilers and generated RLS read `{ date }` with the evaluator's ISO 8601 parser: a date-time without a zone is UTC, and a string that is not ISO 8601 matches no row. Generated SQL writes an explicit UTC literal (`'2026-01-01T00:00:00.000Z'`), so the session `TimeZone` no longer shifts it.
