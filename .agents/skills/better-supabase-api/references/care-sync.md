# Care apps that sync offline

The care blocks `activities` (progress notes), `observations` (vital signs) and
`medications` (administrations) sync to PowerSync on Expo. They need the roles
access model. The `better-supabase powersync streams` command writes their
sync streams.

Uploads replay through the block functions, not row by row, so the server's
checks apply:

| Local table                  | Route                                 |
| ---------------------------- | ------------------------------------- |
| `activities`                 | `progressNoteRoute(activities, db)`   |
| `activity_subjects`          | `activityLinksRoute()`                |
| `observations`               | `observationRoute(observations, db)`  |
| `medication_administrations` | `medicationAdministrationRoute(meds)` |

```ts
import {
  activityLinksRoute,
  careUploadOutcome,
  createUploadConnector,
  medicationAdministrationRoute,
  observationRoute,
  progressNoteRoute,
} from "better-supabase/powersync";

export const connector = createUploadConnector({
  endpoint,
  supabase,
  classify: careUploadOutcome,
  tables: {
    activities: progressNoteRoute(bsb.activities, powersync),
    activity_subjects: activityLinksRoute(),
    observations: observationRoute(bsb.observations, powersync),
    medication_administrations: medicationAdministrationRoute(bsb.medications),
  },
});
```

- Pass `careUploadOutcome` as `classify`. It maps a clinical conflict (a dose
  someone else recorded first, a missing second checker) to `conflict`, so the
  change lands in `connector.rejected` for the nurse and is never retried or
  dropped quietly.
- Observations are never edited or deleted offline: an amendment is a new
  observation, and a `PATCH` may only mark one as entered in error.
- The server plans scheduled doses. Offline, a nurse marks a planned dose
  `given`, `refused` or `skipped` with a `PATCH`, or adds an as-needed dose
  with a `PUT` that has no `scheduled_at`.
- Decision record: `docs/decisions/0162` in the repository. Runnable example:
  `apps/examples/blocks/src/care-sync.ts`.
