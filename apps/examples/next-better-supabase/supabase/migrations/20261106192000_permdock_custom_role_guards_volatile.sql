-- The custom-role guards call the volatile grant helpers.

alter function "permdock".permdock_custom_role_beyond(uuid, text, text, text[], text[], text[]) volatile;
alter function "permdock".permdock_custom_role_guard(uuid, text, text, text) volatile;
alter function "permdock".permdock_custom_role_beyond_for(uuid, uuid, text, text, text[], text[], text[]) volatile;
alter function "permdock".permdock_custom_role_guard_for(uuid, uuid, text, text, text) volatile;
