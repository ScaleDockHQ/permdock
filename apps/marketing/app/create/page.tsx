import { Suspense } from "react";

import { CreateBuilder } from "@/components/create/builder";

export const metadata = {
  title: "Create",
  description:
    "Pick an archetype, features, stack and services; get the permissions, policy and wiring as one command for permdock init or shadcn.",
};

export default function CreatePage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-16 md:px-8">
      <div className="mb-10 max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Create
        </h1>
        <p className="mt-3 text-base leading-7 text-muted-foreground">
          Pick what your app needs. The preview is the code you get: your
          permissions, policy and wiring, with every rule left in the permdock
          package. The link and the command carry the preset.
        </p>
      </div>
      {/* The builder reads ?preset= on the client; the shell stays static. */}
      <Suspense>
        <CreateBuilder />
      </Suspense>
    </div>
  );
}
