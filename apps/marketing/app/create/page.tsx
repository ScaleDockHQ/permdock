import type { Metadata } from "next";

import { Suspense } from "react";

import {
  CreateBuilder,
  CreateBuilderSkeleton,
} from "@/components/create/builder";
import { JsonLd } from "@/components/site/json-ld";
import { breadcrumbs } from "@/lib/structured-data";
import { Badge } from "@permdock/ui/reui/badge";

export const metadata: Metadata = {
  title: "Create",
  description:
    "Pick an archetype, features, stack and services; get the permissions, policy and wiring as one command for permdock init or shadcn.",
  alternates: { canonical: "/create" },
};

const steps = [
  "Pick what your app needs",
  "Read the generated code",
  "Run one command",
] as const;

export default function CreatePage() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-6 py-12 md:px-8">
      <JsonLd nodes={[breadcrumbs([{ name: "Create", path: "/create" }])]} />
      <header className="flex max-w-3xl flex-col gap-4">
        <Badge variant="info-light" radius="full" className="w-fit">
          Preset builder
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Create your permission layer
        </h1>
        <p className="text-base leading-7 text-muted-foreground">
          The preview is the code you get: your permissions, policy and wiring.
          Every rule stays in the permdock package. The link and the command
          carry the preset.
        </p>
        <ol className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
          {steps.map((step, index) => (
            <li key={step} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex size-5 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground tabular-nums"
              >
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </header>
      {/* The builder reads ?preset= on the client; the shell stays static. */}
      <Suspense fallback={<CreateBuilderSkeleton />}>
        <CreateBuilder />
      </Suspense>
    </div>
  );
}
