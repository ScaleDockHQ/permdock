import { Protected } from "permdock/react";

import { SubmitButton } from "@/components/submit-button.tsx";

import { permissions } from "../../../permissions.ts";
import { changeRole } from "../../actions.ts";

export function RoleButton(props: {
  readonly org: string;
  readonly user: string;
  readonly role: string;
}) {
  const next = props.role === "admin" ? "member" : "admin";
  return (
    <Protected permission={permissions.member.manage}>
      <form action={changeRole}>
        <input type="hidden" name="organization" value={props.org} />
        <input type="hidden" name="user" value={props.user} />
        <input type="hidden" name="role" value={next} />
        <SubmitButton variant="outline" size="sm" data-change-role={props.user}>
          {next === "admin" ? "Make admin" : "Make member"}
        </SubmitButton>
      </form>
    </Protected>
  );
}
