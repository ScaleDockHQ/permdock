-- Realtime and Storage create their tables before migrations run. Seeds
-- migrations then create policies that call this helper, which the later
-- inlinable-helpers migration replaces. Without a row here, those policies
-- fail to create on a stack whose services are already up.
create or replace function permdock.permitted_organization_ids_by_permission(p_permission text)
returns setof uuid
language sql
stable
as $$ select null::uuid where false $$;
