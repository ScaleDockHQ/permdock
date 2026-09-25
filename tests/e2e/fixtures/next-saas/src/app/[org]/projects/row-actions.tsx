'use client';

import { usePermission } from 'permdock/react';
import { useState, useTransition } from 'react';

import type { Project } from '../../../permissions.ts';

import { permissions } from '../../../permissions.ts';
import { deleteProject } from '../../actions.ts';

/**
 * Row actions come from the snapshot's portable conditions (`ownerId`,
 * `archived`), so they render without a request. A closure grant would
 * instead need the server to annotate each row.
 */
export function RowActions(props: { readonly project: Project }) {
  const update = usePermission(permissions.project.update, props.project);
  const remove = usePermission(permissions.project.delete, props.project);
  const [result, setResult] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span>
      {update.allowed ? <button type="button">Edit</button> : null}
      {remove.allowed ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              const outcome = await deleteProject(
                props.project.orgId,
                props.project.id,
              );
              setResult(
                outcome.ok
                  ? 'Deleted'
                  : `Denied: ${outcome.reason ?? 'unknown'}`,
              );
            });
          }}
        >
          Delete
        </button>
      ) : null}
      {result === null ? null : <output>{result}</output>}
    </span>
  );
}
