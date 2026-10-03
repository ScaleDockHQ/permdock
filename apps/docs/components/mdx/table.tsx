import type { ComponentProps } from "react";

export function Table(props: ComponentProps<"table">) {
  return (
    <section
      className="relative my-6 prose-no-margin overflow-auto"
      aria-label="Table"
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroll container must be focusable to scroll by keyboard
      tabIndex={0}
    >
      <table {...props} />
    </section>
  );
}
