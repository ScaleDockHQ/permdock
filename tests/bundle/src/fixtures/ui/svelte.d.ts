import type { Component } from "svelte";

declare module "*.svelte" {
  const component: Component<Record<string, unknown>>;
  export default component;
}
