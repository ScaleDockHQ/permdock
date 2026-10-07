"use client";

import type { Permission } from "permdock";

import { Check, X } from "lucide-react";
import { usePermission } from "permdock/react";

import { Badge } from "@/components/ui/badge.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";

import { permissions } from "../../permissions.ts";

const checks: readonly {
  readonly label: string;
  readonly permission: Permission;
}[] = [
  { label: "List quotes", permission: permissions.quote.list },
  { label: "See the member list", permission: permissions.member.list },
  { label: "Change member roles", permission: permissions.member.manage },
];

function Row(props: {
  readonly label: string;
  readonly permission: Permission;
}) {
  const { allowed, status } = usePermission(props.permission);
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">{props.label}</span>
        <code className="text-muted-foreground truncate font-mono text-xs">
          {props.permission.key}
        </code>
      </div>
      {status === "pending" ? (
        <Skeleton className="h-5 w-16 rounded-4xl" />
      ) : allowed ? (
        <Badge className="bg-success/15 text-success-foreground">
          <Check data-icon="inline-start" />
          Allowed
        </Badge>
      ) : (
        <Badge variant="outline" className="text-muted-foreground">
          <X data-icon="inline-start" />
          Denied
        </Badge>
      )}
    </li>
  );
}

export function AccessSummary() {
  return (
    <ul className="flex flex-col divide-y">
      {checks.map((check) => (
        <Row
          key={check.permission.key}
          label={check.label}
          permission={check.permission}
        />
      ))}
    </ul>
  );
}
