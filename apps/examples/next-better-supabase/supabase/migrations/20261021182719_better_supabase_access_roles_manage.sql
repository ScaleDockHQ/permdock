SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION better_supabase.scope_permissions (
  scope text
)
  RETURNS text[]
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select case scope
    when 'audit:revert' then array['audit.revert']::text[]
    when 'audit:view' then array['audit.view']::text[]
    when 'quotes:list' then array['quotes.list']::text[]
    when 'quotes:read' then array['quotes.read']::text[]
    when 'quotes:update' then array['quotes.update']::text[]
    when 'roles:manage' then array['roles.manage']::text[]
    when 'staff:list' then array['staff.list']::text[]
    when 'staff:read' then array['staff.read']::text[]
    else array[scope]
  end
$function$;
