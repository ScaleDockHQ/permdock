import { initials } from "@/components/brand.tsx";
import { DataSource } from "@/components/data-source.tsx";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Card, CardFooter } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";

import { getStaff } from "../../../lib/access.ts";
import { people } from "../../../lib/store.ts";
import { RoleButton } from "./role-button.tsx";

type Row = { readonly user: string; readonly role: string };

export function MembersSkeleton() {
  return (
    <Card aria-busy="true" data-testid="members-skeleton" className="py-2">
      <div className="flex flex-col divide-y px-4">
        {["a", "b"].map((row) => (
          <div key={row} className="flex items-center gap-3 py-3">
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-5 w-16 rounded-4xl" />
          </div>
        ))}
      </div>
    </Card>
  );
}

function StaffRow(props: { readonly org: string; readonly row: Row }) {
  const person = people.find((item) => item.id === props.row.user) ?? null;
  const name = person?.name ?? props.row.user;
  return (
    <TableRow>
      <TableCell className="pl-4">
        <div className="flex items-center gap-3">
          <Avatar size="sm">
            <AvatarFallback>{initials(name)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col">
            <span className="font-medium">{name}</span>
            <span className="text-muted-foreground hidden truncate text-xs sm:block">
              {person?.title}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <Badge
          variant={props.row.role === "admin" ? "default" : "secondary"}
          data-role={props.row.user}
        >
          {props.row.role}
        </Badge>
      </TableCell>
      <TableCell className="pr-4 text-right">
        <RoleButton
          org={props.org}
          user={props.row.user}
          role={props.row.role}
        />
      </TableCell>
    </TableRow>
  );
}

export async function Staff(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  const { org } = await props.params;
  const loaded = await getStaff(org);
  return (
    <Card className="py-0">
      <Table data-testid="members">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Member</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="pr-4 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loaded.value.map((row) => (
            <StaffRow key={row.user} org={org} row={row} />
          ))}
        </TableBody>
      </Table>
      <CardFooter className="border-t px-4 py-3">
        <DataSource name="Members" loaded={loaded} />
      </CardFooter>
    </Card>
  );
}
