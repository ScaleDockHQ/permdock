import type { ReactElement } from "react";

import type { PermDockProviderProps } from "./types.ts";

import { lazyEvaluator } from "../client/kit.ts";
import { ProviderWith } from "./provider-with.tsx";

const evaluator = lazyEvaluator();

export function PermDockProvider(props: PermDockProviderProps): ReactElement {
  return <ProviderWith {...props} evaluator={evaluator} />;
}
