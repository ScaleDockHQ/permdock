# Ports and adapters

Blocks call ports: small versioned interfaces (`apiVersion: 1`) that your own
package implements. Never import a vendor SDK into a block; write an adapter.

1. Find the port in
   `https://bettersupabase.com/docs/extending/interfaces` (route optimizer,
   bank feed, payroll export format, accounting chart format, tax report
   format, audit file adapter, prescription gateway, clinical decision support,
   vulnerability feed, enrichment provider, mail provider and more).
2. Start from the tested template in
   `https://bettersupabase.com/docs/extending/write-an-adapter`.
3. Run the port's conformance kit from `better-supabase/testing` in your tests.
   A kit throws a `ConformanceError` that lists every failed check.

| Port                      | Kit                           |
| ------------------------- | ----------------------------- |
| `RouteOptimizer`          | `testRouteOptimizer`          |
| `PrescriptionGateway`     | `testPrescriptionGateway`     |
| `ClinicalDecisionSupport` | `testClinicalDecisionSupport` |
| `VulnerabilityFeed`       | `testVulnerabilityFeed`       |
| `FieldPack`               | `testFieldPack`               |

```ts
import { testRouteOptimizer } from "better-supabase/testing";

await testRouteOptimizer(myOptimizer); // every stop once, finite totals
```

Check the port's `apiVersion` with its `*Of(port)` function before you use it:
a breaking change ships a new version, never a silent change.

## Pure renderers

`EInvoiceFormat.render`, `TaxReportFormat.render` and `PayrollExportFormat`
are pure functions of their input. Test them with fixed input and compare the
file. Keep credentials and network calls in a channel or gateway, not a format.
