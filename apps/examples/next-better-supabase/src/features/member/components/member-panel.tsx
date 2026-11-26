"use client";

import { useAssignableRoles } from "permdock/react";

import { Button } from "@/components/ui/button";

import type { MemberRow } from "../member-queries.ts";

import { changeRole, removeMember } from "../member-role.ts";

function MemberRowView(props: {
  readonly organizationId: string;
  readonly member: MemberRow;
  readonly holders: number;
}) {
  const input = {
    organizationId: props.organizationId,
    userId: props.member.userId,
    role: "member",
    holders: props.holders,
  };
  return (
    <li data-member={props.member.userId}>
      {props.member.role}
      <Button
        size="sm"
        onClick={() => {
          void changeRole(input);
        }}
      >
        Make member
      </Button>
      <Button
        size="sm"
        onClick={() => {
          void removeMember(input);
        }}
      >
        Remove
      </Button>
    </li>
  );
}

export function MemberPanel(props: {
  readonly organizationId: string;
  readonly members: readonly MemberRow[];
}) {
  const roles = useAssignableRoles();
  return (
    <>
      <p className="text-sm">
        Assignable: {roles.map((role) => role.key).join(", ")}
      </p>
      <ul data-testid="members">
        {props.members.map((member) => (
          <MemberRowView
            key={member.userId}
            organizationId={props.organizationId}
            member={member}
            holders={props.members.length}
          />
        ))}
      </ul>
    </>
  );
}
