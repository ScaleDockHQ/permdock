import { allow, role } from "permdock";

import { permissions } from "./permissions.ts";

export const finance = role("finance", [allow(permissions.post.publish)]);
