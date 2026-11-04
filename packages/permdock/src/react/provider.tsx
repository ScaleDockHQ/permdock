import type { ReactElement } from "react";

import type { PermDockProviderProps } from "./types.ts";

import { eagerEvaluator } from "../client/kit.ts";
import { ProviderWith } from "./provider-with.tsx";

export function PermDockProvider(props: PermDockProviderProps): ReactElement {
  return <ProviderWith {...props} evaluator={eagerEvaluator} />;
}
