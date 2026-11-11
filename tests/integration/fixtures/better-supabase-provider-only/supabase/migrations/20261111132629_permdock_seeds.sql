-- permdock:seeds v1 schema=permdock
insert into "permdock".role_permissions (role, permission, grant_key, scope, effect) values
  ('owner', 'projects.read', 'projects.read', 'organization', 'allow'),
  ('owner', 'projects.list', 'projects.list', 'organization', 'allow'),
  ('owner', 'projects.update', 'projects.update', 'organization', 'allow'),
  ('owner', 'projects.delete', 'projects.delete', 'organization', 'allow'),
  ('member', 'projects.read', 'projects.read', 'organization', 'allow'),
  ('member', 'projects.list', 'projects.list', 'organization', 'allow'),
  ('platform-admin', 'organizations.manage', 'organizations.manage', 'global', 'allow')
on conflict (role, grant_key, scope) do update
  set permission = excluded.permission, effect = excluded.effect;
delete from "permdock".role_permissions
where (role, grant_key, scope) not in (values
  ('owner', 'projects.read', 'organization'),
  ('owner', 'projects.list', 'organization'),
  ('owner', 'projects.update', 'organization'),
  ('owner', 'projects.delete', 'organization'),
  ('member', 'projects.read', 'organization'),
  ('member', 'projects.list', 'organization'),
  ('platform-admin', 'organizations.manage', 'global')
);
