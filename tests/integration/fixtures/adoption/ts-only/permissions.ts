import { definePermissions, resource } from "permdock";

export const permissions = definePermissions({
  note: resource({ actions: ["read"] }),
});
