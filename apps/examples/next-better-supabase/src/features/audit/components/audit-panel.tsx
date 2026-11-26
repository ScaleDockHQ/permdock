"use client";

import { Button } from "@/components/ui/button";

import type { AuditRow } from "../audit-queries.ts";

import { revertAudit } from "../audit-actions.ts";

export function AuditPanel(props: {
  readonly organizationId: string;
  readonly rows: readonly AuditRow[];
}) {
  return (
    <ul data-testid="audit">
      {props.rows.map((row) => (
        <li key={row.id} data-audit={row.id}>
          {row.action}
          <Button
            size="sm"
            onClick={() => {
              void revertAudit({
                organizationId: props.organizationId,
                entryId: row.id,
              });
            }}
          >
            Revert
          </Button>
        </li>
      ))}
    </ul>
  );
}
