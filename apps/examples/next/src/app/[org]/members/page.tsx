import { Lock } from "lucide-react";
import { Protected } from "permdock/react";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.tsx";

import { permissions } from "../../../permissions.ts";
import { MembersSkeleton, Staff } from "./staff.tsx";

export const instant = true;

function Hidden() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Lock />
        </EmptyMedia>
        <EmptyTitle>Members are hidden</EmptyTitle>
        <EmptyDescription>Only staff can see the member list.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export default function Members(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Members"
        description="Staff in this organization. Admins can change a member's role; the change reaches their snapshot on the next render."
      />
      <Protected
        permission={permissions.member.list}
        pending={<MembersSkeleton />}
        fallback={<Hidden />}
      >
        <Suspense fallback={<MembersSkeleton />}>
          <Staff params={props.params} />
        </Suspense>
      </Protected>
    </div>
  );
}
