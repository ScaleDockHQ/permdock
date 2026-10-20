-- The custom roles of rls.fixtures.json, which the custom-role streams join.
insert into "permdock".custom_role_permissions
  (tenant_id, scope, role, permission, effect, level)
values
  ('acme', 'tenant', 'tech', 'job.read', 'allow', 'own'),
  ('acme', 'tenant', 'lead', 'job.read', 'allow', 'team');
