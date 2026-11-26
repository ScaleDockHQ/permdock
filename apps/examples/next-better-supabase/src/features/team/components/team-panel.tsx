"use client";

import { useRoles } from "permdock/react";

import type { TeamRow } from "../team-queries.ts";

export function TeamPanel(props: { readonly teams: readonly TeamRow[] }) {
  const view = useRoles(
    props.teams.length === 0 ? {} : { scope: "team", id: props.teams[0].id },
  );
  return (
    <ul data-testid="teams">
      {props.teams.map((team) => (
        <li key={team.id} data-team={team.id}>
          {team.name}
        </li>
      ))}
      <li data-testid="team-roles">
        {view.roles.map((role) => role.key).join(", ")}
      </li>
    </ul>
  );
}
