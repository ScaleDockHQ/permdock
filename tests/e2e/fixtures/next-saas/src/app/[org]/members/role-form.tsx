"use client";

import { Protected } from "permdock/react";
import { useState, useTransition } from "react";

import { permissions, roleNames } from "../../../permissions.ts";
import { changeRole } from "../../actions.ts";

export function RoleForm(props: {
  readonly org: string;
  readonly user: string;
  readonly role: string;
}) {
  const [role, setRole] = useState(props.role);
  const [result, setResult] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Protected
      permission={permissions.member.assignRole}
      fallback={<span>{props.role}</span>}
    >
      <select
        aria-label={`Role for ${props.user}`}
        value={role}
        onChange={(event) => {
          setRole(event.target.value);
        }}
      >
        {[...new Set([...roleNames, props.role])].map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            const outcome = await changeRole(props.org, props.user, role);
            setResult(
              outcome.ok ? "Saved" : `Denied: ${outcome.reason ?? "unknown"}`,
            );
          });
        }}
      >
        Save role
      </button>
      {result === null ? null : <output>{result}</output>}
    </Protected>
  );
}
