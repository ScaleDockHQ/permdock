// The slice of React Native Reusables (reactnativereusables.com) the
// -native recipes use, so they type-check here without a React Native
// toolchain. The recipes install against the real components.
declare module "@/components/ui/button" {
  import type { ReactNode } from "react";

  export type ButtonProps = {
    readonly children?: ReactNode;
    readonly disabled?: boolean;
    readonly onPress?: (() => void) | undefined;
    readonly accessibilityHint?: string | undefined;
    readonly variant?:
      | "default"
      | "destructive"
      | "outline"
      | "secondary"
      | "ghost"
      | "link";
    readonly size?: "default" | "sm" | "lg" | "icon";
  };
  export function Button(props: ButtonProps): ReactNode;
}

declare module "@/components/ui/text" {
  import type { ReactNode } from "react";

  export function Text(props: { readonly children?: ReactNode }): ReactNode;
}
