import { registerHooks } from "node:module";

import { load, resolve } from "./client-reference-loader.ts";

registerHooks({ load, resolve });
