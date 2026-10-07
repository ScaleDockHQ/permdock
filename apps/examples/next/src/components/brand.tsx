import { ShieldCheck } from "lucide-react";
import Link from "next/link";

export function Brand(props: { readonly label: string }) {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold">
      <span className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md">
        <ShieldCheck className="size-4" aria-hidden="true" />
      </span>
      <span>PermDock</span>
      <span className="text-muted-foreground hidden font-normal sm:inline">
        {props.label}
      </span>
    </Link>
  );
}

export function initials(name: string): string {
  return name.slice(0, 1).toUpperCase();
}
