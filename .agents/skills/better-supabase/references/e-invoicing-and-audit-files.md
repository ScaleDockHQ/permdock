# E-invoicing and audit files

## Send and receive e-invoices

The `invoices` block sends through two ports: an `EInvoiceFormat` (renders the
issued invoice, `peppolBis3Format` ships with the library) and an
`EInvoiceChannel` (an access point; its package owns the credentials and
implements `lookup`).

```ts
await invoices.setEInvoiceEndpoint({
  organizationId,
  partyKind: "company",
  partyId: companyId,
  endpoint: { scheme: "0106", id: "12345678" },
});

await invoices
  .sendEInvoice({ invoice: issued, format: peppolBis3Format, channel })
  .orThrow();

// On a schedule:
await invoices.syncEInvoices({ organizationId, channel }).orThrow();
await invoices.receiveEInvoices({ organizationId, channel }).orThrow();
```

- Sending needs `invoices.send`, an issued invoice and a participant id on the
  buyer's company. Errors: `E_INVOICE_NOT_ISSUED`, `E_INVOICE_NO_RECIPIENT`,
  `E_INVOICE_RECIPIENT_UNREACHABLE`, `E_INVOICE_ALREADY_SENT` (pass `resend`).
- `syncEInvoices` moves pending deliveries to `delivered` or `rejected`.
  `receiveEInvoices` makes purchase bills of the company that owns the sender's
  participant id; documents it can't match stay `unmatched`.
- The delivery log is `e_invoice_deliveries`. Docs:
  `https://bettersupabase.com/docs/concepts/e-invoicing`.

## Audit files (SAF-T)

`better-supabase/audit-files` reads and writes audit files for the books.
`defineAuditFileAdapter` checks one adapter (`apiVersion: 1`, `key`, `format`,
`version`, `parse(source)` that yields records, `export(books)` that yields
chunks). Parsed records reach the ledger through an `AuditImportPort`, which the
`imports` client satisfies with `upsertBatch`. The `accounting` block exports
and imports through the adapter you pass. Docs:
`https://bettersupabase.com/docs/concepts/audit-files`.

## Tax reports

`TaxReportFormat.render(report)` maps the boxes of `tax.prepareReturn` to a
country's return. Start from the template in
`https://bettersupabase.com/docs/extending/write-an-adapter`.
