import { initials } from "@/components/brand.tsx";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";

import { sessionUserId } from "../../lib/session.ts";
import { people } from "../../lib/store.ts";

export function AccountSkeleton() {
  return <Skeleton className="size-8 rounded-full" />;
}

export async function Account() {
  const id = await sessionUserId();
  const person = people.find((item) => item.id === id) ?? null;
  if (person === null) {
    return null;
  }
  return (
    <div className="flex items-center gap-2">
      <Avatar>
        <AvatarFallback>{initials(person.name)}</AvatarFallback>
      </Avatar>
      <span className="hidden text-sm font-medium lg:inline">
        {person.name}
      </span>
    </div>
  );
}
