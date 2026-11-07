-- Lienlink's own tables. PermDock helpers read them; generate does not create them.
create table public.organization_members (
  organization_id uuid not null,
  user_id uuid not null,
  role text not null
);

create table public.team_members (
  team_id uuid not null,
  organization_id uuid not null,
  user_id uuid not null
);

create table public.jobs (
  id uuid primary key,
  "organizationId" uuid not null
);
