"use client";

import type { ComponentProps, ReactNode } from "react";

import { LoaderCircle } from "lucide-react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button.tsx";

/** A submit button that disables itself and swaps its icon for a spinner while its form's action runs. */
export function SubmitButton(
  props: Omit<ComponentProps<typeof Button>, "type"> & {
    readonly icon?: ReactNode;
  },
) {
  const { icon, children, disabled, ...rest } = props;
  const { pending } = useFormStatus();
  return (
    <Button
      {...rest}
      type="submit"
      disabled={pending || disabled === true}
      aria-busy={pending}
    >
      {pending ? (
        <LoaderCircle data-icon="inline-start" className="animate-spin" />
      ) : (
        icon
      )}
      {children}
    </Button>
  );
}
