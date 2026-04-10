create extension if not exists pgcrypto;

create table if not exists public.gallery_members (
  email text primary key,
  role text not null check (role in ('owner', 'viewer')),
  created_at timestamptz not null default now()
);

create table if not exists public.gallery_photos (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  caption text not null default '',
  storage_path text not null unique,
  soundtrack_title text not null default '',
  soundtrack_link_url text,
  created_at timestamptz not null default now()
);

alter table public.gallery_photos
  add column if not exists soundtrack_title text not null default '',
  add column if not exists soundtrack_link_url text;

alter table public.gallery_members enable row level security;
alter table public.gallery_photos enable row level security;

create or replace function public.current_gallery_role()
returns text
language sql
stable
as $$
  select gm.role
  from public.gallery_members gm
  where gm.email = lower(auth.jwt() ->> 'email')
  limit 1;
$$;

drop policy if exists "members_can_view_their_own_role" on public.gallery_members;
create policy "members_can_view_their_own_role"
on public.gallery_members
for select
to authenticated
using (email = lower(auth.jwt() ->> 'email'));

drop policy if exists "gallery_members_can_view_photos" on public.gallery_photos;
create policy "gallery_members_can_view_photos"
on public.gallery_photos
for select
to authenticated
using (public.current_gallery_role() in ('owner', 'viewer'));

drop policy if exists "owners_can_insert_photos" on public.gallery_photos;
create policy "owners_can_insert_photos"
on public.gallery_photos
for insert
to authenticated
with check (public.current_gallery_role() = 'owner');

drop policy if exists "owners_can_delete_photos" on public.gallery_photos;
create policy "owners_can_delete_photos"
on public.gallery_photos
for delete
to authenticated
using (public.current_gallery_role() = 'owner');

drop policy if exists "owners_can_update_photos" on public.gallery_photos;
create policy "owners_can_update_photos"
on public.gallery_photos
for update
to authenticated
using (public.current_gallery_role() = 'owner')
with check (public.current_gallery_role() = 'owner');

insert into storage.buckets (id, name, public)
values ('ankita-private-gallery', 'ankita-private-gallery', false)
on conflict (id) do nothing;

drop policy if exists "gallery_members_can_view_storage_objects" on storage.objects;
create policy "gallery_members_can_view_storage_objects"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'ankita-private-gallery'
  and public.current_gallery_role() in ('owner', 'viewer')
);

drop policy if exists "owners_can_upload_storage_objects" on storage.objects;
create policy "owners_can_upload_storage_objects"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'ankita-private-gallery'
  and public.current_gallery_role() = 'owner'
);

drop policy if exists "owners_can_delete_storage_objects" on storage.objects;
create policy "owners_can_delete_storage_objects"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'ankita-private-gallery'
  and public.current_gallery_role() = 'owner'
);

-- Replace these two example emails before running in production.
insert into public.gallery_members (email, role)
values
  ('bantinitmz@gmail.com', 'owner'),
  ('demo22ankita@gmail.com', 'owner'),
  ('kumarbanti007@gmail.com', 'viewer'),
  ('bhagatnitmz@gmail.com', 'viewer')
on conflict (email) do update
set role = excluded.role;
