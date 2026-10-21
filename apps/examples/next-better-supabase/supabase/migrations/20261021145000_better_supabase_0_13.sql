-- better-supabase 0.13.0 audit module: acting_member() is executable by service_role only; the security definer functions and triggers that record an actor call it as their owner.
revoke execute on function better_supabase.acting_member() from public, anon, authenticated;
grant execute on function better_supabase.acting_member() to service_role;
