"use client";

import type { LucideIcon } from "lucide-react";
import type { Permission } from "permdock";

import { cn } from "cn";
import {
  FileText,
  LayoutDashboard,
  LoaderCircle,
  Settings,
  Users,
} from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { Protected } from "permdock/react";
import { use } from "react";

import { Skeleton } from "@/components/ui/skeleton.tsx";

import { permissions } from "../../permissions.ts";

type Item = {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly icon: LucideIcon;
  readonly permission: Permission | null;
  /** Rarely visited: its segment is `prefetch = 'force-disabled'`. */
  readonly prefetch?: false;
};

const items: readonly Item[] = [
  {
    id: "overview",
    label: "Overview",
    path: "",
    icon: LayoutDashboard,
    permission: null,
  },
  {
    id: "quotes",
    label: "Quotes",
    path: "/quotes",
    icon: FileText,
    permission: permissions.quote.list,
  },
  {
    id: "members",
    label: "Members",
    path: "/members",
    icon: Users,
    permission: permissions.member.list,
  },
  {
    id: "settings",
    label: "Settings",
    path: "/settings",
    icon: Settings,
    permission: permissions.member.manage,
    prefetch: false,
  },
];

const listClass = "flex gap-1 overflow-x-auto md:flex-col md:overflow-visible";

export function NavSkeleton() {
  return (
    <nav aria-label="Main" aria-busy="true" data-testid="nav-skeleton">
      <ul className={listClass}>
        {items.map((item) => (
          <li key={item.id} className="shrink-0 px-3 py-2">
            <Skeleton className="h-5 w-24" />
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Shown while a click on a link waits for its route; a prefetched route usually never shows it. */
function Pending() {
  const { pending } = useLinkStatus();
  return pending ? (
    <LoaderCircle
      data-testid="nav-pending"
      className="ml-auto size-3.5 animate-spin"
      aria-hidden="true"
    />
  ) : null;
}

function NavLink(props: {
  readonly item: Item;
  readonly href: string;
  readonly current: boolean;
}) {
  const Icon = props.item.icon;
  return (
    <li className="shrink-0">
      <Link
        href={props.href}
        prefetch={props.item.prefetch ?? true}
        data-nav={props.item.id}
        aria-current={props.current ? "page" : false}
        className={cn(
          "text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          props.current && "bg-muted text-foreground",
        )}
      >
        <Icon className="size-4" aria-hidden="true" />
        {props.item.label}
        <Pending />
      </Link>
    </li>
  );
}

function GatedLink(props: {
  readonly item: Item;
  readonly permission: Permission;
  readonly href: string;
  readonly current: boolean;
}) {
  return (
    <Protected permission={props.permission}>
      <NavLink item={props.item} href={props.href} current={props.current} />
    </Protected>
  );
}

export function Nav(props: { readonly organization: Promise<string> }) {
  const organization = use(props.organization);
  const pathname = usePathname();
  return (
    <nav aria-label="Main" data-testid="nav">
      <ul className={listClass}>
        {items.map((item) => {
          const href = `/${organization}${item.path}`;
          const current =
            item.path === ""
              ? pathname === href
              : pathname === href || pathname.startsWith(`${href}/`);
          return item.permission === null ? (
            <NavLink key={item.id} item={item} href={href} current={current} />
          ) : (
            <GatedLink
              key={item.id}
              item={item}
              permission={item.permission}
              href={href}
              current={current}
            />
          );
        })}
      </ul>
    </nav>
  );
}
