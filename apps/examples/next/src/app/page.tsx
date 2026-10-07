import { LogOut } from "lucide-react";

import { Brand } from "@/components/brand.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";

import { Explore } from "./explore.tsx";
import { SignIn } from "./sign-in.tsx";

export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-10 sm:px-6 sm:py-16">
      <header className="flex items-center justify-between">
        <Brand label="Next.js example" />
        <form method="post" action="/api/session">
          <Button type="submit" variant="ghost" size="sm">
            <LogOut data-icon="inline-start" />
            Sign out
          </Button>
        </form>
      </header>
      <main className="flex flex-col gap-10">
        <section className="flex flex-col gap-4">
          <Badge variant="outline">Next.js 16.3 · Cache Components</Badge>
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Permission-gated UI that navigates instantly
          </h1>
          <p className="text-muted-foreground text-base leading-7 text-pretty">
            Sign in as one of the demo people, then move between organizations,
            quotes and the customer portal. Every gated link and button comes
            from a prefetched, private-cached permission snapshot.
          </p>
        </section>
        <SignIn />
        <Explore />
      </main>
    </div>
  );
}
